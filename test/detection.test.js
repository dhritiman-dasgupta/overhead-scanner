/* Page-detection test bench.
 *
 * Synthesises the desk setups an overhead rig actually meets — dark mat, wooden
 * desk, white-on-white, side lamp, clipped page, a hand in shot — and checks
 * both that the page is found and that it is found accurately. Also checks the
 * cases where detection must decline rather than invent a crop.
 *
 *   node test/detection.test.js          run everything
 *   node test/detection.test.js --ppm    also dump each scene to /tmp for eyeballing
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DUMP = process.argv.indexOf('--ppm') >= 0;

/* ── DOM stubs ─────────────────────────────────────────────────── */
class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
}
function makeCanvas(w, h) {
  let _w = w, _h = h;
  const cv = { _data: new Uint8ClampedArray(w * h * 4), getContext: () => ctx, toDataURL: () => 'data:,' };
  const realloc = () => { cv._data = new Uint8ClampedArray(Math.max(1, _w * _h) * 4); };
  Object.defineProperty(cv, 'width',  { get: () => _w, set: (v) => { _w = v; realloc(); } });
  Object.defineProperty(cv, 'height', { get: () => _h, set: (v) => { _h = v; realloc(); } });
  const ctx = {
    canvas: cv, imageSmoothingQuality: 'high', fillStyle: '#fff',
    getImageData(x, y, ww, hh) {
      const out = new ImageData(ww, hh);
      for (let j = 0; j < hh; j++) for (let i = 0; i < ww; i++) {
        const s = ((y + j) * _w + (x + i)) * 4, d = (j * ww + i) * 4;
        for (let k = 0; k < 4; k++) out.data[d + k] = cv._data[s + k];
      }
      return out;
    },
    putImageData(img, dx, dy) {
      for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
        const s = (j * img.width + i) * 4, d = ((dy + j) * _w + (dx + i)) * 4;
        for (let k = 0; k < 4; k++) cv._data[d + k] = img.data[s + k];
      }
    },
    /* Area-averaged downscale — a nearest-neighbour stub would hand the
       detector aliased edges it would never see in a browser. */
    drawImage(src, dx, dy, dw, dh) {
      const sw = src.width, sh = src.height, sd = src._data;
      dw = dw === undefined ? sw : dw; dh = dh === undefined ? sh : dh;
      const rx = sw / dw, ry = sh / dh;
      for (let j = 0; j < dh; j++) {
        const y0 = Math.floor(j * ry), y1 = Math.max(y0 + 1, Math.floor((j + 1) * ry));
        for (let i = 0; i < dw; i++) {
          const x0 = Math.floor(i * rx), x1 = Math.max(x0 + 1, Math.floor((i + 1) * rx));
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = y0; y < y1 && y < sh; y++) for (let x = x0; x < x1 && x < sw; x++) {
            const s = (y * sw + x) * 4; r += sd[s]; g += sd[s + 1]; b += sd[s + 2]; n++;
          }
          const d = ((dy + j) * _w + (dx + i)) * 4;
          cv._data[d] = r / n; cv._data[d + 1] = g / n; cv._data[d + 2] = b / n; cv._data[d + 3] = 255;
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
for (const f of ['util.js', 'geometry.js']) new Function(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))();
U.canvas = (w, h) => makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));

/* ── scene synthesis ───────────────────────────────────────────── */
const SW = 960, SH = 720;

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const mix = (a, b, t) => a + (b - a) * t;

/**
 * Composite a page quad onto a desk. Models the things that decide whether
 * detection works: a soft edge ramp, the shadow paper casts, desk texture, and
 * an illumination gradient.
 */
function scene(o) {
  const quad = o.quad;
  const cv = makeCanvas(SW, SH);
  const d = cv._data;
  const quadPx = quad.map((q) => ({ x: q.x * SW, y: q.y * SH }));
  const H = Geom.homography(quadPx, [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]);
  // page-space unit -> pixels, for turning a normalised distance into a ramp
  const pageW = Math.hypot(quadPx[1].x - quadPx[0].x, quadPx[1].y - quadPx[0].y);
  const pageH = Math.hypot(quadPx[3].x - quadPx[0].x, quadPx[3].y - quadPx[0].y);

  const desk = o.desk || [26, 27, 30];
  const paper = o.paper || [246, 245, 241];
  const ramp = o.ramp === undefined ? 1.3 : o.ramp;         // px of soft edge
  const shadow = o.shadow === undefined ? 0.30 : o.shadow;  // 0..1 darkening
  const shadowW = o.shadowW === undefined ? 5 : o.shadowW;  // px

  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const p = (y * SW + x) * 4;
      const wgt = H[6]*(x+.5) + H[7]*(y+.5) + 1;
      const u = (H[0]*(x+.5) + H[1]*(y+.5) + H[2]) / wgt;
      const v = (H[3]*(x+.5) + H[4]*(y+.5) + H[5]) / wgt;

      // signed distance to the page edge, in pixels (negative = inside)
      const dxOut = Math.max(-u, u - 1) * pageW;
      const dyOut = Math.max(-v, v - 1) * pageH;
      const sd = Math.max(dxOut, dyOut);

      let col;
      let deskCol = desk.slice();
      if (o.texture) {
        const t = o.texture(x, y);
        deskCol = [deskCol[0] + t[0], deskCol[1] + t[1], deskCol[2] + t[2]];
      }
      if (sd > 0 && sd < shadowW && shadow > 0) {
        const k = 1 - shadow * (1 - sd / shadowW);
        deskCol = deskCol.map((c) => c * k);
      }
      if (sd < -ramp) {
        col = o.content ? o.content(u, v) : paper;
      } else if (sd > ramp) {
        col = deskCol;
      } else {
        const t = smooth((sd + ramp) / (2 * ramp));
        const inner = o.content ? o.content(u, v) : paper;
        col = [mix(inner[0], deskCol[0], t), mix(inner[1], deskCol[1], t), mix(inner[2], deskCol[2], t)];
      }

      let k = 1;
      if (o.light) k = o.light(x / SW, y / SH);
      const noise = o.noise ? (((x * 7 + y * 13) % 11) - 5) * o.noise : 0;
      d[p]     = Math.max(0, Math.min(255, col[0] * k + noise));
      d[p + 1] = Math.max(0, Math.min(255, col[1] * k + noise));
      d[p + 2] = Math.max(0, Math.min(255, col[2] * k + noise));
      d[p + 3] = 255;
    }
  }
  if (o.occluder) o.occluder(d, SW, SH);
  return cv;
}

/* page content generators */
const textPage = (base) => (u, v) => {
  if (u > 0.55 && u < 0.9 && v > 0.62 && v < 0.86) return [92, 86, 78];   // a photo block
  const band = (v * 40) % 1;
  if (band < 0.42 && u > 0.08 && u < 0.9) return [40, 40, 44];            // a line of type
  return base || [246, 245, 241];
};
const plain = (base) => () => base || [246, 245, 241];

/* lighting */
const evenLight = null;
const sideLamp = (x, y) => 0.34 + 0.66 / (1 + 2.6 * ((x - 1) * (x - 1) + y * y * 0.4));
const dimAll = () => 0.42;

/* desk textures */
const woodGrain = (x, y) => {
  const g = Math.sin(y * 0.13 + Math.sin(x * 0.02) * 3) * 9 + Math.sin(y * 0.7) * 4;
  return [g, g * 0.7, g * 0.4];
};

const QUAD = [{x:0.19,y:0.13},{x:0.84,y:0.19},{x:0.78,y:0.90},{x:0.12,y:0.80}];

/* ── harness ───────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const rows = [];

function dumpPPM(name, cv) {
  const head = Buffer.from('P6\n' + SW + ' ' + SH + '\n255\n', 'ascii');
  const body = Buffer.alloc(SW * SH * 3);
  for (let i = 0, j = 0; i < SW * SH * 4; i += 4, j += 3) {
    body[j] = cv._data[i]; body[j+1] = cv._data[i+1]; body[j+2] = cv._data[i+2];
  }
  fs.writeFileSync('/tmp/ohs-scene-' + name.replace(/\W+/g, '-') + '.ppm', Buffer.concat([head, body]));
}

function check(name, opts, expect) {
  const cv = scene(opts);
  if (DUMP) dumpPPM(name, cv);
  const t0 = process.hrtime.bigint();
  const got = Geom.detect(cv);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const diag = Geom.lastDetection || {};

  let okFlag, detail;
  if (expect === null) {
    okFlag = got === null;
    detail = got === null ? 'declined' : 'FALSE POSITIVE via ' + diag.best +
             ' (score ' + (diag.score || 0).toFixed(2) + ')';
  } else {
    const truth = expect === true ? (opts.quad || QUAD) : expect;
    if (!got) { okFlag = false; detail = 'not found — best score ' + (diag.score || 0).toFixed(2); }
    else {
      let worst = 0;
      got.forEach((p, i) => {
        worst = Math.max(worst, Math.hypot((p.x - truth[i].x) * SW, (p.y - truth[i].y) * SH));
      });
      const tol = opts.tol === undefined ? 0.02 : opts.tol;
      okFlag = worst <= SW * tol;
      detail = worst.toFixed(1) + 'px worst (tol ' + (SW * tol).toFixed(0) + ') via ' + diag.best +
               ' score ' + (diag.score || 0).toFixed(2);
    }
  }
  okFlag ? pass++ : fail++;
  rows.push({ name, okFlag, detail, ms });
}

/* ── the scenarios ─────────────────────────────────────────────── */

check('white page, dark mat, even light',
  { quad: QUAD, content: textPage() }, true);

check('white page, dark mat, strong side lamp',
  { quad: QUAD, content: textPage(), light: sideLamp }, true);

check('white page, dark mat, badly under-exposed',
  { quad: QUAD, content: textPage(), light: dimAll, noise: 1.4 }, true);

check('white page, wooden desk',
  { quad: QUAD, content: textPage(), desk: [past(150), past(104), past(62)], texture: woodGrain }, true);
function past(v) { return v; }

check('white page, pale grey desk (low contrast)',
  { quad: QUAD, content: textPage(), desk: [198, 199, 201] }, true);

check('white page, WHITE desk (shadow line only)',
  { quad: QUAD, content: textPage(), desk: [243, 243, 244], shadow: 0.34, shadowW: 6 }, true);

check('dark document, white desk (inverted polarity)',
  { quad: QUAD, content: plain([58, 58, 62]), desk: [238, 238, 236], shadow: 0.12 }, true);

check('blue mat, white page, side lamp',
  { quad: QUAD, content: textPage(), desk: [38, 62, 120], light: sideLamp }, true);

check('page rotated ~25°', {
  quad: [{x:0.32,y:0.09},{x:0.90,y:0.36},{x:0.68,y:0.92},{x:0.10,y:0.65}],
  content: textPage()
}, true);

check('small page, 30% of frame', {
  quad: [{x:0.33,y:0.28},{x:0.68,y:0.30},{x:0.67,y:0.73},{x:0.32,y:0.71}],
  content: textPage()
}, true);

check('page fills 90% of frame', {
  quad: [{x:0.04,y:0.04},{x:0.96,y:0.05},{x:0.95,y:0.96},{x:0.03,y:0.95}],
  content: textPage()
}, true);

check('page clipped by the frame edge', {
  quad: [{x:0.35,y:0.12},{x:1.22,y:0.16},{x:1.18,y:0.88},{x:0.30,y:0.84}],
  content: textPage(), tol: 0.03
}, [{x:0.35,y:0.12},{x:1,y:0.1585},{x:1,y:0.8817},{x:0.30,y:0.84}]);

check('hand reaching in from the bottom', {
  quad: QUAD, content: textPage(),
  occluder: (d, w, h) => {                       // a forearm-ish bright wedge
    for (let y = h * 0.62; y < h; y++) {
      const half = w * 0.055 * (1 + (y - h * 0.62) / (h * 0.38));
      const cx = w * 0.46 + (y - h * 0.62) * 0.05;
      for (let x = cx - half; x < cx + half; x++) {
        const p = ((y | 0) * w + (x | 0)) * 4;
        d[p] = 196; d[p + 1] = 152; d[p + 2] = 126;
      }
    }
  }
}, true);

check('no page — bare dark mat', { quad: QUAD, content: plain([26, 27, 30]), shadow: 0, ramp: 0.1, desk: [26, 27, 30] }, null);
check('no page — bare wooden desk',
  { quad: QUAD, content: plain([150, 104, 62]), desk: [150, 104, 62], texture: woodGrain, shadow: 0, ramp: 0.1 }, null);
check('no page — noisy grey field',
  { quad: QUAD, content: plain([128, 128, 128]), desk: [128, 128, 128], shadow: 0, ramp: 0.1, noise: 2.2 }, null);

/* ── report ────────────────────────────────────────────────────── */
const width = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
let totalMs = 0;
for (const r of rows) {
  totalMs += r.ms;
  console.log('  ' + (r.okFlag ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' ' +
              r.name.padEnd(width) + '  ' + r.ms.toFixed(0).padStart(3) + 'ms  ' + r.detail);
}
console.log('\n  mean ' + (totalMs / rows.length).toFixed(0) + ' ms/frame at 512px');
console.log((fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
