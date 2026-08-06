/* geometry.js — page-edge detection, homography, perspective warp.
 *
 * Corners are stored NORMALISED (0..1 of image width/height) so they survive
 * any change of working resolution: detect once on a 320 px thumbnail, warp at
 * 4K with the same numbers.
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

  /** Reject quads that are tiny, inverted, or wildly non-convex. */
  G.validQuad = function (pts, w, h) {
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const p = pts[i], q = pts[(i + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    area = Math.abs(area) / 2;
    if (area < 0.045 * w * h) return false;         // too small to be the page
    for (let i = 0; i < 4; i++) {
      const a = pts[(i + 3) % 4], b = pts[i], c = pts[(i + 1) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
      const ang = Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI;
      if (ang < 45 || ang > 135) return false;      // not plausibly a rectangle seen at an angle
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

  /* ── document detection ─────────────────────────────────────── */

  // Which polarity last produced a page. Only the live preview uses this, via
  // opts.sticky — it is a property of watching one continuous scene, not of
  // detection itself, and letting it leak into one-off calls would make the
  // result depend on whatever image happened to be detected before.
  let stickyBright = null;
  G.resetSticky = function () { stickyBright = null; };

  /**
   * Find the page quadrilateral in a canvas / video frame.
   * Returns normalised corners TL,TR,BR,BL — or null when nothing convincing
   * is there, in which case the caller should keep the full frame.
   */
  G.detect = function (source, opts) {
    const sticky = !!(opts && opts.sticky);
    const W = source.width || source.videoWidth;
    const H = source.height || source.videoHeight;
    if (!W || !H) return null;

    // 1. Downscale — detection needs shape, not detail, and small is fast.
    const scale = 320 / Math.max(W, H);
    const w = Math.max(40, Math.round(W * scale)), h = Math.max(40, Math.round(H * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;

    // 2. Luma + histogram.
    const gray = new Uint8Array(w * h);
    const hist = new Int32Array(256);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const v = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      gray[i] = v; hist[v]++;
    }

    // 3. Otsu split.
    const total = w * h;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }

    // 4. Which side of the split is the paper? Compare the border ring with the
    //    middle — an overhead rig puts the page in the centre on a darker desk.
    let bSum = 0, bN = 0, cSum = 0, cN = 0;
    const m = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = gray[y * w + x];
        if (x < m || y < m || x >= w - m || y >= h - m) { bSum += v; bN++; }
        else if (x > w * 0.35 && x < w * 0.65 && y > h * 0.35 && y < h * 0.65) { cSum += v; cN++; }
      }
    }
    const pageIsBright = (cSum / (cN || 1)) >= (bSum / (bN || 1));

    // Try the polarity the centre/border comparison suggests, and if that finds
    // nothing, try the other one. The heuristic is only a guess and it is wrong
    // in ordinary situations — a page that nearly fills the frame leaves a
    // border ring that is itself mostly paper, and a hand resting in the middle
    // drags the centre down. Guessing wrong used to mean no outline at all.
    //
    // Whichever polarity worked last time is tried first. Ordering only matters
    // when both would succeed, but in the live view that is exactly when the
    // outline would otherwise flip between two readings frame to frame.
    const first = (sticky && stickyBright !== null) ? stickyBright : pageIsBright;
    let out = attempt(first);
    if (out) { if (sticky) stickyBright = first; return out; }
    out = attempt(!first);
    if (out) { if (sticky) stickyBright = !first; return out; }
    return null;

    function attempt(bright) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = (bright ? gray[i] > thr : gray[i] < thr) ? 1 : 0;
    }

    // 5. Close the mask before labelling. Lines of text, a dark rule, or a
    //    photo band cut the paper into stripes, and the largest of those
    //    stripes is not the page. Dilating bridges gaps up to 2r wide — big
    //    enough for type, far too small to bridge paper to desk.
    const r = Math.max(2, Math.round(Math.min(w, h) * 0.025));
    const solid = dilate(mask, w, h, r);

    // 6. Largest connected component of the closed mask.
    const label = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    let bestLabel = -1, bestSize = 0, next = 0;
    for (let s = 0; s < solid.length; s++) {
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

    // 7. Hull from the ORIGINAL mask inside that component, so the quad sits on
    //    the real paper edge rather than r pixels outside it.
    const pts = [];
    let pageCount = 0;
    for (let y = 0; y < h; y++) {
      let lo = -1, hi = -1;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x] && label[row + x] === bestLabel) { if (lo < 0) lo = x; hi = x; pageCount++; }
      }
      if (lo >= 0) { pts.push({ x: lo, y: y }); pts.push({ x: hi, y: y }); }
    }
    for (let x = 0; x < w; x++) {
      let lo = -1, hi = -1;
      for (let y = 0; y < h; y++) {
        if (mask[y * w + x] && label[y * w + x] === bestLabel) { if (lo < 0) lo = y; hi = y; }
      }
      if (lo >= 0) { pts.push({ x: x, y: lo }); pts.push({ x: x, y: hi }); }
    }
    if (pageCount < total * 0.05 || pageCount > total * 0.985) return null;
    if (pts.length < 8) return null;

    // 8. The region has to actually stand out. Otsu always returns *a* split,
    //    even on a blank desk, and dilation then knits the noise into one
    //    convincing-looking blob. Demand real separation between the page and
    //    everything around it, or report nothing and let the full frame stand.
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (let i = 0; i < gray.length; i++) {
      if (mask[i] && label[i] === bestLabel) { inSum += gray[i]; inN++; }
      else { outSum += gray[i]; outN++; }
    }
    if (!inN || !outN) return null;
    // 12 rather than 18: a dim desk or a pale mat gives a real but modest
    // separation, and the old figure turned those into no outline at all.
    if (Math.abs(inSum / inN - outSum / outN) < 12) return null;

    const quad = hullToQuad(hull(pts));
    if (quad.length !== 4) return null;

    const ordered = G.order(quad);
    if (!G.validQuad(ordered, w, h)) return null;

    // The region has to fill the shape it claims to be. On a desk close to
    // paper colour the paper-side threshold swallows the whole frame and gets
    // rejected, so the other polarity wins — and that one selects the *ink*.
    // Its hull is the text block, which is a perfectly plausible-looking
    // quadrilateral sitting well inside the real page. Ink covers a small
    // fraction of its own bounding box; a sheet of paper fills nearly all of
    // its own outline, text notwithstanding.
    let quadArea = 0;
    for (let i = 0; i < 4; i++) {
      const p = ordered[i], q = ordered[(i + 1) % 4];
      quadArea += p.x * q.y - q.x * p.y;
    }
    quadArea = Math.abs(quadArea) / 2;
    if (pageCount < quadArea * 0.5) return null;

    // And it has to be a *crop*. On a desk close to paper colour the threshold
    // takes in the desk as well, and the hull of that is the whole frame: an
    // outline drawn round everything, which reads as detection working when it
    // has not. Cropping to the full frame is the same as not cropping, so say
    // so honestly and let the operator drag the corners.
    if (quadArea > 0.95 * w * h) return null;

    // 9. Pull in by a hair. The mask boundary sits partway down the soft ramp
    //    at the paper's edge, so the quad tends to straddle it; shrinking
    //    slightly costs a sliver of margin, while erring outward leaves a dark
    //    fringe of desk around the scan, which is far more obvious.
    const pad = -0.8;
    const cx = (ordered[0].x + ordered[1].x + ordered[2].x + ordered[3].x) / 4;
    const cy = (ordered[0].y + ordered[1].y + ordered[2].y + ordered[3].y) / 4;
    return ordered.map((p) => {
      const dx = p.x - cx, dy = p.y - cy, len = Math.hypot(dx, dy) || 1;
      return {
        x: clamp((p.x + (dx / len) * pad) / w, 0, 1),
        y: clamp((p.y + (dy / len) * pad) / h, 0, 1)
      };
    });
    }
  };

  global.Geom = G;
})(window);
