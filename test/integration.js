/* End-to-end integration test against the real index.html, driven over CDP.
 * Imports a synthetic overhead photo through the actual file input, then checks
 * the tray, thumbnails, detection, filters and export sizing. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PAGE_JPG = path.join(os.tmpdir(), 'ohs-integration-page.jpg');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:8931';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  c ? pass++ : fail++;
  console.log('  ' + (c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' ' + n + (d !== undefined ? '  ' + d : ''));
};

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  };
  return { ws, send, ready, evaluate };
}

async function newTab(url) {
  const r = await fetch('http://127.0.0.1:9333/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  return r.json();
}

const PROFILE = path.join(os.tmpdir(), 'ohs-int-profile');

(async () => {
  // Start from a clean profile. The app restores its last session from
  // IndexedDB, so a reused profile silently carries pages between runs and the
  // first assertion fails in a way that looks like a code regression.
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=9333', '--user-data-dir=' + PROFILE,
    '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' });

  const finish = (code) => { chrome.kill(); process.exit(code); };
  process.on('uncaughtException', (e) => { console.error(e); finish(1); });

  for (let i = 0; i < 50; i++) { await sleep(300); try { await fetch('http://127.0.0.1:9333/json'); break; } catch (e) {} }

  // ── 1. produce a realistic overhead photo from the browser test's scene ──
  {
    const t = await newTab(ORIGIN + '/test/browser-test.html');
    const c = connect(t.webSocketDebuggerUrl);
    await c.ready;
    let data = '';
    for (let i = 0; i < 40 && !data; i++) {
      await sleep(500);
      data = await c.evaluate("(function(){var c=document.querySelector('#sceneGrid canvas');" +
                              "return c? c.toDataURL('image/jpeg',0.92) : '';})()");
    }
    ok('synthetic capture generated', data.length > 5000, Math.round(data.length / 1024) + ' KB base64');
    fs.writeFileSync(PAGE_JPG, Buffer.from(data.split(',')[1], 'base64'));
    c.ws.close();
    await fetch('http://127.0.0.1:9333/json/close/' + t.id);
  }

  // ── 2. drive the real app ──
  const t = await newTab(ORIGIN + '/index.html');
  const c = connect(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('DOM.enable');
  await c.send('Runtime.enable');

  const errors = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' ' +
        (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ''));
    }
  });

  await sleep(1200);
  ok('app booted with an empty stage',
     await c.evaluate("document.getElementById('viewport').classList.contains('hidden')"));

  // import through the real <input type=file>
  const doc = await c.send('DOM.getDocument');
  const node = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
  await c.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [PAGE_JPG] });
  await c.evaluate("document.getElementById('fileInput').dispatchEvent(new Event('change'))");

  let n = 0;
  for (let i = 0; i < 40 && n === 0; i++) { await sleep(250); n = await c.evaluate('ScannerApp.state.pages.length'); }
  ok('imported image became a page', n === 1, n + ' page(s)');

  await sleep(1400);   // let the thumbnail and stage render settle

  ok('page edges were auto-detected',
     await c.evaluate('!!ScannerApp.state.pages[0].corners'),
     await c.evaluate("JSON.stringify((ScannerApp.state.pages[0].corners||[]).map(p=>[+p.x.toFixed(2),+p.y.toFixed(2)]))"));

  ok('view switched to Edit', await c.evaluate("ScannerApp.state.mode === 'edit'"));

  const thumbLen = await c.evaluate("(ScannerApp.state.pages[0].thumb||'').length");
  ok('thumbnail was generated', thumbLen > 1500, thumbLen + ' chars');
  ok('thumbnail is showing in the tray',
     await c.evaluate("(document.querySelector('.thumb img')||{}).src ? " +
                      "document.querySelector('.thumb img').src.length > 1500 : false"));

  const stage = () => c.evaluate(
    "(function(){var c=document.getElementById('stageCanvas');" +
    "var d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;" +
    "var s=0,mn=255,mx=0;for(var i=0;i<d.length;i+=40){s+=d[i];if(d[i]<mn)mn=d[i];if(d[i]>mx)mx=d[i];}" +
    "return {w:c.width,h:c.height,mean:Math.round(s/(d.length/40)),min:mn,max:mx};})()");

  const autoStage = await stage();
  ok('stage shows a processed page', autoStage.w > 100 && autoStage.h > 100,
     autoStage.w + '×' + autoStage.h);
  ok('Auto filter produced white paper', autoStage.mean > 175 && autoStage.max === 255,
     'mean ' + autoStage.mean + ', max ' + autoStage.max);

  // switch filter through the real button
  await c.evaluate("document.querySelector('.fbtn[data-filter=\"bw\"]').click()");
  await sleep(900);
  const bwStage = await stage();
  const levels = await c.evaluate(
    "(function(){var c=document.getElementById('stageCanvas');" +
    "var d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;var s=new Set();" +
    "for(var i=0;i<d.length;i+=4){s.add(d[i]);if(s.size>4)break;}return s.size;})()");
  ok('Black & white filter applied', levels <= 2, levels + ' distinct levels');
  ok('filter button reflects the change',
     await c.evaluate("document.querySelector('.fbtn[data-filter=\"bw\"]').classList.contains('is-on')"));

  // rotate via keyboard-equivalent button, check output dims swap
  const before = await c.evaluate("(function(){var s=document.getElementById('stageInfo').textContent;return s;})()");
  await c.evaluate("document.getElementById('rotR').click()");
  await sleep(900);
  const rotStage = await stage();
  ok('rotate 90° swapped the stage dimensions',
     Math.abs(rotStage.w - bwStage.h) <= 2 && Math.abs(rotStage.h - bwStage.w) <= 2,
     bwStage.w + '×' + bwStage.h + ' → ' + rotStage.w + '×' + rotStage.h);
  await c.evaluate("document.getElementById('rotL').click()");
  await sleep(700);

  // export sizing through the Measure button
  await c.evaluate("document.querySelector('.tab[data-tab=\"export\"]').click();" +
                   "document.getElementById('btnEstimate').click()");
  let dims = '—';
  for (let i = 0; i < 30 && dims === '—'; i++) { await sleep(300); dims = await c.evaluate("document.getElementById('estDims').textContent"); }
  ok('full-resolution export measured', /\d+×\d+/.test(dims), dims + ' · ' + await c.evaluate("document.getElementById('estSize').textContent"));

  // delete the page
  await c.evaluate("document.querySelector('.thumb .del').click()");
  await sleep(600);
  ok('page deleted and stage cleared',
     (await c.evaluate('ScannerApp.state.pages.length')) === 0 &&
     (await c.evaluate("document.getElementById('viewport').classList.contains('hidden')")));

  /* What the live view shows is what gets cropped. Capture hands addPage the
     outline that was on screen — including "there wasn't one" — and addPage
     must not run its own detection over the top of that decision. Without this
     the preview and the captured page can disagree, which is the hard kind of
     bug to notice: the shot looks fine until you check it against what you saw. */
  const wysiwyg = await c.evaluate(`(async function(){
    function scene(){                       // a page detection will certainly find
      var W=800,H=600,cv=U.canvas(W,H),g=Imaging.ctx2d(cv);
      g.fillStyle='#1a1c20';g.fillRect(0,0,W,H);
      g.save();g.translate(W/2,H/2);g.rotate(0.09);
      g.fillStyle='#f6f5f1';g.fillRect(-250,-190,500,380);
      g.fillStyle='#222';g.font='20px Helvetica, Arial, sans-serif';
      for(var i=0;i<8;i++) g.fillText('a line of text on the page',-210,-140+i*40);
      g.restore();return cv;
    }
    var auto = await ScannerApp.addCanvas(scene(), {inheritAdjust:false});
    var told = await ScannerApp.addCanvas(scene(), {inheritAdjust:false, quad:null});
    var res = { detects: !!auto.corners, honoursNull: told.corners === null };
    // leave the tray as we found it
    ScannerApp.state.pages.length = 0;
    ScannerApp.state.current = -1;
    return JSON.stringify(res);
  })()`);
  const wy = JSON.parse(wysiwyg);
  ok('a page with no stated crop is auto-detected', wy.detects);
  ok('an explicit "no crop" is honoured, not re-detected', wy.honoursNull);

  /* Nothing on screen and nothing exported may come from a re-decoded JPEG.
     The stored blob exists only so a reload can recover the session; encoding
     and immediately decoding again costs a visible generation on exactly the
     hard edges a scanner is for (~42 dB PSNR after the sharpen stage). */
  const psnr = await c.evaluate(`(async function(){
    var W=900,H=640,cv=U.canvas(W,H),g=Imaging.ctx2d(cv);
    g.fillStyle='#fff';g.fillRect(0,0,W,H);
    g.fillStyle='#000';g.font='bold 30px Helvetica, Arial, sans-serif';
    for(var i=0;i<12;i++) g.fillText('Sharp edges 0123456789 |||||||',40,60+i*46);
    g.fillStyle='#c00';g.fillRect(600,420,240,160);
    var page=await ScannerApp.addCanvas(cv,{quad:null,inheritAdjust:false});
    await new Promise(function(r){setTimeout(r,900);});
    var ref=Imaging.pipeline(cv,page.adjust,page.corners,1400);
    var got=Imaging.pipeline(await ScannerApp.sourceFor(page),page.adjust,page.corners,1400);
    if(ref.width!==got.width||ref.height!==got.height) return -1;
    var a=Imaging.ctx2d(ref).getImageData(0,0,ref.width,ref.height).data;
    var b=Imaging.ctx2d(got).getImageData(0,0,got.width,got.height).data;
    var se=0,n=0;
    for(var p=0;p<a.length;p+=4){var d=a[p]-b[p];se+=d*d;n++;}
    var mse=se/n;
    ScannerApp.state.pages.length=0; ScannerApp.state.current=-1;
    return mse===0?99:10*Math.log10(255*255/mse);
  })()`);
  ok('rendered from the pristine frame, not a JPEG of it', psnr > 45,
     psnr < 0 ? 'size mismatch' : psnr.toFixed(1) + ' dB vs the original canvas');

  ok('no uncaught exceptions during the run', errors.length === 0, errors.join(' | ').slice(0, 200));

  console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
  c.ws.close();
  finish(fail ? 1 : 0);
})();
