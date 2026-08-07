/* camera.js — device enumeration, streaming, capture, motion detection. */
(function (global) {
  'use strict';

  const C = {
    stream: null,
    track: null,
    video: null,
    motion: 0,          // 0..1 mean absolute frame difference
    stillSince: 0,      // timestamp the scene last became still
    onMotion: null
  };

  /* 'auto' deliberately asks for 1080p, not the sensor maximum.
     A document camera's top mode is a *stills* mode: one tested unit negotiates
     4656×3496 at 10 fps and takes 66 seconds to produce its first frame, which
     leaves the preview dead and capture with nothing to grab. Resolution for
     the scan comes from takePhoto() instead, which returns the full 16 MP while
     the stream stays smooth. Where takePhoto isn't available, raiseStream()
     climbs afterwards — and verifies frames still arrive. */
  const RES = {
    auto: [1920, 1080],
    '3840x2160': [3840, 2160],
    '2560x1440': [2560, 1440],
    '1920x1080': [1920, 1080],
    '1280x720':  [1280, 720]
  };

  C.supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  /** Give up on a promise after `ms` rather than waiting on it forever. */
  function withTimeout(p, ms) {
    let timer;
    return Promise.race([
      Promise.resolve(p).catch(() => undefined),
      new Promise((res) => { timer = setTimeout(() => res(undefined), ms); })
    ]).then((v) => { clearTimeout(timer); return v; });
  }

  C.attach = function (videoEl) { C.video = videoEl; };

  C.listDevices = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  };

  C.start = async function (deviceId, resKey) {
    C.stop();
    const dims = RES[resKey] || RES.auto;
    const video = {
      width:  { ideal: dims[0] },
      height: { ideal: dims[1] },
      frameRate: { ideal: 30 }
    };
    if (deviceId) video.deviceId = { exact: deviceId };

    // 'exact' resolution fails on many UVC cams; ideal negotiates down cleanly.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: false });
    } catch (err) {
      if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
      } else throw err;
    }

    C.stream = stream;
    C.track = stream.getVideoTracks()[0] || null;
    if (C.video) {
      C.video.srcObject = stream;
      // play() rejects on an autoplay block (handled) but can also simply never
      // settle when nothing is compositing the video. Starting the camera must
      // not depend on playback having begun.
      await withTimeout(C.video.play(), 2000);
    }
    // Frames must actually arrive; a mode can negotiate fine and then deliver
    // nothing. The still probe is deliberately not awaited — it costs seconds.
    await waitForFrames(3000);
    C.photoProbe = { state: 'unknown' };
    if (!resKey || resKey === 'auto') await withTimeout(fitPreview(), 9000);
    startMotionLoop();
    return C.settings();
  };

  /**
   * Put the preview on the sensor's own aspect ratio, at a size that streams.
   *
   * This is what makes a full-resolution capture usable at all. The still comes
   * out at the sensor's native shape — 4:3 on the unit tested — and a 16:9
   * preview is a *crop* of that, not a scaled version of it: the frames differ
   * in field of view, so the outline drawn on the preview lands somewhere else
   * on the capture. Match the shape and the two agree, and the operator frames
   * exactly what will be photographed.
   */
  async function fitPreview() {
    if (!C.track || !C.track.getCapabilities) return;
    let caps;
    try { caps = C.track.getCapabilities(); } catch (e) { return; }
    if (!caps.width || !caps.width.max || !caps.height || !caps.height.max) return;
    const aspect = caps.width.max / caps.height.max;

    for (const h of [1200, 960, 720]) {
      const now = C.track.getSettings();
      const w = Math.round(h * aspect / 2) * 2;
      if (Math.abs((now.width / now.height) - aspect) < 0.02 && (now.frameRate || 0) >= 20) return;
      try {
        await C.track.applyConstraints({ width: { ideal: w }, height: { ideal: h } });
      } catch (e) { continue; }
      const st = C.track.getSettings();
      if (!await waitForVideoSize(st.width, 3500)) continue;   // negotiated but never rendered
      if ((st.frameRate || 0) >= 20) return;                   // smooth enough, stop here
    }
  }

  /** Resolve once the video element is actually showing frames. */
  function waitForFrames(ms) {
    const v = C.video;
    if (!v) return Promise.resolve(false);
    if (v.videoWidth) return Promise.resolve(true);
    return new Promise((res) => {
      const t0 = Date.now();
      (function tick() {
        if (!C.track || C.track.readyState !== 'live') return res(false);
        if (v.videoWidth) return res(true);
        if (Date.now() - t0 > ms) return res(false);
        setTimeout(tick, 120);
      })();
    });
  }
  C.waitForFrames = waitForFrames;

  /**
   * Find out what a still is really worth by taking one.
   *
   * getPhotoCapabilities() cannot be trusted for this: on a camera that returns
   * a 4656×3496 photo it reported 1920×1080, simply echoing the stream size. So
   * the only honest answer comes from actually taking a photo and measuring it.
   * Costs a few seconds, so it runs after the preview is already live.
   */
  C.probePhoto = async function () {
    C.imageCapture = null;
    if (typeof ImageCapture === 'undefined' || !C.track) {
      return (C.photoProbe = { state: 'unsupported' });
    }
    const t0 = Date.now();
    try {
      const ic = new ImageCapture(C.track);
      const blob = await withTimeout(ic.takePhoto(), 9000);
      if (!blob) throw new Error('takePhoto timed out');
      const bmp = await createImageBitmap(blob);
      const st = C.settings() || { width: 0, height: 0 };
      C.imageCapture = ic;
      // Bigger is not enough — it has to be the *same view*. A still whose
      // field of view differs from the preview would silently move the crop.
      const match = fovMatch(bmp);
      C.photoProbe = {
        state: 'ok', w: bmp.width, h: bmp.height, ms: Date.now() - t0,
        match: +match.toFixed(3),
        sameView: match >= 0.82,
        bigger: bmp.width * bmp.height > st.width * st.height * 1.1 && match >= 0.82
      };
      if (bmp.close) bmp.close();
    } catch (e) {
      C.photoProbe = { state: 'failed', error: (e && e.message) || String(e) };
    }
    return C.photoProbe;
  };

  /**
   * How closely a still matches the live frame, 0..1.
   *
   * Both are squashed into the same small box and compared by correlation. If
   * the still covers a wider view than the preview, the same features land in
   * different places once stretched and the correlation drops — which is the
   * signal that cropping a capture with the preview's outline would be wrong.
   */
  function fovMatch(bitmap) {
    const v = C.video;
    if (!v || !v.videoWidth) return 0;
    const W = 96, H = 72;
    const a = grayBox(v, W, H), b = grayBox(bitmap, W, H);
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    const den = Math.sqrt(da * db);
    return den > 1e-6 ? Math.max(0, num / den) : 0;
  }

  function grayBox(src, W, H) {
    const c = U.canvas(W, H);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const out = new Float32Array(W * H);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = d[p] * 0.2126 + d[p + 1] * 0.7152 + d[p + 2] * 0.0722;
    }
    return out;
  }

  /** A still is available and was measured. */
  C.canPhoto = () => !!(C.photoProbe && C.photoProbe.state === 'ok');
  /** ...and it shows the same view as the preview, so the outline transfers. */
  C.viewMatches = () => !!(C.photoProbe && C.photoProbe.sameView);
  C.photoIsBigger = () => !!(C.photoProbe && C.photoProbe.state === 'ok' && C.photoProbe.bigger);

  /**
   * Climb towards the sensor's maximum, one step at a time, keeping only a mode
   * that still delivers frames. For a camera with no usable still this is the
   * only way to get resolution — but blindly applying the maximum is what broke
   * the preview, so every step is verified and reverted if it goes quiet.
   */
  C.raiseStream = async function () {
    if (!C.track || !C.track.getCapabilities) return null;
    let caps;
    try { caps = C.track.getCapabilities(); } catch (e) { return null; }
    if (!caps.width || !caps.width.max) return null;
    const start = C.track.getSettings();

    const ladder = [[caps.width.max, caps.height.max], [3840, 2160], [2560, 1440]]
      .filter((wh) => wh[0] > (start.width || 0));

    for (const wh of ladder) {
      const prev = C.track.getSettings();
      try {
        await C.track.applyConstraints({ width: { ideal: wh[0] }, height: { ideal: wh[1] } });
      } catch (e) { continue; }
      const now = C.track.getSettings();
      if ((now.width || 0) <= (prev.width || 0)) continue;      // didn't move
      if (await waitForVideoSize(now.width, 3500)) return C.settings();
      // negotiated but never rendered — put it back
      try {
        await C.track.applyConstraints({ width: { ideal: prev.width }, height: { ideal: prev.height } });
      } catch (e) {}
      await waitForVideoSize(prev.width, 3000);
    }
    return null;
  };

  function waitForVideoSize(w, ms) {
    const v = C.video;
    if (!v) return Promise.resolve(false);
    return new Promise((res) => {
      const t0 = Date.now();
      (function tick() {
        if (v.videoWidth === w) return res(true);
        if (Date.now() - t0 > ms) return res(false);
        setTimeout(tick, 120);
      })();
    });
  }

  C.stop = function () {
    stopMotionLoop();
    if (C.stream) C.stream.getTracks().forEach((t) => t.stop());
    C.stream = null; C.track = null;
    if (C.video) C.video.srcObject = null;
    C.motion = 0;
  };

  C.running = () => !!(C.track && C.track.readyState === 'live');

  C.settings = function () {
    if (!C.track) return null;
    const s = C.track.getSettings ? C.track.getSettings() : {};
    return {
      width: s.width || (C.video && C.video.videoWidth) || 0,
      height: s.height || (C.video && C.video.videoHeight) || 0,
      frameRate: s.frameRate ? Math.round(s.frameRate) : null,
      label: C.track.label || ''
    };
  };

  /* Which of the optional MediaStreamTrack controls this device actually has.
     Almost every webcam exposes a different subset — build the UI from this. */
  /* Exposure first — on an overhead rig the frame is nearly always too dark,
     because the camera meters for the whole desk rather than the page. */
  const CAP_SPECS = [
    { key: 'exposureMode',     label: 'Exposure mode',     kind: 'enum' },
    { key: 'exposureCompensation', label: 'Exposure compensation', kind: 'range' },
    { key: 'exposureTime',     label: 'Exposure time',     kind: 'range', needs: { exposureMode: 'manual' } },
    { key: 'iso',              label: 'ISO',               kind: 'range', needs: { exposureMode: 'manual' } },
    { key: 'brightness',       label: 'Brightness',        kind: 'range' },
    { key: 'contrast',         label: 'Contrast',          kind: 'range' },
    { key: 'saturation',       label: 'Saturation',        kind: 'range' },
    { key: 'sharpness',        label: 'Sharpness',         kind: 'range' },
    { key: 'zoom',             label: 'Zoom',              kind: 'range' },
    { key: 'focusMode',        label: 'Focus',             kind: 'enum' },
    { key: 'focusDistance',    label: 'Focus distance',    kind: 'range', needs: { focusMode: 'manual' } },
    { key: 'whiteBalanceMode', label: 'White balance',     kind: 'enum' },
    { key: 'colorTemperature', label: 'Colour temp.',      kind: 'range', needs: { whiteBalanceMode: 'manual' } },
    { key: 'torch',            label: 'Torch / lamp',      kind: 'bool' }
  ];

  /* Several controls are inert until their mode is switched off automatic.
     Setting exposureTime while exposureMode is 'continuous' silently does
     nothing on most UVC cameras, which looks exactly like a broken slider. */
  const PREREQ = {
    exposureTime:     { exposureMode: 'manual' },
    iso:              { exposureMode: 'manual' },
    focusDistance:    { focusMode: 'manual' },
    colorTemperature: { whiteBalanceMode: 'manual' }
  };

  C.caps = function () {
    if (!C.track || !C.track.getCapabilities) return [];
    let caps;
    try { caps = C.track.getCapabilities(); } catch (e) { return []; }
    const settings = C.track.getSettings ? C.track.getSettings() : {};
    const out = [];
    for (const spec of CAP_SPECS) {
      const cap = caps[spec.key];
      if (cap === undefined) continue;
      if (spec.kind === 'range') {
        if (typeof cap.min !== 'number' || cap.max === cap.min) continue;
        out.push({
          key: spec.key, label: spec.label, kind: 'range',
          min: cap.min, max: cap.max,
          step: cap.step || (cap.max - cap.min) / 100,
          value: settings[spec.key] != null ? settings[spec.key] : cap.min,
          needs: spec.needs
        });
      } else if (spec.kind === 'enum') {
        if (!Array.isArray(cap) || cap.length < 2) continue;
        out.push({ key: spec.key, label: spec.label, kind: 'enum', options: cap, value: settings[spec.key] });
      } else if (spec.kind === 'bool') {
        if (!Array.isArray(cap) || !cap.includes(true)) continue;
        out.push({ key: spec.key, label: spec.label, kind: 'bool', value: !!settings[spec.key] });
      }
    }
    return out;
  };

  C.applyCap = async function (key, value) {
    if (!C.track || !C.track.applyConstraints) return false;

    const pre = PREREQ[key];
    if (pre) {
      const caps = C.track.getCapabilities ? C.track.getCapabilities() : {};
      const now = C.track.getSettings ? C.track.getSettings() : {};
      for (const k in pre) {
        if (Array.isArray(caps[k]) && caps[k].indexOf(pre[k]) >= 0 && now[k] !== pre[k]) {
          const step = {}; step[k] = pre[k];
          try { await C.track.applyConstraints({ advanced: [step] }); } catch (e) { /* try anyway */ }
        }
      }
    }

    const advanced = {};
    advanced[key] = value;
    try {
      await C.track.applyConstraints({ advanced: [advanced] });
      return true;
    } catch (e) {
      return false;
    }
  };

  /** Whichever brightness control this camera actually exposes, best first. */
  function exposureKnob() {
    const caps = C.caps();
    const order = ['exposureCompensation', 'exposureTime', 'iso', 'brightness'];
    for (const key of order) {
      const cap = caps.filter((c) => c.key === key && c.kind === 'range')[0];
      if (cap) return cap;
    }
    return null;
  }
  C.exposureKnob = exposureKnob;

  /**
   * Drive the camera's exposure until the page reads the brightness we want.
   *
   * An overhead rig meters the whole desk, and a small bright page on a large
   * dark mat is exactly the case that fools it: the average is dark, so the
   * camera opens up for the desk and the paper it should be exposing for comes
   * out murky. Rather than guess at a correction, measure the paper itself and
   * search for the setting that puts it where it belongs.
   *
   * Brightness is monotonic in every one of these controls, so a bisection
   * converges in a handful of steps. `measure` returns the current paper level
   * 0..255; the delay between steps lets auto-exposure settle before reading.
   *
   * @returns {Promise<{key,value,level,settled}|null>} null if no control exists
   */
  C.autoExpose = async function (measure, opts) {
    opts = opts || {};
    const target = opts.target || 205;
    const tol = opts.tolerance || 7;
    const onStep = opts.onStep || function () {};
    const knob = exposureKnob();
    if (!knob) return null;

    let lo = knob.min, hi = knob.max, cur = knob.value;
    let level = await measure();
    onStep(0, level, cur);

    for (let i = 1; i <= (opts.steps || 7); i++) {
      if (Math.abs(level - target) <= tol) {
        return { key: knob.key, label: knob.label, value: cur, level: level, settled: true };
      }
      if (level < target) lo = cur; else hi = cur;
      const next = (lo + hi) / 2;
      const minStep = (knob.step || (knob.max - knob.min) / 100) * 0.5;
      if (Math.abs(next - cur) < minStep) break;         // as fine as this camera goes
      cur = next;
      if (!await C.applyCap(knob.key, cur)) break;
      await new Promise((r) => setTimeout(r, opts.settle || 340));
      level = await measure();
      onStep(i, level, cur);
    }
    return { key: knob.key, label: knob.label, value: cur, level: level, settled: Math.abs(level - target) <= tol * 2 };
  };

  /**
   * Ask the lens to focus again. Cameras differ in how they'll agree to: a
   * single-shot trigger if offered, otherwise a bounce out of and back into
   * continuous, which is what actually makes most UVC modules re-hunt.
   */
  C.refocus = async function () {
    if (!C.track || !C.track.getCapabilities) return false;
    let caps;
    try { caps = C.track.getCapabilities(); } catch (e) { return false; }
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    if (modes.indexOf('single-shot') >= 0) return C.applyCap('focusMode', 'single-shot');
    if (modes.indexOf('continuous') >= 0) {
      if (modes.indexOf('manual') >= 0) {
        await C.applyCap('focusMode', 'manual');
        await new Promise((r) => setTimeout(r, 140));
      }
      return C.applyCap('focusMode', 'continuous');
    }
    return false;
  };

  /**
   * Step exposure up or down without the operator having to know which control
   * their camera exposes. Returns a description of what moved, or null.
   */
  C.nudgeExposure = async function (dir) {
    const caps = C.caps();
    const order = ['exposureCompensation', 'exposureTime', 'iso', 'brightness'];
    for (const key of order) {
      const cap = caps.filter((c) => c.key === key && c.kind === 'range')[0];
      if (!cap) continue;
      const span = cap.max - cap.min;
      const step = Math.max(cap.step || 0, span / 20);
      const next = Math.min(cap.max, Math.max(cap.min, cap.value + dir * step));
      if (next === cap.value) continue;
      if (await C.applyCap(key, next)) {
        return { label: cap.label, value: next, min: cap.min, max: cap.max };
      }
    }
    return null;
  };

  /**
   * Grab a frame at the best resolution the camera will give.
   *
   * The video element only ever holds the preview stream. Where the device
   * offers a larger still, take that instead — on a page that fills half the
   * frame, the difference between a 1080p stream and a 4K still is the
   * difference between a soft scan and a sharp one. Falls back silently:
   * takePhoto() is unimplemented or throws on plenty of UVC cameras.
   */
  C.grab = async function (mirror, usePhoto) {
    const v = C.video;
    if (!v || !v.videoWidth) return null;

    let bitmap = null;
    if (usePhoto && C.imageCapture) {
      try {
        // Same hazard as the capability probe, and here it would stall the
        // shutter — fall back to the video frame rather than freeze.
        const blob = await withTimeout(C.imageCapture.takePhoto(), 4000);
        if (!blob) throw new Error('takePhoto timed out');
        const bmp = await createImageBitmap(blob);
        // only worth it if it is actually bigger
        if (bmp.width * bmp.height > v.videoWidth * v.videoHeight) bitmap = bmp;
        else if (bmp.close) bmp.close();
      } catch (e) { bitmap = null; }
    }

    const w = bitmap ? bitmap.width : v.videoWidth;
    const h = bitmap ? bitmap.height : v.videoHeight;
    const out = U.canvas(w, h);
    const c = out.getContext('2d', { willReadFrequently: true });
    if (mirror) { c.translate(w, 0); c.scale(-1, 1); }
    c.drawImage(bitmap || v, 0, 0, w, h);
    if (bitmap && bitmap.close) bitmap.close();
    out.viaPhoto = !!bitmap;
    return out;
  };

  /* ── motion detection ───────────────────────────────────────── */

  let mCanvas = null, mCtx = null, mPrev = null, mTimer = 0;
  const MW = 64, MH = 48;

  function startMotionLoop() {
    if (!mCanvas) {
      mCanvas = U.canvas(MW, MH);
      mCtx = mCanvas.getContext('2d', { willReadFrequently: true });
    }
    mPrev = null;
    C.stillSince = 0;
    clearInterval(mTimer);
    mTimer = setInterval(tickMotion, 90);
  }

  function stopMotionLoop() { clearInterval(mTimer); mTimer = 0; mPrev = null; }

  function tickMotion() {
    const v = C.video;
    if (!v || !v.videoWidth) return;
    mCtx.drawImage(v, 0, 0, MW, MH);
    const d = mCtx.getImageData(0, 0, MW, MH).data;
    const cur = new Uint8Array(MW * MH);
    for (let i = 0, p = 0; i < cur.length; i++, p += 4) {
      cur[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    if (mPrev) {
      let sum = 0;
      for (let i = 0; i < cur.length; i++) sum += Math.abs(cur[i] - mPrev[i]);
      C.motion = sum / cur.length / 255;
    }
    mPrev = cur;
    if (C.onMotion) C.onMotion(C.motion);
  }

  global.Camera = C;
})(window);
