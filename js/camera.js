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
      await C.video.play().catch(() => {});
    }
    startMotionLoop();
    return C.settings();
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

  /** Grab the current frame at full sensor resolution. */
  C.grab = function (mirror) {
    const v = C.video;
    if (!v || !v.videoWidth) return null;
    const out = U.canvas(v.videoWidth, v.videoHeight);
    const c = out.getContext('2d', { willReadFrequently: true });
    if (mirror) { c.translate(out.width, 0); c.scale(-1, 1); }
    c.drawImage(v, 0, 0, out.width, out.height);
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
