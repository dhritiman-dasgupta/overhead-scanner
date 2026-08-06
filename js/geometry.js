/* geometry.js — page-edge detection, homography, perspective warp.
 *
 * Corners are stored NORMALISED (0..1 of image width/height) so they survive
 * any change of working resolution: detect once on a small thumbnail, warp at
 * 4K with the same numbers.
 *
 * Detection is deliberately not a single algorithm. A page on a desk can be
 * brighter than its surround, darker than it, or the same brightness but a
 * different colour, and no one segmentation handles all three. So several
 * cheap candidate segmentations run, each proposes a quadrilateral, every
 * candidate is refined against the image gradient, and the one whose edges
 * actually sit on real image edges wins. If none of them convince, detection
 * returns null and the caller keeps the full frame — a wrong crop is worse
 * than no crop.
 */
(function (global) {
  'use strict';

  const G = {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ── linear algebra ─────────────────────────────────────────── */

  /** Solve A·x = b for an n×n system, Gaussian elimination w/ partial pivot. */
  function solve(A, b, n) {
    for (let col = 0; col < n; col++) {
      let piv = col, best = Math.abs(A[col][col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(A[r][col]);
        if (v > best) { best = v; piv = r; }
      }
      if (best < 1e-12) return null;             // singular — degenerate quad
      if (piv !== col) {
        const t = A[piv]; A[piv] = A[col]; A[col] = t;
        const tb = b[piv]; b[piv] = b[col]; b[col] = tb;
      }
      const d = A[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r][col] / d;
        if (f === 0) continue;
        for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
      x[r] = s / A[r][r];
    }
    return x;
  }

  /**
   * 3×3 homography mapping the four `from` points onto the four `to` points.
   * Returns [a,b,c,d,e,f,g,h,1] row-major, or null if degenerate.
   */
  G.homography = function (from, to) {
    const A = [], b = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
      const x = from[i].x, y = from[i].y, X = to[i].x, Y = to[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b[i * 2] = X;
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b[i * 2 + 1] = Y;
    }
    const h = solve(A, b, 8);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  };

  /* ── perspective warp ───────────────────────────────────────── */

  /**
   * Warp the quadrilateral `corners` (normalised, TL/TR/BR/BL) out of `src`
   * into a straight outW×outH rectangle. Inverse mapping + bilinear sampling.
   */
  G.warp = function (src, corners, outW, outH) {
    outW = Math.max(1, Math.round(outW));
    outH = Math.max(1, Math.round(outH));

    const sw = src.width, sh = src.height, sd = src.data;
    const out = new ImageData(outW, outH), od = out.data;

    // Map destination rectangle -> source quad, so we can pull pixels.
    const dst = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
    const quad = corners.map((c) => ({ x: c.x * sw, y: c.y * sh }));
    const H = G.homography(dst, quad);
    if (!H) { od.fill(255); return out; }

    const [a, b, c, d, e, f, g, h] = H;
    const maxX = sw - 1, maxY = sh - 1;

    for (let y = 0; y < outH; y++) {
      const yc = y + 0.5;
      // Incremental evaluation along the scanline: everything is affine in x.
      let nx = a * 0.5 + b * yc + c;
      let ny = d * 0.5 + e * yc + f;
      let nw = g * 0.5 + h * yc + 1;
      let o = y * outW * 4;

      for (let x = 0; x < outW; x++, o += 4, nx += a, ny += d, nw += g) {
        const iw = nw === 0 ? 0 : 1 / nw;
        const sx = nx * iw - 0.5, sy = ny * iw - 0.5;

        if (sx < -1 || sy < -1 || sx > maxX + 1 || sy > maxY + 1) {
          od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255;   // outside → paper white
          continue;
        }
        const x0 = clamp(Math.floor(sx), 0, maxX), y0 = clamp(Math.floor(sy), 0, maxY);
        const x1 = Math.min(x0 + 1, maxX), y1 = Math.min(y0 + 1, maxY);
        const fx = clamp(sx - x0, 0, 1), fy = clamp(sy - y0, 0, 1);
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;

        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;

        od[o]     = sd[i00]     * w00 + sd[i10]     * w10 + sd[i01]     * w01 + sd[i11]     * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = 255;
      }
    }
    return out;
  };

  /* ── quad helpers ───────────────────────────────────────────── */

  G.fullFrame = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  G.isFullFrame = function (c) {
    if (!c) return true;
    const f = G.fullFrame();
    for (let i = 0; i < 4; i++) {
      if (Math.abs(c[i].x - f[i].x) > 1e-4 || Math.abs(c[i].y - f[i].y) > 1e-4) return false;
    }
    return true;
  };

  /** Sort four points into TL, TR, BR, BL by angle about their centroid. */
  G.order = function (pts) {
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const withAngle = pts.map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }));
    withAngle.sort((u, v) => u.a - v.a);
    // Angles ascend clockwise in screen coords (y down); start at the point
    // closest to the top-left direction.
    let start = 0, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const p = withAngle[i].p, d = (p.x - cx) + (p.y - cy);
      if (d < best) { best = d; start = i; }
    }
    return [0, 1, 2, 3].map((i) => withAngle[(start + i) % 4].p);
  };

  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

  /**
   * Shrink (or grow, for a negative percentage) a quad about its centre.
   * Detection lands on the paper edge; a percent or two of trim removes the
   * shadow line and any fringe of desk without having to move four corners.
   */
  G.inset = function (corners, pct) {
    if (!corners || !pct) return corners;
    const k = 1 - pct / 100;
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    return corners.map((p) => ({
      x: clamp(cx + (p.x - cx) * k, 0, 1),
      y: clamp(cy + (p.y - cy) * k, 0, 1)
    }));
  };

  /**
   * Pixel size of the rectangle a quad should unwarp to. Averages the two
   * opposite edge pairs — robust, and never returns an absurd aspect ratio the
   * way focal-length estimation can on a near-degenerate quad.
   */
  G.outputSize = function (corners, imgW, imgH) {
    const p = corners.map((c) => ({ x: c.x * imgW, y: c.y * imgH }));
    const w = Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
    const h = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
    return { w: Math.max(16, Math.round(w)), h: Math.max(16, Math.round(h)) };
  };

  function quadArea(pts) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const p = pts[i], q = pts[(i + 1) % 4];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /** Reject quads that are tiny, inverted, or wildly non-rectangular. */
  G.validQuad = function (pts, w, h) {
    for (const p of pts) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
      if (p.x < -w * 0.25 || p.x > w * 1.25 || p.y < -h * 0.25 || p.y > h * 1.25) return false;
    }
    if (quadArea(pts) < 0.04 * w * h) return false;          // too small to be the page
    const shortest = Math.min(w, h);
    for (let i = 0; i < 4; i++) {
      if (dist(pts[i], pts[(i + 1) % 4]) < 0.12 * shortest) return false;
      const a = pts[(i + 3) % 4], b = pts[i], c = pts[(i + 1) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
      const ang = Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI;
      if (ang < 40 || ang > 140) return false;   // not plausibly a rectangle seen at an angle
    }
    return true;
  };

  /* ── convex hull (Andrew monotone chain) ────────────────────── */

  function hull(points) {
    if (points.length < 4) return points.slice();
    const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /** Collapse a convex hull to 4 vertices, dropping whichever loses least area. */
  function hullToQuad(h) {
    const poly = h.slice();
    while (poly.length > 4) {
      let worst = -1, worstLoss = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
        const loss = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
        if (loss < worstLoss) { worstLoss = loss; worst = i; }
      }
      poly.splice(worst, 1);
    }
    return poly;
  }

  /** Separable binary dilation (max filter) with radius r. */
  function dilate(mask, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
        let m = 0;
        for (let i = lo; i <= hi; i++) if (mask[row + i]) { m = 1; break; }
        tmp[row + x] = m;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
        let m = 0;
        for (let i = lo; i <= hi; i++) if (tmp[i * w + x]) { m = 1; break; }
        out[y * w + x] = m;
      }
    }
    return out;
  }

  /* ── working image ──────────────────────────────────────────── */

  let workCanvas = null;   // reused; the live preview calls this several times a second

  /**
   * Downscale the frame and precompute luminance and the Sobel gradient field.
   * Everything downstream works on this one small buffer.
   */
  function prepare(source, maxDim) {
    const W = source.width || source.videoWidth;
    const H = source.height || source.videoHeight;
    if (!W || !H) return null;

    const k = Math.min(1, maxDim / Math.max(W, H));
    const w = Math.max(48, Math.round(W * k));
    const h = Math.max(48, Math.round(H * k));

    if (!workCanvas) workCanvas = document.createElement('canvas');
    if (workCanvas.width !== w || workCanvas.height !== h) { workCanvas.width = w; workCanvas.height = h; }
    const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const rgb = ctx.getImageData(0, 0, w, h).data;

    const n = w * h;
    const gray = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      gray[i] = (rgb[p] * 77 + rgb[p + 1] * 150 + rgb[p + 2] * 29) >> 8;
    }

    // Sobel, scaled by 1/8 so |g| reads roughly as "grey levels across the edge".
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    const at = (x, y) => gray[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
    const magHist = new Int32Array(256);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tl = at(x - 1, y - 1), tc = at(x, y - 1), tr = at(x + 1, y - 1);
        const ml = at(x - 1, y),                        mr = at(x + 1, y);
        const bl = at(x - 1, y + 1), bc = at(x, y + 1), br = at(x + 1, y + 1);
        const ex = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) / 8;
        const ey = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) / 8;
        const i = y * w + x;
        gx[i] = ex; gy[i] = ey;
        const m = Math.hypot(ex, ey);
        mag[i] = m;
        magHist[Math.min(255, m | 0)]++;
      }
    }

    // Reference edge strength: the 92nd percentile, floored so a flat frame
    // doesn't make every faint noise edge count as "support".
    let acc = 0, p92 = 8;
    for (let i = 0; i < 256; i++) { acc += magHist[i]; if (acc >= n * 0.92) { p92 = i; break; } }

    return { w, h, rgb, gray, gx, gy, mag, magRef: clamp(p92, 7, 55) };
  }

  /**
   * Three-class Otsu, returning both split points.
   *
   * A page of text on a desk has three populations — ink, paper, desk — and a
   * two-class split lands on whichever pair dominates the histogram, which is
   * usually ink-vs-everything. That produces a mask of paper *and* desk
   * together, and the page vanishes. Taking both thresholds gives candidates
   * for either boundary and lets scoring choose.
   */
  function otsu3(hist, total) {
    const P = new Float64Array(257), S = new Float64Array(257);
    for (let i = 0; i < 256; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
    let best = -1, bt1 = 85, bt2 = 170;
    for (let t1 = 1; t1 < 254; t1++) {
      const w0 = P[t1 + 1], s0 = S[t1 + 1];
      if (w0 < 1) continue;
      const c0 = s0 * s0 / w0;
      for (let t2 = t1 + 1; t2 < 255; t2++) {
        const w1 = P[t2 + 1] - P[t1 + 1], w2 = total - P[t2 + 1];
        if (w1 < 1 || w2 < 1) continue;
        const s1 = S[t2 + 1] - S[t1 + 1], s2 = S[256] - S[t2 + 1];
        const v = c0 + s1 * s1 / w1 + s2 * s2 / w2;   // maximising Σ wᵢ·mᵢ² ≡ between-class variance
        if (v > best) { best = v; bt1 = t1; bt2 = t2; }
      }
    }
    return [bt1, bt2];
  }

  /* ── candidate segmentations ────────────────────────────────── */

  /** Median colour of the border ring — a robust model of "the desk". */
  function deskColour(rgb, w, h) {
    const m = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    const hr = new Int32Array(256), hg = new Int32Array(256), hb = new Int32Array(256);
    let n = 0;
    for (let y = 0; y < h; y++) {
      const edgeRow = y < m || y >= h - m;
      for (let x = 0; x < w; x++) {
        if (!edgeRow && x >= m && x < w - m) { x = w - m - 1; continue; }
        const p = (y * w + x) * 4;
        hr[rgb[p]]++; hg[rgb[p + 1]]++; hb[rgb[p + 2]]++; n++;
      }
    }
    const med = (hist) => {
      let acc = 0;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n / 2) return i; }
      return 128;
    };
    return { r: med(hr), g: med(hg), b: med(hb) };
  }

  /**
   * Four cheap ways of saying "this pixel is not the desk". Each becomes a
   * candidate quad; scoring decides between them. Trying both luminance
   * polarities removes the old page-is-brighter guess, which was wrong for a
   * dark document on a white desk and for a page lit dimmer than its surround.
   */
  function scoreMaps(prep, fast) {
    const { w, h, rgb, gray } = prep;
    const n = w * h;
    const desk = deskColour(rgb, w, h);
    const maps = [];

    const grayHist = new Int32Array(256);
    for (let i = 0; i < n; i++) grayHist[gray[i]]++;
    const gt = otsu3(grayHist, n);

    // distance from the desk colour, in RGB and in illumination-invariant
    // chromaticity — the latter finds white paper on a wooden desk even when a
    // lamp gradient has wrecked any brightness relationship.
    const rgbD = new Uint8Array(n), chrD = new Uint8Array(n);
    const ds = desk.r + desk.g + desk.b + 1;
    const dnr = desk.r / ds, dng = desk.g / ds;
    const rgbHist = new Int32Array(256), chrHist = new Int32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      const v = Math.min(255, (Math.abs(r - desk.r) + Math.abs(g - desk.g) + Math.abs(b - desk.b)) * 0.34) | 0;
      rgbD[i] = v; rgbHist[v]++;
      const s = r + g + b + 1;
      const c = Math.min(255, (Math.abs(r / s - dnr) + Math.abs(g / s - dng)) * 1100) | 0;
      chrD[i] = c; chrHist[c]++;
    }
    const rt = otsu3(rgbHist, n), ct = otsu3(chrHist, n);

    // Ordered by how often each wins in practice; detection stops early on a
    // confident hit, so the common desk setups cost one candidate, not eight.
    maps.push({ name: 'bright',  mask: buildMask(gray, n, gt[1], true) });
    maps.push({ name: 'colour',  mask: buildMask(rgbD, n, rt[1], true) });
    maps.push({ name: 'chroma',  mask: buildMask(chrD, n, ct[1], true) });
    maps.push({ name: 'dark',    mask: buildMask(gray, n, gt[0], false) });
    if (fast) return maps;
    maps.push({ name: 'bright2', mask: buildMask(gray, n, gt[0], true) });
    maps.push({ name: 'dark2',   mask: buildMask(gray, n, gt[1], false) });
    maps.push({ name: 'colour2', mask: buildMask(rgbD, n, rt[0], true) });
    maps.push({ name: 'chroma2', mask: buildMask(chrD, n, ct[0], true) });
    return maps;
  }

  function buildMask(src, n, thr, above) {
    const m = new Uint8Array(n);
    if (above) { for (let i = 0; i < n; i++) m[i] = src[i] > thr ? 1 : 0; }
    else       { for (let i = 0; i < n; i++) m[i] = src[i] < thr ? 1 : 0; }
    return m;
  }

  /**
   * Largest blob of a mask, as a quadrilateral. Dilation first: lines of text,
   * a dark rule or a photo band cut the paper into stripes, and the largest
   * stripe is not the page.
   */
  // Reused across the four candidates and across live-preview calls; these are
  // megabyte-scale buffers and the live loop runs a few times a second.
  let bufLabel = null, bufStack = null;

  function quadFromMask(mask, w, h) {
    const total = w * h;
    const r = Math.max(2, Math.round(Math.min(w, h) * 0.025));
    const solid = dilate(mask, w, h, r);

    if (!bufLabel || bufLabel.length < total) {
      bufLabel = new Int32Array(total);
      bufStack = new Int32Array(total);
    }
    const label = bufLabel, stack = bufStack;
    label.fill(-1, 0, total);
    let bestLabel = -1, bestSize = 0, next = 0;
    for (let s = 0; s < total; s++) {
      if (!solid[s] || label[s] !== -1) continue;
      const id = next++;
      let sp = 0, size = 0;
      stack[sp++] = s; label[s] = id;
      while (sp) {
        const p = stack[--sp]; size++;
        const px = p % w, py = (p / w) | 0;
        if (px > 0     && solid[p - 1] && label[p - 1] === -1) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (px < w - 1 && solid[p + 1] && label[p + 1] === -1) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (py > 0     && solid[p - w] && label[p - w] === -1) { label[p - w] = id; stack[sp++] = p - w; }
        if (py < h - 1 && solid[p + w] && label[p + w] === -1) { label[p + w] = id; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = id; }
    }
    if (bestLabel < 0) return null;

    // Hull from the ORIGINAL mask inside that component, so the quad sits on
    // the real paper edge rather than r pixels outside it. Per-row and
    // per-column extremes are all a convex hull needs.
    const pts = [];
    let count = 0;
    for (let y = 0; y < h; y++) {
      let lo = -1, hi = -1;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x] && label[row + x] === bestLabel) { if (lo < 0) lo = x; hi = x; count++; }
      }
      if (lo >= 0) { pts.push({ x: lo, y }); pts.push({ x: hi, y }); }
    }
    for (let x = 0; x < w; x++) {
      let lo = -1, hi = -1;
      for (let y = 0; y < h; y++) {
        if (mask[y * w + x] && label[y * w + x] === bestLabel) { if (lo < 0) lo = y; hi = y; }
      }
      if (lo >= 0) { pts.push({ x, y: lo }); pts.push({ x, y: hi }); }
    }
    if (count < total * 0.04 || count > total * 0.99 || pts.length < 8) return null;

    const quad = hullToQuad(hull(pts));
    if (quad.length !== 4) return null;
    const ordered = G.order(quad);
    return G.validQuad(ordered, w, h) ? ordered : null;
  }

  /* ── edge refinement ────────────────────────────────────────── */

  const sampleF = (arr, w, h, x, y) => {
    const x0 = clamp(x | 0, 0, w - 1), y0 = clamp(y | 0, 0, h - 1);
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = clamp(x - x0, 0, 1), fy = clamp(y - y0, 0, 1);
    const a = arr[y0 * w + x0], b = arr[y0 * w + x1], c = arr[y1 * w + x0], d = arr[y1 * w + x1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };

  function lineThrough(p0, p1) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const a = -dy / len, b = dx / len;
    return { a, b, c: -(a * p0.x + b * p0.y) };
  }

  /** Weighted total-least-squares line through a point set. */
  function fitLine(pts, wts) {
    let sw = 0, sx = 0, sy = 0;
    for (let i = 0; i < pts.length; i++) { sw += wts[i]; sx += wts[i] * pts[i].x; sy += wts[i] * pts[i].y; }
    if (sw <= 0) return null;
    const mx = sx / sw, my = sy / sw;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - mx, dy = pts[i].y - my, k = wts[i];
      sxx += k * dx * dx; sxy += k * dx * dy; syy += k * dy * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);   // direction of max variance
    const a = -Math.sin(theta), b = Math.cos(theta);
    return { a, b, c: -(a * mx + b * my) };
  }

  function intersect(l1, l2) {
    const det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < 1e-6) return null;
    return {
      x: (l1.b * l2.c - l2.b * l1.c) / det,
      y: (l2.a * l1.c - l1.a * l2.c) / det
    };
  }

  /**
   * Walk along one edge of the coarse quad and, at each step, look sideways for
   * the strongest gradient across the edge — that is the true paper boundary.
   * Fit a line to those hits. This is what turns a rough mask outline into an
   * accurate crop: the segmentation only has to get within a few pixels.
   */
  function refineEdge(prep, p0, p1) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 16) return null;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const win = clamp(Math.round(0.028 * Math.max(prep.w, prep.h)), 4, 20);
    const K = clamp(Math.round(len / 3), 14, 60);

    const pts = [], wts = [];
    for (let i = 0; i < K; i++) {
      // Skip the ends: near a corner the perpendicular edge dominates.
      const t = 0.10 + 0.80 * (i / (K - 1));
      const bx = p0.x + dx * t, by = p0.y + dy * t;
      let bestV = 0, bestS = 0;
      for (let s = -win; s <= win; s++) {
        const x = bx + nx * s, y = by + ny * s;
        if (x < 0 || y < 0 || x > prep.w - 1 || y > prep.h - 1) continue;
        const g = Math.abs(sampleF(prep.gx, prep.w, prep.h, x, y) * nx +
                           sampleF(prep.gy, prep.w, prep.h, x, y) * ny);
        const v = g * (1 - 0.30 * Math.abs(s) / win);     // prefer the nearest strong edge
        if (v > bestV) { bestV = v; bestS = s; }
      }
      if (bestV < prep.magRef * 0.18) continue;
      pts.push({ x: bx + nx * bestS, y: by + ny * bestS });
      wts.push(bestV);
    }
    if (pts.length < Math.max(8, K * 0.35)) return null;

    let line = fitLine(pts, wts);
    if (!line) return null;
    // Refinement nudges an edge onto the paper boundary; it does not get to
    // re-orient it. A fit that has swung away from the coarse edge has locked
    // onto something else — a rule, a fold, a column of type.
    if (Math.abs(line.a * nx + line.b * ny) < 0.985) return null;   // ~10°
    // Two reweighting passes to shake off text and shadow hits.
    for (let pass = 0; pass < 2; pass++) {
      const d = pts.map((p) => Math.abs(line.a * p.x + line.b * p.y + line.c));
      const sorted = d.slice().sort((a, b) => a - b);
      const cut = Math.max(0.8, sorted[sorted.length >> 1] * 2.5);
      const P = [], Wt = [];
      for (let i = 0; i < pts.length; i++) if (d[i] <= cut) { P.push(pts[i]); Wt.push(wts[i]); }
      if (P.length < 8) break;
      const next = fitLine(P, Wt);
      if (!next) break;
      line = next;
    }
    return line;
  }

  /** Is this edge lying along the frame boundary, where the page is cut off? */
  function onFrameBorder(prep, p0, p1) {
    const band = Math.max(3, 0.014 * Math.max(prep.w, prep.h));
    let b = 0;
    for (let k = 0; k <= 10; k++) {
      const t = k / 10, x = p0.x + (p1.x - p0.x) * t, y = p0.y + (p1.y - p0.y) * t;
      if (x < band || y < band || x > prep.w - 1 - band || y > prep.h - 1 - band) b++;
    }
    return b / 11 > 0.6;
  }

  function refineQuad(prep, quad) {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const p0 = quad[i], p1 = quad[(i + 1) % 4];
      // Where the page runs out of the frame there is no boundary to find, and
      // hunting for one only finds page content — text lines sitting at a
      // slight angle look exactly like a faint edge. Leave that side alone.
      lines.push(onFrameBorder(prep, p0, p1) ? lineThrough(p0, p1)
                                            : (refineEdge(prep, p0, p1) || lineThrough(p0, p1)));
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(lines[(i + 3) % 4], lines[i]);
      out.push(p || quad[i]);
    }
    // Refinement corrects a few pixels of slop; a large jump means the fit
    // latched onto something else, so keep the coarse quad instead.
    const limit = 0.10 * Math.max(prep.w, prep.h);
    for (let i = 0; i < 4; i++) {
      if (!isFinite(out[i].x) || !isFinite(out[i].y)) return quad;
      if (dist(out[i], quad[i]) > limit) return quad;
    }
    return G.validQuad(out, prep.w, prep.h) ? out : quad;
  }

  /* ── scoring ────────────────────────────────────────────────── */

  /**
   * How much of the quad's perimeter actually lies on an image edge. This is
   * the measure that separates a real page boundary from an arbitrary blob
   * outline, and it is what lets detection decline rather than guess.
   */
  /**
   * Walk the perimeter once and measure two things.
   *
   *  support  — how much of it lies on a real image edge.
   *  step     — how differently the image reads a few pixels inside the quad
   *             versus a few pixels outside, and how consistently that
   *             difference keeps its sign all the way round.
   *
   * Support alone is not enough to identify a page: a line of type and a wood
   * grain line are both long, straight and strongly gradient, so a quad snapped
   * to them scores as well as the real thing. What separates a page boundary is
   * that it has paper on one side and desk on the other, everywhere along it.
   * A texture line has the same material on both sides, so its step collapses
   * to nothing — which is what stops this from cropping to a stripe of desk.
   */
  function perimeter(prep, quad) {
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

    // Probe at three distances and keep whichever reads the boundary best.
    // One fixed distance cannot serve both cases: on a white desk the only
    // evidence is the thin shadow the paper casts, and a probe wide enough to
    // clear a page's own margin steps straight over it onto desk that looks
    // identical to the paper.
    const span = Math.max(prep.w, prep.h);
    const DELTAS = [clamp(0.006 * span, 2, 4), clamp(0.013 * span, 4, 8), clamp(0.022 * span, 7, 14)];
    const ND = DELTAS.length;
    const DEAD = 6;   // below this the two sides read the same; that is not agreement
    // A page running off the frame gets its edge fitted a few pixels inside the
    // border, so the border band has to be wider than a pixel or two or that
    // edge is judged on a step that cannot exist.
    const EDGE = Math.max(3, 0.014 * span);

    let total = 0, border = 0, hits = 0, sumAbs = 0, steps = 0;
    const edges = [];

    for (let i = 0; i < 4; i++) {
      const p0 = quad[i], p1 = quad[(i + 1) % 4];
      const ex = p1.x - p0.x, ey = p1.y - p0.y;
      const len = Math.hypot(ex, ey);
      if (len < 1) { edges.push({ sampled: 0, borderFrac: 1, step: 0, consistency: 0 }); continue; }
      let nx = -ey / len, ny = ex / len;
      // point the normal away from the quad's centre
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }

      let eTotal = 0, eBorder = 0, eHits = 0, eSteps = 0;
      const dPos = new Float64Array(ND), dNeg = new Float64Array(ND), dSum = new Float64Array(ND);
      const K = clamp(Math.round(len / 2.5), 10, 90);
      for (let k = 0; k < K; k++) {
        const t = (k + 0.5) / K;
        const x = p0.x + ex * t, y = p0.y + ey * t;
        eTotal++;
        // A page running out of frame has no edge there and shouldn't be
        // punished for it — but it earns no credit either, or a band spanning
        // the whole frame would score full marks on its two border sides.
        if (x < EDGE || y < EDGE || x > prep.w - 1 - EDGE || y > prep.h - 1 - EDGE) { eBorder++; continue; }

        let best = 0;
        for (let s = -2; s <= 2; s++) {
          const g = Math.abs(sampleF(prep.gx, prep.w, prep.h, x + nx * s, y + ny * s) * nx +
                             sampleF(prep.gy, prep.w, prep.h, x + nx * s, y + ny * s) * ny);
          if (g > best) best = g;
        }
        // Absolute floor as well as a relative one: on a flat, noisy frame the
        // 92nd-percentile reference is itself just noise.
        if (best > Math.max(7, prep.magRef * 0.30)) eHits++;

        let counted = false;
        for (let di = 0; di < ND; di++) {
          const dl = DELTAS[di];
          const ox = x + nx * dl, oy = y + ny * dl;
          if (ox < 0 || oy < 0 || ox > prep.w - 1 || oy > prep.h - 1) continue;
          const out = sampleF(prep.gray, prep.w, prep.h, ox, oy);
          const in1 = sampleF(prep.gray, prep.w, prep.h, x - nx * dl, y - ny * dl);

          // Probe the interior at two depths and keep the weaker of the two.
          // A line of type also gives a strong, perfectly consistent step —
          // ink inside, paper outside, all the way along — and that is the one
          // thing most likely to be mistaken for a page edge. It gives itself
          // away a little deeper in, where the paper returns: a real page is
          // still paper there, a text band is not.
          const dp = dl * 2.4;
          const ix2 = x - nx * dp, iy2 = y - ny * dp;
          let d;
          if (ix2 < 0 || iy2 < 0 || ix2 > prep.w - 1 || iy2 > prep.h - 1) {
            d = in1 - out;
          } else {
            const a = in1 - out, b = sampleF(prep.gray, prep.w, prep.h, ix2, iy2) - out;
            d = (a > 0 && b > 0) ? Math.min(a, b) : (a < 0 && b < 0) ? Math.max(a, b) : 0;
          }

          // Only a real difference is evidence. Counting near-zero samples as
          // agreement is what let a crop snapped to a block of text look
          // perfectly consistent: paper on both sides of its side edges.
          if (d >= DEAD) dPos[di]++; else if (d <= -DEAD) dNeg[di]++;
          dSum[di] += Math.abs(d);
          counted = true;
        }
        if (counted) eSteps++;
      }

      const eScored = eTotal - eBorder;
      let bStep = 0, bCons = 0, bQual = -1;
      for (let di = 0; di < ND; di++) {
        const st = eSteps ? dSum[di] / eSteps : 0;
        const co = eSteps ? Math.max(dPos[di], dNeg[di]) / eSteps : 0;
        const q = clamp(st / 35, 0, 1) * co;
        if (q > bQual) { bQual = q; bStep = st; bCons = co; }
      }
      edges.push({
        sampled: eScored,
        support: eScored > 0 ? eHits / eScored : 0,
        borderFrac: eTotal ? eBorder / eTotal : 1,
        step: bStep,
        consistency: bCons
      });
      total += eTotal; border += eBorder; hits += eHits;
      sumAbs += bStep * eSteps; steps += eSteps;
    }

    const scored = total - border;
    return {
      edges,
      support: scored > 0 ? hits / scored : 0,
      borderFrac: total ? border / total : 1,
      step: steps ? sumAbs / steps : 0,
      sampled: scored
    };
  }

  function scoreQuad(prep, quad) {
    const m = perimeter(prep, quad);

    // Mostly frame border means we have selected the frame, not a page; the
    // caller's fallback (no crop) is the same answer and doesn't risk a wrong one.
    if (m.borderFrac > 0.55 || m.sampled < 24) return { score: 0, ...m };

    // Every side has to earn its place independently. Averaging over the
    // perimeter lets a quad with two real edges and two imaginary ones pass —
    // which is exactly what a crop snapped to the text block looks like, since
    // its top and bottom happen to sit on the page boundary. A sheet of paper
    // has four boundaries, so demand four.
    let worst = 1;
    for (const e of m.edges) {
      if (e.borderFrac > 0.8) continue;                       // genuinely clipped side
      if (e.sampled < 6) return { score: 0, ...m };
      // 0.60 rather than something stricter: a hand or a paperweight can
      // legitimately sit across a third of one edge.
      if (e.step < 8 || e.consistency < 0.60) return { score: 0, ...m };
      worst = Math.min(worst, clamp(e.step / 35, 0, 1) * e.consistency);
    }

    const stepScore = clamp(m.step / 35, 0, 1);
    return { score: m.support * 0.45 + stepScore * 0.35 + worst * 0.20, ...m };
  }

  /* ── Hough fallback ─────────────────────────────────────────── */

  /**
   * When every segmentation fails — white paper on a white desk is the usual
   * case — there is often still a faint edge or shadow line all the way round.
   * Look for four strong straight lines in two perpendicular families.
   */
  function houghQuad(prep) {
    const { w, h, mag, gx, gy } = prep;
    const n = w * h;
    const thr = prep.magRef * 0.75;
    const diag = Math.ceil(Math.hypot(w, h));
    const nTheta = 180, nRho = 2 * diag + 1;
    const acc = new Float32Array(nTheta * nRho);
    const cos = new Float32Array(nTheta), sin = new Float32Array(nTheta);
    for (let t = 0; t < nTheta; t++) {
      const a = t * Math.PI / nTheta;
      cos[t] = Math.cos(a); sin[t] = Math.sin(a);
    }

    let edges = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mag[i] < thr) continue;
        edges++;
        // Only vote for orientations near the local gradient normal: an order
        // of magnitude less work than a blind vote, and far less noise.
        const ang = Math.atan2(gy[i], gx[i]);
        let t0 = Math.round((ang < 0 ? ang + Math.PI : ang) * nTheta / Math.PI);
        for (let dt = -4; dt <= 4; dt++) {
          const t = ((t0 + dt) % nTheta + nTheta) % nTheta;
          const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
          if (rho >= 0 && rho < nRho) acc[t * nRho + rho] += mag[i];
        }
      }
    }
    if (edges < n * 0.005) return null;

    // Peak picking with non-maximum suppression.
    const peaks = [];
    const used = new Uint8Array(acc.length);
    for (let iter = 0; iter < 60; iter++) {
      let bi = -1, bv = 0;
      for (let i = 0; i < acc.length; i++) if (!used[i] && acc[i] > bv) { bv = acc[i]; bi = i; }
      if (bi < 0) break;
      const t = (bi / nRho) | 0, r = bi % nRho;
      if (peaks.length && bv < peaks[0].v * 0.18) break;
      peaks.push({ t, rho: r - diag, v: bv });
      for (let dt = -3; dt <= 3; dt++) {
        const tt = ((t + dt) % nTheta + nTheta) % nTheta;
        for (let dr = -Math.round(Math.min(w, h) * 0.06); dr <= Math.round(Math.min(w, h) * 0.06); dr++) {
          const rr = r + dr;
          if (rr >= 0 && rr < nRho) used[tt * nRho + rr] = 1;
        }
      }
    }
    if (peaks.length < 4) return null;

    const angDiff = (a, b) => {
      let d = Math.abs(a - b) % nTheta;
      return d > nTheta / 2 ? nTheta - d : d;
    };
    const famA = peaks.filter((p) => angDiff(p.t, peaks[0].t) < 22);
    const famB = peaks.filter((p) => Math.abs(angDiff(p.t, peaks[0].t) - nTheta / 2) < 22);
    if (famA.length < 2 || famB.length < 2) return null;

    // In each family take the pair furthest apart — opposite sides of the page.
    const pick = (fam) => {
      let best = null, bestGap = 0;
      for (let i = 0; i < fam.length; i++) {
        for (let j = i + 1; j < fam.length; j++) {
          const gap = Math.abs(fam[i].rho - fam[j].rho);
          const strength = Math.min(fam[i].v, fam[j].v);
          if (gap < Math.min(w, h) * 0.18) continue;
          const q = gap * strength;
          if (q > bestGap) { bestGap = q; best = [fam[i], fam[j]]; }
        }
      }
      return best;
    };
    const A = pick(famA), B = pick(famB);
    if (!A || !B) return null;

    const toLine = (p) => {
      const a = Math.cos(p.t * Math.PI / nTheta), b = Math.sin(p.t * Math.PI / nTheta);
      return { a, b, c: -p.rho };
    };
    const corners = [];
    for (const a of A) for (const b of B) {
      const p = intersect(toLine(a), toLine(b));
      if (!p) return null;
      corners.push(p);
    }
    if (corners.length !== 4) return null;
    const ordered = G.order(corners);
    return G.validQuad(ordered, w, h) ? ordered : null;
  }

  /* ── detection ──────────────────────────────────────────────── */

  const ACCEPT = 0.55;

  /**
   * Find the page quadrilateral in a canvas / video frame.
   * Returns normalised corners TL,TR,BR,BL — or null when nothing convincing
   * is there, in which case the caller should keep the full frame.
   *
   * opts.maxDim   working resolution, default 512 (use ~384 for a live loop)
   * opts.fast     skip the Hough fallback
   */
  G.detect = function (source, opts) {
    opts = opts || {};
    const prep = prepare(source, opts.maxDim || 512);
    if (!prep) { G.lastDetection = null; return null; }

    const tried = [];
    let best = null;

    for (const cand of scoreMaps(prep, opts.fast)) {
      const coarse = quadFromMask(cand.mask, prep.w, prep.h);
      if (!coarse) { tried.push({ method: cand.name, score: 0 }); continue; }
      const quad = refineQuad(prep, coarse);
      const s = scoreQuad(prep, quad);
      tried.push({ method: cand.name, score: s.score, support: s.support, step: s.step });
      if (!best || s.score > best.score) best = { quad, method: cand.name, ...s };
      if (best.score >= 0.93) break;          // confident — don't pay for the rest
    }

    if ((!best || best.score < ACCEPT) && !opts.fast) {
      const hq = houghQuad(prep);
      if (hq) {
        const quad = refineQuad(prep, hq);
        const s = scoreQuad(prep, quad);
        tried.push({ method: 'hough', score: s.score, support: s.support });
        if (!best || s.score > best.score) best = { quad, method: 'hough', ...s };
      }
    }

    G.lastDetection = { candidates: tried, best: best ? best.method : null, score: best ? best.score : 0 };

    if (!best || best.score < ACCEPT) return null;

    // Pull in by a hair. The fitted line sits in the middle of the paper's soft
    // edge ramp, so erring outward leaves a dark fringe of desk around the
    // scan, which is far more obvious than losing a sliver of margin.
    const q = best.quad;
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return q.map((p) => {
      const dx = p.x - cx, dy = p.y - cy, len = Math.hypot(dx, dy) || 1;
      return {
        x: clamp((p.x - (dx / len) * 0.8) / prep.w, 0, 1),
        y: clamp((p.y - (dy / len) * 0.8) / prep.h, 0, 1)
      };
    });
  };

  global.Geom = G;
})(window);
