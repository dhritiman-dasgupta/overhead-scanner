/* paddle.js — PP-OCRv4 (PaddleOCR) running locally on onnxruntime-web.
 *
 * Two models, the standard PaddleOCR pipeline:
 *
 *   det  DBNet — outputs a per-pixel text probability map. Post-processing
 *        binarises it, takes each blob's minimum-area rectangle, and expands
 *        ("unclips") it, because DB is trained to predict a shrunk core of each
 *        text region rather than its full extent.
 *   rec  CRNN + CTC — reads one cropped line at a time and emits a probability
 *        per character class per timestep, greedily decoded.
 *
 * Everything is vendored under vendor/, so this never touches the network.
 * The models are the general Chinese+English ones, which is what PaddleOCR
 * ships as its default: the character set includes full ASCII and it is the
 * strongest of their released weights for Latin text too.
 */
(function (global) {
  'use strict';

  const P = {};

  const SELF = (document.currentScript && document.currentScript.src) || '';
  const BASE = SELF ? new URL('..', SELF).href : new URL('.', location.href).href;
  const PATHS = {
    det: BASE + 'vendor/paddle/det.onnx',
    rec: BASE + 'vendor/paddle/rec.onnx',
    keys: BASE + 'vendor/paddle/keys.txt',
    wasm: BASE + 'vendor/onnx/'
  };

  const DET_LIMIT = 960;    // long edge fed to the detector
  const REC_H = 48;         // recognition input height, fixed by the model
  const REC_MAX_W = 800;

  P.available = () => typeof global.ort !== 'undefined';

  /* ── model loading ──────────────────────────────────────────── */

  let sessions = {}, charset = null, loading = null;

  function configureOrt() {
    ort.env.wasm.wasmPaths = PATHS.wasm;
    // No cross-origin isolation over a plain local server, so no SharedArrayBuffer
    // and therefore no worker threads. Single-threaded WASM it is.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
  }

  async function load(onProgress) {
    if (loading) return loading;
    loading = (async () => {
      if (!P.available()) throw new Error('onnxruntime-web did not load — check vendor/onnx/');
      configureOrt();
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };

      if (onProgress) onProgress('loading detector', 0.05);
      sessions.det = await ort.InferenceSession.create(PATHS.det, opts);

      if (onProgress) onProgress('loading recogniser', 0.35);
      sessions.rec = await ort.InferenceSession.create(PATHS.rec, opts);

      if (onProgress) onProgress('loading character set', 0.6);
      const txt = await (await fetch(PATHS.keys)).text();
      // PaddleOCR's convention: blank at index 0, the dictionary, then a space.
      charset = ['·'].concat(txt.replace(/\r/g, '').split('\n')).concat([' ']);
      // a trailing newline in the file would add an empty entry
      if (charset[charset.length - 2] === '') charset.splice(charset.length - 2, 1);
    })();
    try { await loading; } catch (e) { loading = null; throw e; }
    return loading;
  }

  P.preload = (onProgress) => load(onProgress);
  P.loaded = () => !!(sessions.det && sessions.rec && charset);

  P.release = function () {
    for (const k in sessions) { try { sessions[k].release(); } catch (e) {} }
    sessions = {}; charset = null; loading = null;
  };

  /* ── geometry helpers ───────────────────────────────────────── */

  function convexHull(pts) {
    if (pts.length < 4) return pts.slice();
    const s = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [];
    for (const p of s) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
      lo.push(p);
    }
    const up = [];
    for (let i = s.length - 1; i >= 0; i--) {
      const p = s[i];
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
      up.push(p);
    }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  /**
   * Minimum-area rectangle by rotating calipers, expanded by the DB "unclip"
   * distance: area·ratio / perimeter, which for a rectangle is just an outset
   * of that many pixels on every side.
   */
  function minAreaRect(pts, unclip) {
    const h = convexHull(pts);
    if (h.length < 3) return null;
    let best = null;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const ux = dx / len, uy = dy / len, vx = -uy, vy = ux;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of h) {
        const pu = p.x * ux + p.y * uy, pv = p.x * vx + p.y * vy;
        if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
        if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
    }
    if (!best) return null;

    let { minU, maxU, minV, maxV } = best;
    const w = maxU - minU, hh = maxV - minV;
    if (Math.min(w, hh) < 3) return null;
    if (unclip) {
      const d = (w * hh * unclip) / (2 * (w + hh));
      minU -= d; maxU += d; minV -= d; maxV += d;
    }
    const pt = (u, v) => ({ x: u * best.ux + v * best.vx, y: u * best.uy + v * best.vy });
    let quad = [pt(minU, minV), pt(maxU, minV), pt(maxU, maxV), pt(minU, maxV)];

    // Order TL,TR,BR,BL, then rotate so the long side is the reading direction.
    quad = orderQuad(quad);
    const wide = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const tall = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    if (tall > wide * 1.5) quad = [quad[3], quad[0], quad[1], quad[2]];
    return quad;
  }

  function orderQuad(q) {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const withA = q.map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }));
    withA.sort((u, v) => u.a - v.a);
    let start = 0, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = (withA[i].p.x - cx) + (withA[i].p.y - cy);
      if (d < best) { best = d; start = i; }
    }
    return [0, 1, 2, 3].map((i) => withA[(start + i) % 4].p);
  }

  /* ── detection ──────────────────────────────────────────────── */

  function detTensor(source) {
    const sw = source.width, sh = source.height;
    const k = Math.min(1, DET_LIMIT / Math.max(sw, sh));
    // The network needs both sides to be multiples of 32.
    const w = Math.max(32, Math.round(sw * k / 32) * 32);
    const h = Math.max(32, Math.round(sh * k / 32) * 32);

    const c = U.canvas(w, h);
    const ctx = Imaging.ctx2d(c);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;

    const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
    const out = new Float32Array(3 * w * h);
    const plane = w * h;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      out[i]             = (d[p]     / 255 - MEAN[0]) / STD[0];
      out[i + plane]     = (d[p + 1] / 255 - MEAN[1]) / STD[1];
      out[i + 2 * plane] = (d[p + 2] / 255 - MEAN[2]) / STD[2];
    }
    return { tensor: new ort.Tensor('float32', out, [1, 3, h, w]), w, h, sx: sw / w, sy: sh / h };
  }

  /** Binarise the probability map, then one quad per connected blob. */
  function dbBoxes(prob, w, h, sx, sy, opts) {
    const thresh = opts.thresh, boxThresh = opts.boxThresh;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > thresh ? 1 : 0;

    const label = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    const boxes = [];

    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || label[s] !== -1) continue;
      let sp = 0, n = 0, sum = 0;
      const pts = [];
      stack[sp++] = s; label[s] = 1;
      while (sp) {
        const p = stack[--sp];
        const px = p % w, py = (p / w) | 0;
        pts.push({ x: px, y: py });
        sum += prob[p]; n++;
        if (px > 0     && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0     && mask[p - w] && label[p - w] === -1) { label[p - w] = 1; stack[sp++] = p - w; }
        if (py < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = 1; stack[sp++] = p + w; }
      }
      if (n < 6) continue;
      const score = sum / n;
      if (score < boxThresh) continue;

      const quad = minAreaRect(pts, opts.unclip);
      if (!quad) continue;
      boxes.push({
        quad: quad.map((p) => ({ x: p.x * sx, y: p.y * sy })),
        score
      });
    }

    // reading order: down the page, then across
    boxes.sort((a, b) => {
      const ay = (a.quad[0].y + a.quad[2].y) / 2, by = (b.quad[0].y + b.quad[2].y) / 2;
      const ah = Math.abs(a.quad[2].y - a.quad[0].y);
      if (Math.abs(ay - by) > ah * 0.5) return ay - by;
      return a.quad[0].x - b.quad[0].x;
    });
    return boxes;
  }

  /* ── recognition ────────────────────────────────────────────── */

  /** Warp one detected quad out of the page into a straight REC_H-tall strip. */
  function cropLine(srcData, quad, sw, sh) {
    const w1 = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const w2 = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
    const h1 = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    const h2 = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
    const bw = Math.max(w1, w2), bh = Math.max(h1, h2);
    if (bw < 4 || bh < 4) return null;

    const outW = Math.min(REC_MAX_W, Math.max(16, Math.round(REC_H * bw / bh)));
    const norm = quad.map((p) => ({ x: p.x / sw, y: p.y / sh }));
    return { img: Geom.warp(srcData, norm, outW, REC_H), w: outW };
  }

  function recTensor(img) {
    const w = img.width, h = img.height, d = img.data;
    const out = new Float32Array(3 * w * h);
    const plane = w * h;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      out[i]             = d[p]     / 127.5 - 1;
      out[i + plane]     = d[p + 1] / 127.5 - 1;
      out[i + 2 * plane] = d[p + 2] / 127.5 - 1;
    }
    return new ort.Tensor('float32', out, [1, 3, h, w]);
  }

  /** Greedy CTC decode, keeping each character's timestep so we can place words. */
  function ctcDecode(data, T, C) {
    const chars = [];
    let prev = -1, confSum = 0, confN = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bestV = -Infinity;
      const off = t * C;
      for (let c = 0; c < C; c++) {
        const v = data[off + c];
        if (v > bestV) { bestV = v; best = c; }
      }
      if (best !== 0 && best !== prev) {
        chars.push({ ch: charset[best] !== undefined ? charset[best] : '', t });
        confSum += bestV; confN++;
      }
      prev = best;
    }
    return { chars, conf: confN ? confSum / confN : 0 };
  }

  /* ── public API ─────────────────────────────────────────────── */

  let cancelled = false;
  P.cancel = function () { cancelled = true; };

  /**
   * @param {HTMLCanvasElement} canvas  the PROCESSED page image
   * @param {Object} opts { onProgress(status, 0..1) }
   * @returns {Promise<{text, confidence, words, lines}>}
   */
  P.recognize = async function (canvas, opts) {
    opts = opts || {};
    const progress = opts.onProgress || function () {};
    cancelled = false;

    await load(progress);
    if (cancelled) throw new Error('cancelled');

    progress('detecting text', 0.7);
    const inp = detTensor(canvas);
    const feeds = {};
    feeds[sessions.det.inputNames[0]] = inp.tensor;
    const detOut = await sessions.det.run(feeds);
    if (cancelled) throw new Error('cancelled');

    const probTensor = detOut[sessions.det.outputNames[0]];
    const [, , ph, pw] = probTensor.dims;
    const boxes = dbBoxes(probTensor.data, pw, ph, inp.sx * (inp.w / pw), inp.sy * (inp.h / ph), {
      thresh: 0.3, boxThresh: 0.5, unclip: 1.7
    });

    if (!boxes.length) return { text: '', confidence: 0, words: [], lines: [] };

    const srcData = Imaging.ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
    const lines = [], words = [];
    let confSum = 0, confN = 0;

    for (let i = 0; i < boxes.length; i++) {
      if (cancelled) throw new Error('cancelled');
      progress('reading line ' + (i + 1) + '/' + boxes.length, 0.75 + 0.25 * (i / boxes.length));

      const crop = cropLine(srcData, boxes[i].quad, canvas.width, canvas.height);
      if (!crop) continue;

      const rFeeds = {};
      rFeeds[sessions.rec.inputNames[0]] = recTensor(crop.img);
      const rOut = await sessions.rec.run(rFeeds);
      const t = rOut[sessions.rec.outputNames[0]];
      const T = t.dims[1], C = t.dims[2];
      const { chars, conf } = ctcDecode(t.data, T, C);

      const text = chars.map((c) => c.ch).join('').trim();
      if (!text) continue;
      lines.push({ text, confidence: conf * 100, quad: boxes[i].quad });
      confSum += conf; confN++;

      // Character timesteps span the crop left to right, so a word's timestep
      // range maps straight back onto the line's quad — which gives real word
      // boxes rather than one box per line, and a usable PDF text layer.
      const q = boxes[i].quad;
      const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      const flush = (from, to, str) => {
        if (!str) return;
        const u0 = Math.max(0, from / T), u1 = Math.min(1, (to + 1) / T);
        const c0 = [lerp(q[0], q[1], u0), lerp(q[3], q[2], u0)];
        const c1 = [lerp(q[0], q[1], u1), lerp(q[3], q[2], u1)];
        const xs = [c0[0].x, c0[1].x, c1[0].x, c1[1].x];
        const ys = [c0[0].y, c0[1].y, c1[0].y, c1[1].y];
        words.push({
          text: str, conf: conf * 100,
          x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
          x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys)
        });
      };
      let buf = '', start = -1, last = -1;
      for (const c of chars) {
        if (c.ch === ' ') { flush(start, last, buf); buf = ''; start = -1; continue; }
        if (start < 0) start = c.t;
        last = c.t; buf += c.ch;
      }
      flush(start, last, buf);
    }

    return {
      text: lines.map((l) => l.text).join('\n'),
      confidence: confN ? (confSum / confN) * 100 : 0,
      words,
      lines
    };
  };

  global.Paddle = P;
})(window);
