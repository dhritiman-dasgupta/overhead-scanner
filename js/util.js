/* util.js — small helpers. Classic script, no modules, so file:// works. */
(function (global) {
  'use strict';

  const U = {};

  U.$  = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp  = (a, b, t) => a + (b - a) * t;

  U.uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  U.bytes = function (n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  };

  U.stamp = function () {
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };

  /** Non-blocking status message. kind: '' | 'good' | 'bad' */
  U.toast = function (msg, kind, ms) {
    const box = U.$('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 320);
    }, ms || (kind === 'bad' ? 4200 : 2200));
  };

  U.download = function (blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  /** Collapse repeated calls into one per animation frame. */
  U.rafThrottle = function (fn) {
    let queued = false, lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn.apply(null, lastArgs); });
    };
  };

  U.canvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };

  U.canvasToBlob = function (canvas, type, quality) {
    return new Promise((res, rej) => {
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas encode failed'))), type, quality);
    });
  };

  U.blobToBytes = (blob) => blob.arrayBuffer().then((b) => new Uint8Array(b));

  /** Short beep via WebAudio — no asset file needed. */
  let actx = null;
  U.beep = function (freq, ms) {
    try {
      actx = actx || new (global.AudioContext || global.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = freq || 880;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.16, actx.currentTime + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (ms || 90) / 1000);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (ms || 90) / 1000 + 0.02);
    } catch (e) { /* audio is a nicety, never fatal */ }
  };

  global.U = U;
})(window);
