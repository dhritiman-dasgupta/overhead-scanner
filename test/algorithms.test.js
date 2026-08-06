/* Headless verification of the algorithmic core: homography, warp, page
 * detection, illumination flattening, adaptive threshold, and the PDF writer.
 * Stubs just enough of the DOM (a nearest-neighbour canvas) to run them. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── DOM stubs ──────────────────────────────────────────────────
class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
}
function makeCanvas(w, h) {
  let _w = w, _h = h;
  const cv = {
    _data: new Uint8ClampedArray(w * h * 4),
    getContext() { return ctx; },
    toDataURL() { return 'data:,'; }
  };
  // Real canvases reallocate (and clear) their backing store on resize, and
  // Geom.detect relies on that: createElement('canvas') then set width/height.
  Object.defineProperty(cv, 'width', {
    get: () => _w,
    set: (v) => { _w = v; cv._data = new Uint8ClampedArray(_w * _h * 4); }
  });
  Object.defineProperty(cv, 'height', {
    get: () => _h,
    set: (v) => { _h = v; cv._data = new Uint8ClampedArray(_w * _h * 4); }
  });
  const ctx = {
    canvas: cv, imageSmoothingQuality: 'high', fillStyle: '#fff',
    getImageData(x, y, ww, hh) {
      const out = new ImageData(ww, hh);
      for (let j = 0; j < hh; j++)
        for (let i = 0; i < ww; i++) {
          const s = ((y + j) * cv.width + (x + i)) * 4, d = (j * ww + i) * 4;
          for (let k = 0; k < 4; k++) out.data[d + k] = cv._data[s + k];
        }
      return out;
    },
    putImageData(img, dx, dy) {
      for (let j = 0; j < img.height; j++)
        for (let i = 0; i < img.width; i++) {
          const s = (j * img.width + i) * 4, d = ((dy + j) * cv.width + (dx + i)) * 4;
          for (let k = 0; k < 4; k++) cv._data[d + k] = img.data[s + k];
        }
    },
    drawImage(src, dx, dy, dw, dh) {
      const sw = src.width, sh = src.height, sd = src._data;
      dw = dw === undefined ? sw : dw; dh = dh === undefined ? sh : dh;
      for (let j = 0; j < dh; j++) {
        const sy = Math.min(sh - 1, Math.floor(j * sh / dh));
        for (let i = 0; i < dw; i++) {
          const sx = Math.min(sw - 1, Math.floor(i * sw / dw));
          const s = (sy * sw + sx) * 4, d = ((dy + j) * cv.width + (dx + i)) * 4;
          for (let k = 0; k < 4; k++) cv._data[d + k] = sd[s + k];
        }
      }
    },
    fillRect() {}, translate() {}, rotate() {}, scale() {}
  };
  return cv;
}
global.window = global;
global.ImageData = ImageData;
global.document = { createElement: (t) => (t === 'canvas' ? makeCanvas(1, 1) : {}) };
global.location = { href: 'http://localhost/', protocol: 'http:' };
global.navigator = {};

for (const f of ['util.js', 'geometry.js', 'imaging.js', 'pdf.js']) {
  new Function(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))();
}
// U.canvas must produce a sized fake canvas
U.canvas = (w, h) => makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));

// ── harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── T1 homography ──────────────────────────────────────────────
console.log('\nhomography');
{
  const from = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  const to   = [{x:5,y:5},{x:25,y:7},{x:23,y:30},{x:3,y:26}];
  const H = Geom.homography(from, to);
  const map = (p) => {
    const w = H[6]*p.x + H[7]*p.y + 1;
    return { x: (H[0]*p.x + H[1]*p.y + H[2]) / w, y: (H[3]*p.x + H[4]*p.y + H[5]) / w };
  };
  let worst = 0;
  from.forEach((p, i) => {
    const m = map(p);
    worst = Math.max(worst, Math.hypot(m.x - to[i].x, m.y - to[i].y));
  });
  ok('maps all four control points', worst < 1e-9, 'max err ' + worst.toExponential(1));
  ok('degenerate quad returns null', Geom.homography(from, [{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}]) === null);
}

// ── synthetic scene: a patterned page seen at an angle on a dark desk ──
const SW = 640, SH = 480;
const TRUE_QUAD = [ {x:0.18,y:0.12}, {x:0.86,y:0.20}, {x:0.79,y:0.90}, {x:0.11,y:0.78} ];

/** pattern(u,v) in page space -> [r,g,b]; four quadrants + a dark bar */
function pattern(u, v) {
  if (v > 0.45 && v < 0.55) return [30, 30, 30];              // a text-like bar
  if (u < 0.5 && v < 0.5) return [240, 240, 240];
  if (u >= 0.5 && v < 0.5) return [200, 60, 60];
  if (u < 0.5 && v >= 0.5) return [60, 200, 60];
  return [60, 60, 200];
}

/** A realistic page: white paper, bands of text, and a photo block. */
function document_(u, v) {
  if (u > 0.55 && u < 0.92 && v > 0.60 && v < 0.85) return [95, 88, 80];   // photo block
  const band = (v * 42) % 1;
  if (band < 0.4 && u > 0.08 && u < 0.9) return [38, 38, 40];              // a line of type
  return [246, 245, 242];
}

function buildScene(illumGradient, paint) {
  const src = makeCanvas(SW, SH);
  const d = src._data;
  const quadPx = TRUE_QUAD.map(c => ({ x: c.x * SW, y: c.y * SH }));
  const Hinv = Geom.homography(quadPx, [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const p = (y * SW + x) * 4;
      const w = Hinv[6]*(x+0.5) + Hinv[7]*(y+0.5) + 1;
      const u = (Hinv[0]*(x+0.5) + Hinv[1]*(y+0.5) + Hinv[2]) / w;
      const v = (Hinv[3]*(x+0.5) + Hinv[4]*(y+0.5) + Hinv[5]) / w;
      let rgb;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) rgb = (paint || pattern)(u, v);
      else rgb = [22, 24, 26];                                 // dark desk
      let k = 1;
      if (illumGradient) k = 0.34 + 0.66 * (x / SW);            // one lamp on the right
      d[p] = rgb[0]*k; d[p+1] = rgb[1]*k; d[p+2] = rgb[2]*k; d[p+3] = 255;
    }
  }
  return src;
}

// ── T2 warp ────────────────────────────────────────────────────
console.log('\nperspective warp');
{
  const src = buildScene(false);
  const img = src.getContext().getImageData(0, 0, SW, SH);
  const out = Geom.warp(img, TRUE_QUAD, 300, 400);
  const at = (u, v) => {
    const x = Math.round(u * 300), y = Math.round(v * 400);
    const p = (y * 300 + x) * 4;
    return [out.data[p], out.data[p+1], out.data[p+2]];
  };
  const check = (u, v, want, label) => {
    const got = at(u, v);
    const err = Math.max(Math.abs(got[0]-want[0]), Math.abs(got[1]-want[1]), Math.abs(got[2]-want[2]));
    ok('quadrant ' + label + ' recovered', err <= 12, 'got [' + got.map(Math.round) + '] want [' + want + ']');
  };
  check(0.25, 0.20, [240,240,240], 'TL');
  check(0.75, 0.20, [200,60,60],   'TR');
  check(0.25, 0.80, [60,200,60],   'BL');
  check(0.75, 0.80, [60,60,200],   'BR');
  const bar = at(0.5, 0.5);
  ok('dark bar lands at v=0.5', bar[0] < 70, 'luma ' + Math.round(bar[0]));
  ok('output dimensions honoured', out.width === 300 && out.height === 400);
}

// ── T3 detection ───────────────────────────────────────────────
console.log('\npage detection');
{
  const check = (label, scene) => {
    const found = Geom.detect(scene);
    ok(label + ': found a quad', !!found);
    if (!found) return;
    let worst = 0, which = -1;
    found.forEach((p, i) => {
      const d = Math.hypot((p.x - TRUE_QUAD[i].x) * SW, (p.y - TRUE_QUAD[i].y) * SH);
      if (d > worst) { worst = d; which = i; }
    });
    ok(label + ': corners within 2% of the long edge', worst < SW * 0.02,
       'worst ' + worst.toFixed(1) + 'px at corner ' + which);
    ok(label + ': corner order is TL,TR,BR,BL',
       found[0].x < found[1].x && found[3].x < found[2].x && found[0].y < found[3].y);
  };
  check('plain page', buildScene(false, () => [246, 245, 242]));
  check('page of text', buildScene(false, document_));
  check('text + side lamp', buildScene(true, document_));
  // a frame with no page in it must not invent one
  const blank = makeCanvas(200, 150);
  for (let i = 0; i < blank._data.length; i += 4) {
    const n = 120 + ((i / 4) % 7);
    blank._data[i] = blank._data[i+1] = blank._data[i+2] = n; blank._data[i+3] = 255;
  }
  ok('flat frame yields no false quad', Geom.detect(blank) === null);
}

// ── T4 illumination flattening ─────────────────────────────────
console.log('\nillumination flattening');
{
  // white paper with dark text, lit from the right: 0.34x on the left edge
  const w = 400, h = 300;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const isText = (y % 24) < 6 && x > 20 && x < w - 20;
      const base = isText ? 35 : 250;
      const k = 0.34 + 0.66 * (x / w);
      img.data[p] = img.data[p+1] = img.data[p+2] = base * k;
      img.data[p+3] = 255;
    }
  }
  const before = { l: img.data[(14*w+10)*4], r: img.data[(14*w+w-10)*4] };
  const pristine = new ImageData(w, h); pristine.data.set(img.data);
  const run = (over) => {
    const c = new ImageData(w, h); c.data.set(pristine.data);
    Imaging.color(c, Object.assign(Imaging.newAdjust(), Imaging.FILTERS.auto,
                                   { sharpen: 0, denoise: 0 }, over || {}));
    return { px: (x, y) => c.data[(y * w + x) * 4] };
  };
  ok('gradient existed before', before.r - before.l > 100,
     before.l + ' → ' + before.r + ' (delta ' + (before.r - before.l) + ')');

  // flattening on its own — the tone stage is disabled so we measure the divide
  const flat = run({ contrast: 0 });
  const fl = flat.px(10, 14), fr = flat.px(w - 10, 14);   // row 14 sits between text bands
  ok('flatten alone lifts both edges to near-paper', fl > 215 && fr > 215, 'L=' + fl + ' R=' + fr);
  ok('flatten alone removes >85% of the gradient',
     Math.abs(fr - fl) < (before.r - before.l) * 0.15,
     'delta ' + Math.abs(fr - fl) + ' of ' + (before.r - before.l));

  // the delivered Auto filter, tone stage included
  const auto = run();
  const paperL = auto.px(10, 14), paperR = auto.px(w - 10, 14);
  const textL = auto.px(60, 2), textR = auto.px(w - 60, 2);
  ok('Auto: left paper is white',  paperL > 248, 'L=' + paperL);
  ok('Auto: right paper is white', paperR > 248, 'R=' + paperR);
  ok('Auto: background is uniform', Math.abs(paperR - paperL) < 6, 'delta ' + Math.abs(paperR - paperL));

  // the strength slider must actually scale the correction
  const half = run({ contrast: 0, flatten: 50 });
  const hl = half.px(10, 14);
  ok('strength slider scales the correction', hl < fl - 20 && hl > before.l + 30,
     'L=' + hl + ' vs full ' + fl + ' vs raw ' + before.l);
  ok('text stays dark on both sides', textL < 130 && textR < 130, 'L=' + textL + ' R=' + textR);
}

// ── T5 adaptive threshold ──────────────────────────────────────
console.log('\nadaptive threshold (B&W)');
{
  const w = 320, h = 240;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const isText = (y % 20) < 5 && x > 15 && x < w - 15;
      const k = 0.30 + 0.70 * (x / w);
      img.data[p] = img.data[p+1] = img.data[p+2] = (isText ? 45 : 245) * k;
      img.data[p+3] = 255;
    }
  const a = Object.assign(Imaging.newAdjust(), Imaging.FILTERS.bw, { sharpen: 0, denoise: 0 });
  Imaging.color(img, a);
  let bad = 0, textPx = 0, paperPx = 0, nonBinary = 0;
  for (let y = 0; y < h; y++)
    for (let x = 20; x < w - 20; x++) {
      const v = img.data[(y * w + x) * 4];
      if (v !== 0 && v !== 255) nonBinary++;
      const isText = (y % 20) < 5;
      // ignore the 1px anti-aliasing rows at each band edge
      const edge = (y % 20) === 4 || (y % 20) === 5 || (y % 20) === 0;
      if (isText) { textPx++; if (v !== 0 && !edge) bad++; }
      else { paperPx++; if (v !== 255 && !edge) bad++; }
    }
  ok('output is strictly bilevel', nonBinary === 0, nonBinary + ' grey pixels');
  ok('text/paper classified through the gradient', bad / (textPx + paperPx) < 0.02,
     (100 * bad / (textPx + paperPx)).toFixed(2) + '% misclassified');
}

// ── T6 full pipeline ───────────────────────────────────────────
console.log('\npipeline (warp + colour together)');
{
  const src = buildScene(true);
  const adj = Object.assign(Imaging.newAdjust(), { filter: 'auto', mode: 'color' });
  const out = Imaging.pipeline(src, adj, TRUE_QUAD, Infinity);
  const size = Geom.outputSize(TRUE_QUAD, SW, SH);
  ok('output sized from the quad', out.width === size.w && out.height === size.h,
     out.width + '×' + out.height);
  const sample = (canvas, u, v) => {
    const p = ((Math.round(v * (canvas.height - 1))) * canvas.width + Math.round(u * (canvas.width - 1))) * 4;
    return [canvas._data[p], canvas._data[p+1], canvas._data[p+2]];
  };
  const at = (u, v) => sample(out, u, v);
  const tl = at(0.25, 0.2), tr = at(0.75, 0.2), bl = at(0.25, 0.8), br = at(0.75, 0.8);
  ok('white quadrant is near-white despite the lamp gradient', tl[0] > 220 && tl[1] > 220 && tl[2] > 220, '[' + tl.map(Math.round) + ']');
  // Four saturated quadrants with no paper anywhere is a worst case for any
  // background estimator; all we can fairly demand is that hue survives.
  ok('red quadrant is still reddest',   tr[0] > tr[1] && tr[0] > tr[2], '[' + tr.map(Math.round) + ']');
  ok('green quadrant is still greenest', bl[1] > bl[0] && bl[1] > bl[2], '[' + bl.map(Math.round) + ']');
  ok('blue quadrant is still bluest',   br[2] > br[0] && br[2] > br[1], '[' + br.map(Math.round) + ']');

  // The realistic case: a colour photo surrounded by paper, under a side lamp.
  const photo = (u, v) => {
    if (u > 0.55 && u < 0.85 && v > 0.25 && v < 0.50) return [188, 66, 58];   // a red photo
    const band = (v * 42) % 1;
    if (band < 0.4 && u > 0.08 && u < 0.5) return [38, 38, 40];
    return [246, 245, 242];
  };
  const doc = Imaging.pipeline(buildScene(true, photo), Imaging.newAdjust(), TRUE_QUAD, Infinity);
  const paper = sample(doc, 0.03, 0.03), red = sample(doc, 0.70, 0.375);
  ok('document: paper is white', paper[0] > 245 && paper[1] > 245 && paper[2] > 245, '[' + paper.map(Math.round) + ']');
  ok('document: photo keeps its colour', red[0] > red[1] + 60 && red[0] > red[2] + 60, '[' + red.map(Math.round) + ']');
  // Text bands are ~3px in the output, so scan the block rather than point-sample.
  let darkest = 255, lightest = 0;
  for (let y = Math.round(0.40 * doc.height); y < Math.round(0.60 * doc.height); y++) {
    for (let x = Math.round(0.12 * doc.width); x < Math.round(0.45 * doc.width); x++) {
      const v = doc._data[(y * doc.width + x) * 4];
      if (v < darkest) darkest = v;
      if (v > lightest) lightest = v;
    }
  }
  ok('document: ink stays dark', darkest < 110, 'darkest ' + darkest);
  ok('document: text block still has paper between the lines', lightest > 245, 'lightest ' + lightest);

  // A4 follows the source orientation: this quad is wider than it is tall.
  const sized = Imaging.targetSize({ outSize: 'a4' }, TRUE_QUAD, SW, SH, Infinity);
  ok('A4 preset gives 300dpi landscape for a landscape quad',
     sized.w === 3508 && sized.h === 2480, sized.w + '×' + sized.h);
  const tallQuad = [{x:0.3,y:0.05},{x:0.7,y:0.05},{x:0.7,y:0.95},{x:0.3,y:0.95}];
  const portrait = Imaging.targetSize({ outSize: 'a4' }, tallQuad, SW, SH, Infinity);
  ok('A4 preset gives 300dpi portrait for a portrait quad',
     portrait.w === 2480 && portrait.h === 3508, portrait.w + '×' + portrait.h);
  const letter = Imaging.targetSize({ outSize: 'letter' }, tallQuad, SW, SH, Infinity);
  ok('Letter preset is 2550×3300', letter.w === 2550 && letter.h === 3300, letter.w + '×' + letter.h);
  const capped = Imaging.targetSize({ outSize: 'a4' }, TRUE_QUAD, SW, SH, 1000);
  ok('maxDim caps the preview render', Math.max(capped.w, capped.h) === 1000, capped.w + '×' + capped.h);
}

// ── T7 PDF writer ──────────────────────────────────────────────
console.log('\nPDF writer');
{
  const jpeg = new Uint8Array([0xFF,0xD8,0xFF,0xE0,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,0xFF,0xD9]);
  const words = [
    { text: 'Hello', x0: 10, y0: 20, x1: 90, y1: 48 },
    { text: 'world (2)', x0: 100, y0: 20, x1: 250, y1: 48 },
    { text: 'småll', x0: 10, y0: 60, x1: 60, y1: 80 }
  ];
  const blob = PDF.build(
    [{ jpeg, width: 600, height: 800, words }, { jpeg, width: 800, height: 600 }],
    { pageSize: 'a4', title: 'Test (scan)', searchable: true }
  );
  return blob.arrayBuffer().then((ab) => {
    const bytes = new Uint8Array(ab);
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);

    ok('starts with a PDF header', s.startsWith('%PDF-1.4'));
    ok('ends with EOF', s.trimEnd().endsWith('%%EOF'));
    ok('declares 2 pages', /\/Type \/Pages \/Count 2/.test(s));
    ok('embeds both images as DCTDecode', (s.match(/\/Filter \/DCTDecode/g) || []).length === 2);
    ok('page 1 is A4 portrait', /MediaBox \[0 0 595\.28 841\.89\]/.test(s));
    ok('page 2 is A4 landscape', /MediaBox \[0 0 841\.89 595\.28\]/.test(s));
    ok('text layer is invisible (Tr 3)', /\n3 Tr\n/.test(s));
    ok('words are written', s.includes('(Hello) Tj'));
    ok('parens in words are escaped', s.includes('(world \\(2\\)) Tj'));
    ok('page without OCR has no text layer', (s.match(/BT\n3 Tr/g) || []).length === 1);

    // xref offsets must actually point at their objects
    const m = s.match(/startxref\n(\d+)/);
    ok('startxref present', !!m);
    const xrefPos = parseInt(m[1], 10);
    ok('startxref points at the xref keyword', s.slice(xrefPos, xrefPos + 4) === 'xref');
    // table[0]='xref', table[1]='0 N', table[2]=free entry for object 0,
    // so object n's entry lives at table[2 + n].
    const table = s.slice(xrefPos).split('\n');
    const nObjs = parseInt(table[1].split(' ')[1], 10) - 1;
    let bads = 0;
    for (let n = 1; n <= nObjs; n++) {
      const off = parseInt(table[2 + n].slice(0, 10), 10);
      if (!s.startsWith(n + ' 0 obj', off)) bads++;
    }
    ok('every xref offset resolves to its object', bads === 0, nObjs + ' objects, ' + bads + ' bad');

    console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
    process.exit(fail ? 1 : 0);
  });
}
