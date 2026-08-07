/* Camera plumbing test, driven over CDP against Chrome's fake capture device.
 *
 * Headless Chrome hands out a MediaStream but never decodes frames into a
 * <video> (readyState stays HAVE_NOTHING), so anything that reads pixels —
 * capture, page-brightness metering, the crop readout — cannot be exercised
 * here and needs a real camera. What this does cover is the plumbing around
 * those, which is where the bugs have actually been:
 *
 *   - start() completing at all. Every step in it interrogates the driver, and
 *     video.play() and getPhotoCapabilities() can both simply never settle.
 *     That hung camera start completely, with no error to show for it.
 *   - pushing the track to the device's real maximum resolution afterwards,
 *     since `ideal` only asks nicely.
 *   - probing for a larger still, and deciding whether it is worth using.
 *
 *   node test/camera.test.js [origin]
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:8931';
const PROFILE = path.join(os.tmpdir(), 'ohs-cam-profile');
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  c ? pass++ : fail++;
  console.log('  ' + (c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' ' + n + (d !== undefined ? '  ' + d : ''));
};

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--window-size=1440,900',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'],
    { stdio: 'ignore' });
  const finish = (code) => { chrome.kill(); process.exit(code); };
  process.on('uncaughtException', (e) => { console.error(e); finish(1); });

  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try { await fetch('http://127.0.0.1:' + PORT + '/json'); break; } catch (e) {}
  }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' +
    encodeURIComponent(ORIGIN + '/index.html'), { method: 'PUT' })).json();

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' ' +
        ((m.params.exceptionDetails.exception || {}).description || ''));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const cmd = (method, params) => new Promise((r) => {
    const n = ++id; pend.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const ev = async (x) => {
    const r = await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) {
      throw new Error((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text);
    }
    return r.result.result.value;
  };
  await new Promise((r) => ws.addEventListener('open', r));
  await cmd('Runtime.enable');
  await sleep(1500);

  // ── start, and actually complete ──
  const t0 = Date.now();
  await ev("document.getElementById('btnStart').click()");
  let status = '';
  for (let i = 0; i < 60 && status !== 'live'; i++) {
    await sleep(250);
    status = await ev("document.getElementById('camStatus').textContent");
  }
  const startMs = Date.now() - t0;
  // Deliberately not just Camera.running(): the track goes live partway
  // through start(), while the capability probes are still outstanding. Waiting
  // on the UI is what proves start() returned.
  ok('camera start completes (does not hang on a driver probe)', status === 'live', startMs + ' ms');
  ok('start finished promptly', status === 'live' && startMs < 9000, startMs + ' ms');

  // ── resolution ──
  const res = await ev("document.getElementById('resInfo').textContent");
  ok('stream resolution is reported', /^\d+×\d+$/.test(res), res);

  const capMax = await ev(`(function(){
    var c = Camera.track.getCapabilities ? Camera.track.getCapabilities() : {};
    return (c.width && c.width.max) ? c.width.max + '×' + c.height.max : 'unknown';
  })()`);
  ok('track was pushed to the device maximum, not the negotiated default',
     capMax === 'unknown' || res === capMax, 'got ' + res + ', device max ' + capMax);

  // ── still capture ──
  const photo = await ev("JSON.stringify(Camera.photoMax)");
  ok('still-capture capability was probed without hanging', photo !== undefined, photo);
  const consistent = await ev(`(function(){
    var s = Camera.settings(), p = Camera.photoMax, bigger = Camera.photoIsBigger();
    if (!p) return bigger === false;
    return bigger === (p.w * p.h > s.width * s.height * 1.1);
  })()`);
  ok('photoIsBigger() agrees with the numbers', consistent === true,
     'photo ' + photo + ' vs stream ' + res);
  ok('still-capture readout rendered',
     (await ev("document.getElementById('photoInfo').textContent")) !== '—',
     await ev("document.getElementById('photoInfo').textContent"));

  // ── controls must degrade, not throw, on a device without them ──
  const knob = await ev("JSON.stringify(Camera.exposureKnob() && Camera.exposureKnob().key)");
  ok('exposure knob resolves (or is honestly absent)', true, knob);
  await ev("document.getElementById('expAuto').click()");
  await sleep(3500);
  ok('auto-level completes without throwing',
     (await ev("document.getElementById('expAuto').disabled")) === false);
  ok('refocus returns a boolean without throwing',
     typeof (await ev("(async()=>await Camera.refocus())()")) === 'boolean');

  // ── stop cleanly ──
  await ev("document.getElementById('btnStart').click()");
  await sleep(600);
  ok('camera stops cleanly', (await ev("Camera.running()")) === false &&
     (await ev("document.getElementById('camStatus').textContent")) === 'off');

  ok('no uncaught exceptions', errors.length === 0, errors.join(' | ').slice(0, 200));

  console.log('\n  note: capture, metering and the crop readout need a real camera —');
  console.log('        headless Chrome never decodes fake-device frames into a <video>.');
  console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
  ws.close();
  finish(fail ? 1 : 0);
})();
