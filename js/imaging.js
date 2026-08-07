/* imaging.js — the processing pipeline.
 *
 * One code path serves both the live preview and the full-resolution export;
 * only the input scale differs, so what you see is what you get.
 *
 * Order (see REQUIREMENTS.md §4):
 *   warp → rotate/flip/straighten → flatten → white balance → temp/tint →
 *   tone LUT → saturation/vibrance → denoise → sharpen → filter mode → invert
 */
(function (global) {
  'use strict';

  const I = {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

  I.ctx2d = ctx2d;

  /* ── settings ───────────────────────────────────────────────── */

  I.DEFAULTS = {
    filter: 'auto', mode: 'color',
    flatten: 65, wb: 'gray', temp: 0, tint: 0,
    exposure: 0, contrast: 0, gamma: 1, highlights: 0, shadows: 0,
    saturation: 0, vibrance: 0,
    denoise: 0, sharpen: 16,
    threshold: 0, window: 100,
    invert: false,
    rotate: 0, flipH: false, flipV: false, straighten: 0,
    outSize: 'detected'
  };

  /* Presets. `mode` decides the final stage: colour, greyscale or bilevel. */
  I.FILTERS = {
    original:   { mode: 'color', flatten: 0,   wb: 'off',   contrast: 0,  gamma: 1,    saturation: 0,  vibrance: 0, sharpen: 0,  denoise: 0, exposure: 0, highlights: 0, shadows: 0, temp: 0, tint: 0 },
    auto:       { mode: 'color', flatten: 95,  wb: 'gray',  contrast: 18, gamma: 1,    saturation: 6,  vibrance: 10, sharpen: 16, denoise: 0, exposure: 0, highlights: 0, shadows: 0 },
    color:      { mode: 'color', flatten: 95,  wb: 'white', contrast: 26, gamma: 1.05, saturation: 14, vibrance: 18, sharpen: 20, denoise: 4, exposure: 2, highlights: -6, shadows: 4 },
    gray:       { mode: 'gray',  flatten: 95,  wb: 'gray',  contrast: 22, gamma: 1,    saturation: 0,  vibrance: 0, sharpen: 18, denoise: 4, exposure: 0, highlights: 0, shadows: 0 },
    bw:         { mode: 'bw',    flatten: 100, wb: 'gray',  contrast: 10, gamma: 1,    saturation: 0,  vibrance: 0, sharpen: 12, denoise: 8, exposure: 0, highlights: 0, shadows: 0, threshold: 0, window: 100 },
    whiteboard: { mode: 'color', flatten: 100, wb: 'white', contrast: 42, gamma: 1.1,  saturation: 45, vibrance: 25, sharpen: 14, denoise: 10, exposure: 4, highlights: -10, shadows: 0 },
    ink:        { mode: 'gray',  flatten: 100, wb: 'gray',  contrast: 56, gamma: 0.82, saturation: 0,  vibrance: 0, sharpen: 26, denoise: 6, exposure: -2, highlights: 0, shadows: -12 },
    photo:      { mode: 'color', flatten: 0,   wb: 'off',   contrast: 8,  gamma: 1,    saturation: 8,  vibrance: 12, sharpen: 8, denoise: 0, exposure: 0, highlights: 0, shadows: 0 }
  };

  I.newAdjust = function () { return Object.assign({}, I.DEFAULTS, I.FILTERS.auto, { filter: 'auto' }); };

  /** Apply a preset, preserving geometry and output-size choices. */
  I.setFilter = function (adjust, name) {
    const preset = I.FILTERS[name];
    if (!preset) return adjust;
    Object.assign(adjust, I.DEFAULTS, preset, {
      filter: name,
      rotate: adjust.rotate, flipH: adjust.flipH, flipV: adjust.flipV,
      straighten: adjust.straighten, outSize: adjust.outSize, invert: adjust.invert
    });
    return adjust;
  };

  /* ── illumination map ───────────────────────────────────────── */

  /**
   * Box blur over the coarse illumination map.
   *
   * Out-of-range taps are point-reflected (2·edge − mirrored sample) rather
   * than clamped. Clamping replicates the edge value, which biases the average
   * inward and leaves a dark rim exactly where an overhead lamp falls off;
   * point reflection reproduces a linear ramp exactly, right to the border.
   * The map is at most 88×88, so a direct convolution costs nothing.
   */
  function boxBlur(src, w, h, r) {
    function tap(arr, base, i, n, stride) {
      if (i >= 0 && i <= n - 1) return arr[base + i * stride];
      if (i < 0) {
        const j = Math.min(-i, n - 1);
        return 2 * arr[base] - arr[base + j * stride];
      }
      const j = Math.max(0, 2 * (n - 1) - i);
      return 2 * arr[base + (n - 1) * stride] - arr[base + j * stride];
    }
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const win = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tap(src, row, x + k, w, 1);
        tmp[row + x] = acc / win;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tap(tmp, x, y + k, h, w);
        out[y * w + x] = acc / win;
      }
    }
    return out;
  }

  /**
   * Estimate the illumination (paper) level on a coarse grid.
   *
   * Per-block *maximum* rather than mean: text and ink are dark, and taking the
   * max reads through them to the paper underneath. The result is then blurred
   * hard — radius ≈ a third of the map — because illumination is by definition
   * low-frequency: a big blur passes the lamp's falloff through untouched while
   * a large photo or colour block gets its estimate from the paper around it,
   * instead of being read as "this region's paper is dark" and blown to white.
   *
   * Luminance only, one gain for all three channels. Dividing each channel by
   * its own background doubles as a white balance, but it also drains large
   * saturated areas — a red header divided by its own weak green and blue
   * backgrounds comes out pink. Colour casts are the white-balance stage's job.
   */
  function backgroundMap(data, w, h) {
    const bw = clamp(Math.round(w / 14), 10, 88);
    const bh = clamp(Math.round(h / 14), 10, 88);
    const L = new Float32Array(bw * bh);

    for (let y = 0; y < h; y++) {
      const by = Math.min(bh - 1, (y * bh / h) | 0) * bw;
      let p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) {
        const lum = data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722;
        const bi = by + Math.min(bw - 1, (x * bw / w) | 0);
        if (lum > L[bi]) L[bi] = lum;
      }
    }

    // Two readings, and the estimate is the larger of them.
    //
    //   broad  — heavily blurred, so it passes a lamp's falloff through and
    //            ignores content; but whatever surrounds the paper drags it
    //            down, and a page that does not fill the frame has dark mat on
    //            the other side of its edge. The gain then climbs and lifts the
    //            *ink* along with the paper, which bleaches text and blows the
    //            page white near its edges.
    //   local  — the block maxima barely smoothed: what paper actually reads
    //            here, when there is paper here.
    //
    // Taking max(broad, 0.8·local) fixes that without giving up the blur's one
    // real job. On a smooth gradient `broad` already exceeds it and nothing
    // changes; over a dark photo inside a page `local` is the photo's own dark
    // level and `broad` wins, so the photo is not blown to white.
    const broad = boxBlur(L, bw, bh, Math.max(2, Math.round(Math.min(bw, bh) / 3)));
    const local = boxBlur(L, bw, bh, 1);
    const out = new Float32Array(bw * bh);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(broad[i], local[i] * 0.8);

    // Floor the map well below the paper level but nowhere near black. At 15%
    // of peak, a frame that is mostly dark mat gets gains approaching 7×, which
    // multiplies sensor noise into the visible grain you see on a black
    // background. 35% still allows the ~2.6× a real side lamp needs.
    let peak = 1;
    for (let i = 0; i < out.length; i++) if (out[i] > peak) peak = out[i];
    const floor = Math.max(16, peak * 0.35);
    for (let i = 0; i < out.length; i++) if (out[i] < floor) out[i] = floor;

    return { l: out, w: bw, h: bh };
  }

  function sampleBilinear(arr, aw, ah, fx, fy) {
    const x = fx * aw - 0.5, y = fy * ah - 0.5;
    const x0 = clamp(Math.floor(x), 0, aw - 1), y0 = clamp(Math.floor(y), 0, ah - 1);
    const x1 = Math.min(x0 + 1, aw - 1), y1 = Math.min(y0 + 1, ah - 1);
    const tx = clamp(x - x0, 0, 1), ty = clamp(y - y0, 0, 1);
    const a = arr[y0 * aw + x0], b = arr[y0 * aw + x1];
    const c = arr[y1 * aw + x0], d = arr[y1 * aw + x1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /**
   * Divide the image by its own illumination map.
   *
   * Strength interpolates the *gain* geometrically — gain^s — not the output.
   * Blending the output linearly (mix(src, src·255/bg, s)) leaves a residual
   * gradient proportional to (1−s), so a half-strength setting still shows the
   * lamp; raising gain to a fractional power scales the correction evenly
   * across the frame instead. The gain map is computed at block resolution, so
   * this costs a few hundred pow() calls regardless of image size.
   */
  function flatten(data, w, h, strength) {
    const bg = backgroundMap(data, w, h);
    const s = clamp(strength, 0, 100) / 100;
    const gain = new Float32Array(bg.w * bg.h);
    for (let i = 0; i < gain.length; i++) gain[i] = clamp(Math.pow(255 / bg.l[i], s), 0.2, 3.5);

    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / h;
      let p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) {
        const g = sampleBilinear(gain, bg.w, bg.h, (x + 0.5) / w, fy);
        // Soft shoulder here too. A hard clamp at 255 during the divide is what
        // flattened printed detail on an already-bright label into blank white
        // before the tone curve ever saw it.
        data[p]     = shoulder(data[p]     * g);
        data[p + 1] = shoulder(data[p + 1] * g);
        data[p + 2] = shoulder(data[p + 2] * g);
      }
    }
  }

  /* ── white balance ──────────────────────────────────────────── */

  /**
   * Where the paper sits, as a luminance. Used to restrict white balance to the
   * page: averaging the *whole* frame is the classic grey-world assumption, and
   * it is badly wrong for a scanner, where most of the frame can be a black mat
   * whose own colour cast then gets corrected as if it were the document.
   */
  function paperLevel(data, stride) {
    const hist = new Int32Array(256);
    let cnt = 0;
    for (let p = 0; p < data.length; p += stride) {
      hist[Math.min(255, (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) | 0)]++;
      cnt++;
    }
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= cnt * 0.9) return i; }
    return 255;
  }

  function whiteBalance(data, w, h, mode) {
    const n = w * h;
    const stride = Math.max(1, Math.floor(n / 40000)) * 4;   // sample, don't scan
    let gr = 1, gg = 1, gb = 1;

    if (mode === 'gray') {
      // Grey-world over the lighter half of the page only.
      const cut = Math.max(24, paperLevel(data, stride) * 0.55);
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let p = 0; p < data.length; p += stride) {
        const lum = data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722;
        if (lum < cut) continue;
        sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; cnt++;
      }
      if (cnt < 32) return;                       // nothing paper-like to balance on
      const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt, mean = (mr + mg + mb) / 3;
      gr = mean / (mr || 1); gg = mean / (mg || 1); gb = mean / (mb || 1);
    } else if (mode === 'white') {
      const hr = new Int32Array(256), hg = new Int32Array(256), hb = new Int32Array(256);
      let cnt = 0;
      for (let p = 0; p < data.length; p += stride) { hr[data[p]]++; hg[data[p + 1]]++; hb[data[p + 2]]++; cnt++; }
      const pct = (hist) => {
        let acc = 0; const target = cnt * 0.97;
        for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return Math.max(i, 1); }
        return 255;
      };
      gr = 248 / pct(hr); gg = 248 / pct(hg); gb = 248 / pct(hb);
    } else return;

    gr = clamp(gr, 0.55, 1.9); gg = clamp(gg, 0.55, 1.9); gb = clamp(gb, 0.55, 1.9);
    for (let p = 0; p < data.length; p += 4) {
      data[p]     = clamp(data[p]     * gr, 0, 255);
      data[p + 1] = clamp(data[p + 1] * gg, 0, 255);
      data[p + 2] = clamp(data[p + 2] * gb, 0, 255);
    }
  }

  /* ── tone ───────────────────────────────────────────────────── */

  const KNEE = 232;          // where the highlight roll-off begins

  /** Compress above the knee instead of clipping, so bright detail survives. */
  function shoulder(v) {
    if (v <= KNEE) return v < 0 ? 0 : v;
    return KNEE + (255 - KNEE) * Math.tanh((v - KNEE) / (255 - KNEE));
  }

  function toneLUT(a) {
    const lut = new Uint8ClampedArray(256);
    const c = clamp(a.contrast, -100, 100) * 2.55;
    const cf = (259 * (c + 255)) / (255 * (259 - c));
    const invG = 1 / clamp(a.gamma, 0.05, 10);
    const ex = a.exposure * 1.28;
    for (let i = 0; i < 256; i++) {
      let v = i + ex;
      v = cf * (v - 128) + 128;
      v = 255 * Math.pow(clamp(v, 0, 255) / 255, invG);
      const n = v / 255;
      if (a.shadows)    v += a.shadows * 1.15 * Math.pow(1 - n, 2.2);
      if (a.highlights) v += a.highlights * 1.15 * Math.pow(n, 2.2);
      // Soft shoulder. Contrast pushes anything already near white straight
      // past 255, and a hard clip there erases print on a bright label — the
      // detail is in the image, and rolling it off keeps it.
      if (v > KNEE) v = KNEE + (255 - KNEE) * Math.tanh((v - KNEE) / (255 - KNEE));
      lut[i] = clamp(Math.round(v), 0, 255);
    }
    return lut;
  }

  const isIdentityTone = (a) =>
    !a.contrast && !a.exposure && !a.highlights && !a.shadows && Math.abs(a.gamma - 1) < 1e-6;

  /* ── detail ─────────────────────────────────────────────────── */

  /** Median of 9 via a sorting network — no allocation, no sort() call. */
  function median9(a0, a1, a2, a3, a4, a5, a6, a7, a8) {
    let t;
    if (a1 < a0) { t = a0; a0 = a1; a1 = t; } if (a4 < a3) { t = a3; a3 = a4; a4 = t; } if (a7 < a6) { t = a6; a6 = a7; a7 = t; }
    if (a2 < a1) { t = a1; a1 = a2; a2 = t; } if (a5 < a4) { t = a4; a4 = a5; a5 = t; } if (a8 < a7) { t = a7; a7 = a8; a8 = t; }
    if (a1 < a0) { t = a0; a0 = a1; a1 = t; } if (a4 < a3) { t = a3; a3 = a4; a4 = t; } if (a7 < a6) { t = a6; a6 = a7; a7 = t; }
    if (a3 < a0) { a3 = a0; } if (a5 > a8) { a5 = a8; }
    if (a4 < a1) { t = a1; a1 = a4; a4 = t; }
    if (a4 > a7) { a4 = a7; }
    if (a4 < a3) { a4 = a3; }
    if (a4 > a5) { a4 = a5; }
    return a4;
  }

  function denoise(data, w, h, strength) {
    const s = strength / 100;
    const src = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      const ym = (y > 0 ? y - 1 : 0) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
        const i0 = (ym + xm) * 4, i1 = (ym + x) * 4, i2 = (ym + xp) * 4;
        const i3 = (y0 + xm) * 4, i4 = (y0 + x) * 4, i5 = (y0 + xp) * 4;
        const i6 = (yp + xm) * 4, i7 = (yp + x) * 4, i8 = (yp + xp) * 4;
        for (let c = 0; c < 3; c++) {
          const m = median9(src[i0 + c], src[i1 + c], src[i2 + c], src[i3 + c], src[i4 + c],
                            src[i5 + c], src[i6 + c], src[i7 + c], src[i8 + c]);
          data[i4 + c] = src[i4 + c] + (m - src[i4 + c]) * s;
        }
      }
    }
  }

  /**
   * Unsharp mask, at a radius that scales with the image.
   *
   * A fixed 3×3 kernel sharpens a different thing at every resolution: at
   * preview size it works on strokes, at 16 MP it works on grain. That made the
   * export both noisier than the preview and different from it, which breaks
   * the promise that what you see is what you get.
   */
  function sharpen(data, w, h, amount) {
    const amt = amount / 100;
    const r = clamp(Math.round(Math.max(w, h) / 1500), 1, 6);
    const src = new Uint8ClampedArray(data);
    const blur = boxBlurRGB(src, w, h, r);
    for (let i = 0; i < data.length; i += 4) {
      // Roll the overshoot off rather than clipping it. An unsharp mask
      // deliberately overshoots at an edge; clamping that at 255 turns the
      // bright side of every stroke into flat white, which is how sharpening
      // ends up destroying the printed detail it was meant to bring out.
      data[i]     = shoulder(src[i]     + (src[i]     - blur[i])     * amt);
      data[i + 1] = shoulder(src[i + 1] + (src[i + 1] - blur[i + 1]) * amt);
      data[i + 2] = shoulder(src[i + 2] + (src[i + 2] - blur[i + 2]) * amt);
    }
  }

  /** Separable box blur over RGBA, running sums so cost is independent of r. */
  function boxBlurRGB(src, w, h, r) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const win = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, w - 1) * 4 + c];
        for (let x = 0; x < w; x++) {
          tmp[row + x * 4 + c] = acc / win;
          acc += src[row + clamp(x + r + 1, 0, w - 1) * 4 + c] -
                 src[row + clamp(x - r, 0, w - 1) * 4 + c];
        }
      }
    }
    for (let x = 0; x < w; x++) {
      const col = x * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w * 4 + col + c];
        for (let y = 0; y < h; y++) {
          out[y * w * 4 + col + c] = acc / win;
          acc += tmp[clamp(y + r + 1, 0, h - 1) * w * 4 + col + c] -
                 tmp[clamp(y - r, 0, h - 1) * w * 4 + col + c];
        }
      }
    }
    return out;
  }

  /* ── bilevel ────────────────────────────────────────────────── */

  /**
   * Bradley/Roth adaptive threshold: compare each pixel with the mean of a
   * local window, taken from an integral image. Handles the gradient a single
   * desk lamp leaves behind, which a global threshold cannot.
   */
  function adaptiveThreshold(data, w, h, bias, windowPct) {
    const gray = new Float64Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722);
    }
    const iw = w + 1;
    const integral = new Float64Array(iw * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
      }
    }

    let r = Math.round((Math.min(w, h) / 16) * (windowPct / 100) / 2);
    r = clamp(r, 3, Math.floor(Math.min(w, h) / 2) - 1);
    const k = clamp(0.13 - bias / 500, 0.005, 0.6);

    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * iw + (x1 + 1)] - integral[y0 * iw + (x1 + 1)]
                  - integral[(y1 + 1) * iw + x0]       + integral[y0 * iw + x0];
        const v = gray[y * w + x] * count < sum * (1 - k) ? 0 : 255;
        const p = (y * w + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = v;
      }
    }
  }

  /* ── colour stage ───────────────────────────────────────────── */

  /** Run the whole per-pixel chain over an ImageData in place. */
  I.color = function (img, a) {
    const data = img.data, w = img.width, h = img.height;

    if (a.flatten > 0) flatten(data, w, h, a.flatten);
    if (a.wb && a.wb !== 'off') whiteBalance(data, w, h, a.wb);

    // temperature / tint as channel gains, luma roughly preserved
    if (a.temp || a.tint) {
      const t = a.temp / 300, ti = a.tint / 300;
      const gr = (1 + t) * (1 - ti * 0.5), gg = 1 + ti, gb = (1 - t) * (1 - ti * 0.5);
      for (let p = 0; p < data.length; p += 4) {
        data[p]     = clamp(data[p] * gr, 0, 255);
        data[p + 1] = clamp(data[p + 1] * gg, 0, 255);
        data[p + 2] = clamp(data[p + 2] * gb, 0, 255);
      }
    }

    if (!isIdentityTone(a)) {
      const lut = toneLUT(a);
      for (let p = 0; p < data.length; p += 4) {
        data[p] = lut[data[p]]; data[p + 1] = lut[data[p + 1]]; data[p + 2] = lut[data[p + 2]];
      }
    }

    if ((a.saturation || a.vibrance) && a.mode === 'color') {
      const sat = 1 + a.saturation / 100, vib = a.vibrance / 100;
      for (let p = 0; p < data.length; p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
        let amt = sat;
        if (vib) {
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          amt += vib * (1 - (mx - mn) / 255);
        }
        data[p]     = clamp(lum + (r - lum) * amt, 0, 255);
        data[p + 1] = clamp(lum + (g - lum) * amt, 0, 255);
        data[p + 2] = clamp(lum + (b - lum) * amt, 0, 255);
      }
    }

    if (a.denoise > 0) denoise(data, w, h, a.denoise);
    if (a.sharpen > 0) sharpen(data, w, h, a.sharpen);

    if (a.mode === 'gray') {
      for (let p = 0; p < data.length; p += 4) {
        const v = data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722;
        data[p] = data[p + 1] = data[p + 2] = v;
      }
    } else if (a.mode === 'bw') {
      adaptiveThreshold(data, w, h, a.threshold, a.window);
    }

    if (a.invert) {
      for (let p = 0; p < data.length; p += 4) {
        data[p] = 255 - data[p]; data[p + 1] = 255 - data[p + 1]; data[p + 2] = 255 - data[p + 2];
      }
    }
    return img;
  };

  /* ── geometry stage ─────────────────────────────────────────── */

  I.transform = function (src, a) {
    const angle = ((a.rotate || 0) + (a.straighten || 0));
    if (!angle && !a.flipH && !a.flipV) return src;

    const rad = angle * Math.PI / 180;
    const w = src.width, h = src.height;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const nw = Math.max(1, Math.round(w * cos + h * sin));
    const nh = Math.max(1, Math.round(w * sin + h * cos));

    const out = U.canvas(nw, nh);
    const c = ctx2d(out);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, nw, nh);
    c.translate(nw / 2, nh / 2);
    c.rotate(rad);
    c.scale(a.flipH ? -1 : 1, a.flipV ? -1 : 1);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, -w / 2, -h / 2);
    return out;
  };

  /* ── output sizing ──────────────────────────────────────────── */

  const PAPER = { a4: [2480, 3508], letter: [2550, 3300] };

  I.targetSize = function (a, corners, sw, sh, maxDim) {
    let base = (corners && !Geom.isFullFrame(corners))
      ? Geom.outputSize(corners, sw, sh)
      : { w: sw, h: sh };

    const paper = PAPER[a.outSize];
    if (paper) {
      const portrait = base.h >= base.w;
      base = { w: portrait ? paper[0] : paper[1], h: portrait ? paper[1] : paper[0] };
    }

    if (maxDim && isFinite(maxDim)) {
      const k = maxDim / Math.max(base.w, base.h);
      if (k < 1) base = { w: Math.max(16, Math.round(base.w * k)), h: Math.max(16, Math.round(base.h * k)) };
    }
    return base;
  };

  /* ── full pipeline ──────────────────────────────────────────── */

  /**
   * @param {HTMLCanvasElement} src   source frame, already at working scale
   * @param {object}   a              adjustment settings
   * @param {array}    corners        normalised quad, or null for the full frame
   * @param {number}   maxDim         cap on the long edge (Infinity for export)
   * @returns {HTMLCanvasElement}
   */
  I.pipeline = function (src, a, corners, maxDim) {
    const size = I.targetSize(a, corners, src.width, src.height, maxDim);
    const cropped = corners && !Geom.isFullFrame(corners);

    let stage;
    if (cropped) {
      const srcData = ctx2d(src).getImageData(0, 0, src.width, src.height);
      const warped = Geom.warp(srcData, corners, size.w, size.h);
      stage = U.canvas(size.w, size.h);
      ctx2d(stage).putImageData(warped, 0, 0);
    } else if (size.w !== src.width || size.h !== src.height) {
      stage = U.canvas(size.w, size.h);
      const c = ctx2d(stage);
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, 0, 0, size.w, size.h);
    } else {
      stage = U.canvas(src.width, src.height);
      ctx2d(stage).drawImage(src, 0, 0);
    }

    stage = I.transform(stage, a);

    const c = ctx2d(stage);
    const img = c.getImageData(0, 0, stage.width, stage.height);
    I.color(img, a);
    c.putImageData(img, 0, 0);
    return stage;
  };

  /** Downscale helper used for preview sources and thumbnails. */
  I.fit = function (source, maxDim) {
    const w = source.width || source.videoWidth, h = source.height || source.videoHeight;
    const k = Math.min(1, maxDim / Math.max(w, h));
    const out = U.canvas(w * k, h * k);
    const c = ctx2d(out);
    c.imageSmoothingQuality = 'high';
    c.drawImage(source, 0, 0, out.width, out.height);
    return out;
  };

  global.Imaging = I;
})(window);
