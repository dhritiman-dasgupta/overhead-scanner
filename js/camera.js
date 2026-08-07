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

  const RES = {
    auto: [3840, 2160],
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
    // Both of these interrogate the driver, and both can simply never come
    // back on some cameras — getPhotoCapabilities() in particular. Neither is
    // essential, so cap them: a stalled probe must not hang camera start.
    if (!resKey || resKey === 'auto') await withTimeout(pushToMax(), 2500);
    await withTimeout(initPhoto(), 2500);
    startMotionLoop();
    return C.settings();
  };

  /**
   * `ideal` is a soft preference: the browser picks whatever supported mode
   * sits near it and will happily hand back 720p from a camera that can do 4K.
   * Once the track exists it will tell us its real maximum, so ask again.
   */
  async function pushToMax() {
    if (!C.track || !C.track.getCapabilities) return;
    let caps;
    try { caps = C.track.getCapabilities(); } catch (e) { return; }
    if (!caps || !caps.width || !caps.height) return;
    const now = C.track.getSettings ? C.track.getSettings() : {};
    const maxW = caps.width.max, maxH = caps.height.max;
    if (!maxW || !maxH) return;
    if ((now.width || 0) >= maxW && (now.height || 0) >= maxH) return;
    try {
      await C.track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } });
    } catch (e) { /* keep whatever we negotiated */ }
  }

  /**
   * Many cameras offer a still noticeably larger than the video stream. Find
   * out once, at start, so the UI can say what a capture will actually be.
   */
  async function initPhoto() {
    C.imageCapture = null;
    C.photoMax = null;
    if (typeof ImageCapture === 'undefined' || !C.track) return;
    try {
      const ic = new ImageCapture(C.track);
      const caps = await ic.getPhotoCapabilities();
      C.imageCapture = ic;
      if (caps && caps.imageWidth && caps.imageHeight) {
        C.photoMax = { w: caps.imageWidth.max, h: caps.imageHeight.max };
      }
    } catch (e) { C.imageCapture = null; C.photoMax = null; }
  }

  /** Does the still beat the video frame enough to be worth the shutter delay? */
  C.photoIsBigger = function () {
    const s = C.settings();
    if (!C.photoMax || !s || !s.width) return false;
    return C.photoMax.w * C.photoMax.h > s.width * s.height * 1.1;
  };

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
