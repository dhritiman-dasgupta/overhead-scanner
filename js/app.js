/* app.js — UI controller: state, stage rendering, camera, OCR and export wiring. */
(function (global) {
  'use strict';

  const $ = U.$, $$ = U.$$;
  const PREVIEW_MAX = 1500;    // long edge used for live preview processing
  const OCR_MAX = 2400;        // long edge fed to Tesseract — more is slower, not better
  const THUMB_W = 160;

  /* ── element refs ───────────────────────────────────────────── */
  const el = {
    deviceSel: $('#deviceSel'), resSel: $('#resSel'), btnStart: $('#btnStart'), camStatus: $('#camStatus'),
    tray: $('#tray'), pageCount: $('#pageCount'), trayInfo: $('#trayInfo'),
    fileInput: $('#fileInput'), btnImport: $('#btnImport'), btnClearAll: $('#btnClearAll'),
    modeLive: $('#modeLive'), modeEdit: $('#modeEdit'),
    btnCapture: $('#btnCapture'), btnAutoCap: $('#btnAutoCap'),
    motionFill: $('#motionFill'), motionLbl: $('#motionLbl'),
    btnCorners: $('#btnCorners'), btnDetect: $('#btnDetect'), btnCompare: $('#btnCompare'),
    btnZoomIn: $('#btnZoomIn'), btnZoomOut: $('#btnZoomOut'), btnFit: $('#btnFit'), zoomLabel: $('#zoomLabel'),
    stageView: $('#stageView'), viewport: $('#viewport'), video: $('#video'),
    stageCanvas: $('#stageCanvas'), overlay: $('#overlayCanvas'),
    stageEmpty: $('#stageEmpty'), shutter: $('#shutter'),
    stageInfo: $('#stageInfo'), stageHint: $('#stageHint'),
    resInfo: $('#resInfo'), fpsInfo: $('#fpsInfo'), camCaps: $('#camCaps'),
    expUp: $('#expUp'), expDown: $('#expDown'), expWhat: $('#expWhat'), expValue: $('#expValue'),
    expAuto: $('#expAuto'), pageLevel: $('#pageLevel'), btnRefocus: $('#btnRefocus'),
    photoInfo: $('#photoInfo'), cropInfo: $('#cropInfo'), photoChk: $('#photoChk'),
    autoCapChk: $('#autoCapChk'), beepChk: $('#beepChk'),
    intervalChk: $('#intervalChk'),
    guideGrid: $('#guideGrid'), guideCross: $('#guideCross'), guideDetect: $('#guideDetect'),
    mirrorChk: $('#mirrorChk'), guideAspect: $('#guideAspect'),
    autoDetectChk: $('#autoDetectChk'), autoSelectChk: $('#autoSelectChk'),
    filters: $('#filters'), wbSel: $('#wbSel'), invertChk: $('#invertChk'), outSize: $('#outSize'),
    rotL: $('#rotL'), rotR: $('#rotR'), flipH: $('#flipH'), flipV: $('#flipV'),
    btnResetAdjust: $('#btnResetAdjust'), btnApplyAll: $('#btnApplyAll'),
    ocrLang: $('#ocrLang'), ocrPsm: $('#ocrPsm'), btnOcrPage: $('#btnOcrPage'), btnOcrAll: $('#btnOcrAll'),
    btnOcrCancel: $('#btnOcrCancel'), ocrFill: $('#ocrFill'), ocrStatus: $('#ocrStatus'), ocrConf: $('#ocrConf'),
    ocrText: $('#ocrText'), showBoxes: $('#showBoxes'), btnCopyText: $('#btnCopyText'), btnSaveText: $('#btnSaveText'),
    expFormat: $('#expFormat'), btnExportImage: $('#btnExportImage'), btnCopyClip: $('#btnCopyClip'),
    pdfPageSize: $('#pdfPageSize'), pdfSearchable: $('#pdfSearchable'), pdfAllPages: $('#pdfAllPages'),
    btnExportPdf: $('#btnExportPdf'), btnPrint: $('#btnPrint'), btnExportTextAll: $('#btnExportTextAll'),
    estDims: $('#estDims'), estSize: $('#estSize'), btnEstimate: $('#btnEstimate'),
    helpModal: $('#helpModal'), btnHelp: $('#btnHelp'), btnHelpClose: $('#btnHelpClose')
  };

  /* ── state ──────────────────────────────────────────────────── */
  const state = {
    pages: [],
    current: -1,
    mode: 'live',
    cornerMode: false,
    compare: false,
    zoom: 0,                  // 0 = fit to window
    liveQuad: null,
    dragCorner: -1,
    dragPos: null,
    settings: {
      device: '', res: 'auto',
      dwell: 0.6, sens: 50, interval: 5, previewGain: 1, photoCapture: true,
      expQuality: 92, pdfQuality: 85,
      autoCap: false, interval_on: false, beep: true,
      grid: false, cross: false, liveDetect: true, mirror: false, aspect: '',
      autoDetect: true, autoSelect: true,
      lang: 'eng', psm: '3', format: 'image/jpeg',
      pdfSize: 'a4', searchable: true, allPages: true, showBoxes: false
    }
  };

  const cur = () => (state.current >= 0 ? state.pages[state.current] : null);

  /* ── bitmap caches ──────────────────────────────────────────── */
  const fullCache = new Map();     // id -> canvas (full resolution)
  const prevCache = new Map();     // id -> canvas (PREVIEW_MAX long edge)

  function lru(map, max) {
    while (map.size > max) {
      const k = map.keys().next().value;
      map.delete(k);
    }
  }

  function decode(blob) {
    if (global.createImageBitmap) {
      return createImageBitmap(blob).catch(() => decodeViaImg(blob));
    }
    return decodeViaImg(blob);
  }
  function decodeViaImg(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
      img.src = url;
    });
  }

  async function getFullCanvas(page) {
    if (fullCache.has(page.id)) {
      const c = fullCache.get(page.id);
      fullCache.delete(page.id); fullCache.set(page.id, c);
      return c;
    }
    const bmp = await decode(page.blob);
    const c = U.canvas(bmp.width, bmp.height);
    Imaging.ctx2d(c).drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    fullCache.set(page.id, c);
    lru(fullCache, 2);
    return c;
  }

  async function getPreviewCanvas(page) {
    if (prevCache.has(page.id)) {
      const c = prevCache.get(page.id);
      prevCache.delete(page.id); prevCache.set(page.id, c);
      return c;
    }
    const full = await getFullCanvas(page);
    const c = Imaging.fit(full, PREVIEW_MAX);
    prevCache.set(page.id, c);
    lru(prevCache, 8);
    return c;
  }

  function dropCaches(id) { fullCache.delete(id); prevCache.delete(id); }

  /* ── page creation ──────────────────────────────────────────── */

  async function addPage(canvas, opts) {
    opts = opts || {};
    const blob = await U.canvasToBlob(canvas, 'image/jpeg', 0.94);
    const page = {
      id: U.uid(),
      blob: blob,
      w: canvas.width,
      h: canvas.height,
      corners: null,
      adjust: cur() && opts.inheritAdjust !== false
        ? Object.assign({}, cur().adjust, { rotate: 0, straighten: 0, flipH: false, flipV: false })
        : Imaging.newAdjust(),
      ocr: null,
      thumb: null
    };

    if (state.settings.autoDetect) {
      // A 'quad' key means the caller already decided — and null is a real
      // decision, not "please look again". Capture relies on that: it crops to
      // the outline that was on screen, so a second, independent detection
      // can't quietly disagree with what you were looking at.
      const q = ('quad' in opts) ? opts.quad : Geom.detect(canvas);
      if (q) page.corners = q;
    }

    state.pages.push(page);
    prevCache.set(page.id, Imaging.fit(canvas, PREVIEW_MAX));
    lru(prevCache, 8);

    renderTray();
    persistPage(page);
    if (state.settings.autoSelect) selectPage(state.pages.length - 1, true);
    refreshThumb(page);          // always — selectPage() re-renders the tray but can't fill it
    updateCounts();
    return page;
  }

  function deletePage(idx) {
    const p = state.pages[idx];
    if (!p) return;
    dropCaches(p.id);
    Store.deletePage(p.id).catch(() => {});
    state.pages.splice(idx, 1);
    if (state.current >= state.pages.length) state.current = state.pages.length - 1;
    if (state.pages.length === 0) { state.current = -1; setMode('live'); }
    renderTray();
    updateCounts();
    renderStage();
  }

  function selectPage(idx, switchToEdit) {
    if (idx < 0 || idx >= state.pages.length) return;
    state.current = idx;
    state.zoom = 0;
    if (switchToEdit) setMode('edit');
    syncAdjustUI();
    syncOcrUI();
    renderTray();
    renderStage();
  }

  /* ── tray ───────────────────────────────────────────────────── */

  let trayDragFrom = -1;

  function renderTray() {
    const t = el.tray;
    if (!state.pages.length) {
      t.innerHTML = '<p class="tray-empty">No pages yet.<br>Capture a shot or import an image.</p>';
      return;
    }
    t.innerHTML = '';
    state.pages.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb' + (i === state.current ? ' is-on' : '');
      d.draggable = true;
      d.dataset.idx = i;
      const badges = [];
      if (p.ocr && p.ocr.text) badges.push('<span class="badge">TXT</span>');
      d.innerHTML =
        '<img alt="page ' + (i + 1) + '" src="' + (p.thumb || transparentPx()) + '">' +
        '<span class="num">' + (i + 1) + '</span>' +
        '<span class="badges">' + badges.join('') + '</span>' +
        '<button class="del" title="Delete page">×</button>';

      d.addEventListener('click', (e) => {
        if (e.target.classList.contains('del')) { deletePage(i); return; }
        selectPage(i, true);
      });
      d.addEventListener('dragstart', () => { trayDragFrom = i; d.classList.add('is-drag'); });
      d.addEventListener('dragend', () => {
        d.classList.remove('is-drag');
        $$('.thumb', t).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      });
      d.addEventListener('dragover', (e) => {
        e.preventDefault();
        const r = d.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        d.classList.toggle('drop-before', !after);
        d.classList.toggle('drop-after', after);
      });
      d.addEventListener('dragleave', () => d.classList.remove('drop-before', 'drop-after'));
      d.addEventListener('drop', (e) => {
        e.preventDefault();
        const r = d.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        movePage(trayDragFrom, after ? i + 1 : i);
      });
      t.appendChild(d);
    });
    if (!state.pages[state.current] && state.pages.length) state.current = 0;
  }

  let px1 = null;
  function transparentPx() {
    if (!px1) px1 = U.canvas(4, 5).toDataURL();
    return px1;
  }

  function movePage(from, to) {
    if (from < 0 || from === to || from === to - 1) return;
    const activeId = cur() && cur().id;
    const [p] = state.pages.splice(from, 1);
    state.pages.splice(from < to ? to - 1 : to, 0, p);
    state.current = state.pages.findIndex((x) => x.id === activeId);
    state.pages.forEach((x, i) => { x.order = i; persistPage(x); });
    renderTray();
  }

  async function refreshThumb(page) {
    try {
      const src = await getPreviewCanvas(page);
      const out = Imaging.pipeline(src, page.adjust, page.corners, 420);
      const th = Imaging.fit(out, THUMB_W);
      page.thumb = th.toDataURL('image/jpeg', 0.7);
      const node = el.tray.querySelector('.thumb[data-idx="' + state.pages.indexOf(page) + '"] img');
      if (node) node.src = page.thumb;
      persistPage(page);
    } catch (e) { /* a thumbnail is cosmetic */ }
  }
  const refreshThumbSoon = debounce(() => { const p = cur(); if (p) refreshThumb(p); }, 450);

  function updateCounts() {
    el.pageCount.textContent = state.pages.length;
    let bytes = 0;
    state.pages.forEach((p) => { bytes += p.blob.size; });
    el.trayInfo.textContent = state.pages.length
      ? state.pages.length + ' page' + (state.pages.length > 1 ? 's' : '') + ' · ' + U.bytes(bytes) + ' held'
      : '—';
  }

  function debounce(fn, ms) {
    let t = 0;
    return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(null, a), ms); };
  }

  /* ── stage ──────────────────────────────────────────────────── */

  function setMode(mode) {
    if (mode === 'edit' && !cur()) mode = 'live';
    state.mode = mode;
    el.modeLive.classList.toggle('is-on', mode === 'live');
    el.modeEdit.classList.toggle('is-on', mode === 'edit');
    if (mode === 'live') { state.cornerMode = false; el.btnCorners.classList.remove('is-on'); }
    state.zoom = 0;
    renderStage();
  }

  let lastProcessed = null;   // canvas currently on screen (edit mode)

  const renderStage = U.rafThrottle(function () { renderStageNow(); });

  async function renderStageNow() {
    const live = state.mode === 'live';
    const page = cur();
    const hasSomething = live ? Camera.running() : !!page;

    el.stageEmpty.style.display = hasSomething ? 'none' : '';
    el.viewport.classList.toggle('hidden', !hasSomething);
    el.viewport.classList.toggle('hide-video', !live);
    el.viewport.classList.toggle('hide-canvas', live);
    el.viewport.classList.toggle('mirrored', !!state.settings.mirror);
    el.viewport.classList.toggle('corner-mode', state.cornerMode);
    el.btnCapture.disabled = !Camera.running();

    if (!hasSomething) { el.stageInfo.textContent = '—'; return; }

    let natW, natH;

    if (live) {
      natW = el.video.videoWidth || 1280;
      natH = el.video.videoHeight || 720;
      const st = Camera.settings();
      el.stageInfo.textContent = st ? (st.width + '×' + st.height + (st.frameRate ? ' · ' + st.frameRate + ' fps' : '')) : '—';
      if (!Camera.running()) el.stageHint.textContent = '';
    } else {
      const src = await getPreviewCanvas(page);
      const adj = state.compare ? neutralAdjust(page.adjust) : page.adjust;
      const out = state.cornerMode
        ? copyOf(src)
        : Imaging.pipeline(src, adj, page.corners, PREVIEW_MAX);
      lastProcessed = out;
      el.stageCanvas.width = out.width;
      el.stageCanvas.height = out.height;
      Imaging.ctx2d(el.stageCanvas).drawImage(out, 0, 0);
      natW = out.width; natH = out.height;

      const full = Imaging.targetSize(page.adjust, page.corners, page.w, page.h, Infinity);
      el.stageInfo.textContent =
        'page ' + (state.current + 1) + '/' + state.pages.length +
        ' · source ' + page.w + '×' + page.h +
        ' · output ' + full.w + '×' + full.h +
        (page.corners ? ' · cropped' : '');
      el.stageHint.textContent = state.cornerMode
        ? 'drag the corners — D re-detects, C when done'
        : (state.compare ? 'showing original' : '');
    }

    layoutViewport(natW, natH);
    drawOverlay(natW, natH);
  }

  function copyOf(c) {
    const o = U.canvas(c.width, c.height);
    Imaging.ctx2d(o).drawImage(c, 0, 0);
    return o;
  }

  function neutralAdjust(a) {
    return Object.assign({}, Imaging.DEFAULTS, {
      mode: 'color', filter: 'original', flatten: 0, wb: 'off', sharpen: 0, denoise: 0,
      rotate: a.rotate, flipH: a.flipH, flipV: a.flipV, straighten: a.straighten, outSize: a.outSize
    });
  }

  function layoutViewport(natW, natH) {
    const box = el.stageView.getBoundingClientRect();
    const availW = Math.max(80, box.width - 36);
    const availH = Math.max(80, box.height - 36);
    let scale = Math.min(availW / natW, availH / natH);
    if (state.zoom > 0) scale = state.zoom;
    const dw = Math.max(24, Math.round(natW * scale));
    const dh = Math.max(24, Math.round(natH * scale));

    el.viewport.style.width = dw + 'px';
    el.viewport.style.height = dh + 'px';
    el.video.style.width = dw + 'px'; el.video.style.height = dh + 'px';
    el.stageCanvas.style.width = dw + 'px'; el.stageCanvas.style.height = dh + 'px';
    if (el.overlay.width !== dw || el.overlay.height !== dh) {
      el.overlay.width = dw; el.overlay.height = dh;
    }
    el.zoomLabel.textContent = state.zoom > 0 ? Math.round(scale * 100) + '%' : 'fit';
    return { dw: dw, dh: dh, scale: scale };
  }

  function drawOverlay(natW, natH) {
    const c = el.overlay.getContext('2d');
    const W = el.overlay.width, H = el.overlay.height;
    c.clearRect(0, 0, W, H);
    const s = state.settings;

    if (state.mode === 'live') {
      if (s.grid) {
        c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1;
        c.beginPath();
        for (let i = 1; i < 3; i++) {
          c.moveTo(Math.round(W * i / 3) + .5, 0); c.lineTo(Math.round(W * i / 3) + .5, H);
          c.moveTo(0, Math.round(H * i / 3) + .5); c.lineTo(W, Math.round(H * i / 3) + .5);
        }
        c.stroke();
      }
      if (s.cross) {
        c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1;
        c.beginPath();
        c.moveTo(W / 2, H / 2 - 14); c.lineTo(W / 2, H / 2 + 14);
        c.moveTo(W / 2 - 14, H / 2); c.lineTo(W / 2 + 14, H / 2);
        c.stroke();
      }
      if (s.aspect) {
        const ar = parseFloat(s.aspect);
        let gw = W * 0.86, gh = gw / ar;
        if (gh > H * 0.9) { gh = H * 0.9; gw = gh * ar; }
        c.strokeStyle = 'rgba(77,163,255,.75)'; c.setLineDash([7, 6]); c.lineWidth = 1.5;
        c.strokeRect((W - gw) / 2, (H - gh) / 2, gw, gh);
        c.setLineDash([]);
      }
      if (s.liveDetect && state.liveQuad) drawQuad(c, state.liveQuad, W, H, false);
      return;
    }

    const page = cur();
    if (!page) return;

    if (state.cornerMode) {
      drawQuad(c, page.corners || Geom.fullFrame(), W, H, true);
      if (state.dragPos) drawLoupe(c, W, H);
      return;
    }

    if (s.showBoxes && page.ocr && page.ocr.words && page.ocr.words.length) {
      const kx = W / page.ocr.imgW, ky = H / page.ocr.imgH;
      c.lineWidth = 1;
      for (const w of page.ocr.words) {
        const conf = w.conf || 0;
        c.strokeStyle = conf > 85 ? 'rgba(53,211,154,.85)' : conf > 60 ? 'rgba(255,182,72,.85)' : 'rgba(255,107,107,.9)';
        c.strokeRect(w.x0 * kx, w.y0 * ky, (w.x1 - w.x0) * kx, (w.y1 - w.y0) * ky);
      }
    }
  }

  function drawQuad(c, quad, W, H, handles) {
    const p = quad.map((q) => ({ x: q.x * W, y: q.y * H }));
    c.save();
    if (handles) {
      c.fillStyle = 'rgba(0,0,0,.45)';
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = 'destination-out';
      c.beginPath(); c.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < 4; i++) c.lineTo(p[i].x, p[i].y);
      c.closePath(); c.fill();
      c.globalCompositeOperation = 'source-over';
    }
    c.strokeStyle = handles ? '#4da3ff' : 'rgba(53,211,154,.9)';
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < 4; i++) c.lineTo(p[i].x, p[i].y);
    c.closePath(); c.stroke();

    if (handles) {
      for (let i = 0; i < 4; i++) {
        c.beginPath(); c.arc(p[i].x, p[i].y, 8, 0, 6.284);
        c.fillStyle = state.dragCorner === i ? '#4da3ff' : '#fff';
        c.fill();
        c.lineWidth = 2; c.strokeStyle = '#0d1014'; c.stroke();
      }
    }
    c.restore();
  }

  /** Magnified inset while dragging a corner, so you can land on the edge. */
  function drawLoupe(c, W, H) {
    const src = prevCache.get(cur().id);
    if (!src) return;
    const R = 62, Z = 3.2;
    const nx = state.dragPos.x, ny = state.dragPos.y;
    const lx = nx * W < W / 2 ? W - R - 14 : R + 14;
    const ly = ny * H < H / 2 ? H - R - 14 : R + 14;

    c.save();
    c.beginPath(); c.arc(lx, ly, R, 0, 6.284); c.closePath();
    c.fillStyle = '#000'; c.fill();
    c.clip();
    const sw = (R * 2) / Z, sh = (R * 2) / Z;
    const sx = nx * src.width - sw / 2, sy = ny * src.height - sh / 2;
    c.drawImage(src, sx, sy, sw, sh, lx - R, ly - R, R * 2, R * 2);
    c.strokeStyle = '#4da3ff'; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(lx - R, ly); c.lineTo(lx + R, ly);
    c.moveTo(lx, ly - R); c.lineTo(lx, ly + R);
    c.stroke();
    c.restore();
    c.beginPath(); c.arc(lx, ly, R, 0, 6.284);
    c.strokeStyle = 'rgba(255,255,255,.6)'; c.lineWidth = 2; c.stroke();
  }

  /* ── corner dragging ────────────────────────────────────────── */

  function overlayPos(ev) {
    const r = el.overlay.getBoundingClientRect();
    return {
      x: U.clamp((ev.clientX - r.left) / r.width, 0, 1),
      y: U.clamp((ev.clientY - r.top) / r.height, 0, 1)
    };
  }

  el.overlay.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'edit' || !state.cornerMode || !cur()) return;
    const page = cur();
    if (!page.corners) page.corners = Geom.fullFrame();
    const p = overlayPos(ev);
    const r = el.overlay.getBoundingClientRect();
    let best = -1, bestD = 26 / Math.max(r.width, 1);
    page.corners.forEach((q, i) => {
      const d = Math.hypot((q.x - p.x) * r.width, (q.y - p.y) * r.height) / r.width;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    state.dragCorner = best;
    state.dragPos = p;
    el.overlay.setPointerCapture(ev.pointerId);
    renderStage();
  });

  el.overlay.addEventListener('pointermove', (ev) => {
    if (state.dragCorner < 0) return;
    const page = cur();
    const p = overlayPos(ev);
    page.corners[state.dragCorner] = { x: p.x, y: p.y };
    state.dragPos = p;
    drawOverlay();
  });

  function endDrag() {
    if (state.dragCorner < 0) return;
    state.dragCorner = -1;
    state.dragPos = null;
    const page = cur();
    if (page && page.corners) page.corners = Geom.order(page.corners);
    persistPage(page);
    refreshThumbSoon();
    renderStage();
  }
  el.overlay.addEventListener('pointerup', endDrag);
  el.overlay.addEventListener('pointercancel', endDrag);

  /* ── camera ─────────────────────────────────────────────────── */

  Camera.attach(el.video);

  async function refreshDevices() {
    const list = await Camera.listDevices();
    el.deviceSel.innerHTML = '';
    if (!list.length) {
      el.deviceSel.innerHTML = '<option value="">— no device —</option>';
      return;
    }
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || ('Camera ' + (i + 1));
      el.deviceSel.appendChild(o);
    });
    if (state.settings.device && list.some((d) => d.deviceId === state.settings.device)) {
      el.deviceSel.value = state.settings.device;
    }
  }

  async function startCamera() {
    if (!Camera.supported()) {
      U.toast('This browser exposes no camera API. Serve the folder over http://localhost.', 'bad', 6000);
      return;
    }
    try {
      el.btnStart.disabled = true;
      const st = await Camera.start(el.deviceSel.value || state.settings.device, el.resSel.value);
      await refreshDevices();
      if (st) {
        state.settings.device = (Camera.track && Camera.track.getSettings().deviceId) || el.deviceSel.value;
        el.deviceSel.value = state.settings.device || el.deviceSel.value;
        el.resInfo.textContent = st.width + '×' + st.height;
        el.fpsInfo.textContent = st.frameRate ? st.frameRate + ' fps' : '—';
        updateCaptureInfo();
      }
      Geom.resetSticky();
      el.camStatus.textContent = 'live';
      el.camStatus.className = 'chip chip-on';
      el.btnStart.textContent = 'Stop camera';
      buildCapControls();
      setMode('live');
      saveSettings();
      U.toast('Camera running — ' + (st ? st.width + '×' + st.height : ''), 'good');
    } catch (err) {
      el.camStatus.textContent = 'error';
      el.camStatus.className = 'chip chip-err';
      const msg = err && err.name === 'NotAllowedError'
        ? 'Camera permission denied. Allow it in the browser and try again.'
        : err && err.name === 'NotFoundError'
          ? 'No camera found. Check the USB connection.'
          : 'Could not start the camera: ' + (err && err.message ? err.message : err);
      U.toast(msg, 'bad', 6000);
    } finally {
      el.btnStart.disabled = false;
    }
  }

  function stopCamera() {
    Camera.stop();
    el.camStatus.textContent = 'off';
    el.camStatus.className = 'chip chip-off';
    el.btnStart.textContent = 'Start camera';
    el.resInfo.textContent = '—';
    el.fpsInfo.textContent = '—';
    el.camCaps.innerHTML = '<p class="note">Start the camera to see what it exposes.</p>';
    el.photoInfo.textContent = '—'; el.cropInfo.textContent = '—'; el.pageLevel.textContent = '—';
    state.liveQuad = null;
    renderStage();
  }

  el.btnStart.addEventListener('click', () => (Camera.running() ? stopCamera() : startCamera()));
  el.deviceSel.addEventListener('change', () => {
    state.settings.device = el.deviceSel.value; saveSettings();
    if (Camera.running()) startCamera();
  });
  el.resSel.addEventListener('change', () => {
    state.settings.res = el.resSel.value; saveSettings();
    if (Camera.running()) startCamera();
  });

  /** Build sliders/toggles for whatever MediaStreamTrack controls exist. */
  function buildCapControls() {
    const caps = Camera.caps();
    if (!caps.length) {
      el.camCaps.innerHTML = '<p class="note">This camera exposes no adjustable controls to the browser. Use its own driver utility, or correct in the Adjust tab.</p>';
      return;
    }
    el.camCaps.innerHTML = '';
    caps.forEach((cap) => {
      if (cap.kind === 'range') {
        const d = document.createElement('div');
        d.className = 'ctl';
        d.innerHTML = '<label>' + cap.label + ' <output></output></label>' +
          '<input type="range" min="' + cap.min + '" max="' + cap.max + '" step="' + cap.step + '" value="' + cap.value + '">';
        const inp = d.querySelector('input'), out = d.querySelector('output');
        out.textContent = fmtNum(cap.value);
        inp.addEventListener('input', async () => {
          out.textContent = fmtNum(parseFloat(inp.value));
          const ok = await Camera.applyCap(cap.key, parseFloat(inp.value));
          if (!ok) out.textContent = 'n/a';
        });
        el.camCaps.appendChild(d);
      } else if (cap.kind === 'enum') {
        const l = document.createElement('label');
        l.className = 'field wide';
        l.innerHTML = '<span>' + cap.label + '</span><select>' +
          cap.options.map((o) => '<option' + (o === cap.value ? ' selected' : '') + '>' + o + '</option>').join('') +
          '</select>';
        l.querySelector('select').addEventListener('change', (e) => {
          Camera.applyCap(cap.key, e.target.value).then((ok) => {
            if (!ok) U.toast(cap.label + ': the camera refused that value');
            setTimeout(buildCapControls, 240);   // manual modes unlock other sliders
          });
        });
        el.camCaps.appendChild(l);
      } else {
        const l = document.createElement('label');
        l.className = 'row-check';
        l.innerHTML = '<input type="checkbox"' + (cap.value ? ' checked' : '') + '><span>' + cap.label + '</span>';
        l.querySelector('input').addEventListener('change', (e) => Camera.applyCap(cap.key, e.target.checked));
        el.camCaps.appendChild(l);
      }
    });
  }

  const fmtNum = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(3));

  /* ── exposure ───────────────────────────────────────────────── */

  const levelCanvas = U.canvas(160, 120);

  function insideQuad(q, x, y) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      const c = cr > 0 ? 1 : cr < 0 ? -1 : 0;
      if (!c) continue;
      if (!sign) sign = c; else if (c !== sign) return false;
    }
    return true;
  }

  /**
   * How bright the paper reads right now, 0..255.
   *
   * Measured inside the detected page — or the middle of the frame if there
   * isn't one — and taken as the 90th percentile rather than the mean, because
   * the mean of a page is dragged down by its own text. This is the number the
   * camera's own metering gets wrong: it averages the whole desk, so a small
   * bright page on a large dark mat comes out murky.
   */
  function measurePageLevel() {
    const v = el.video;
    if (!v || !v.videoWidth) return 0;
    const c = Imaging.ctx2d(levelCanvas);
    c.drawImage(v, 0, 0, 160, 120);
    const d = c.getImageData(0, 0, 160, 120).data;
    const q = state.liveQuad;
    const hist = new Int32Array(256);
    let n = 0;
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 160; x++) {
        const nx = (x + 0.5) / 160, ny = (y + 0.5) / 120;
        if (q ? !insideQuad(q, nx, ny)
              : (nx < 0.25 || nx > 0.75 || ny < 0.25 || ny > 0.75)) continue;
        const p = (y * 160 + x) * 4;
        hist[Math.min(255, (d[p] * 0.2126 + d[p + 1] * 0.7152 + d[p + 2] * 0.0722) | 0)]++;
        n++;
      }
    }
    if (!n) return 0;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.9) return i; }
    return 255;
  }

  /** What a capture will actually produce, before and after the crop. */
  function updateCaptureInfo() {
    const st = Camera.settings();
    if (!st || !st.width) {
      el.photoInfo.textContent = '—'; el.cropInfo.textContent = '—';
      return;
    }
    const bigger = Camera.photoIsBigger();
    el.photoInfo.textContent = !Camera.photoMax ? 'not offered'
      : Camera.photoMax.w + '×' + Camera.photoMax.h + (bigger ? '' : ' (no bigger)');

    const usePhoto = state.settings.photoCapture && bigger;
    const src = usePhoto ? Camera.photoMax : { w: st.width, h: st.height };
    const q = state.liveQuad;
    const out = q ? Geom.outputSize(q, src.w, src.h) : { w: src.w, h: src.h };
    // rough dpi if that crop is an A4 sheet — the number that decides whether
    // small print will survive
    const dpi = Math.round(Math.max(out.w, out.h) / 11.69);
    el.cropInfo.textContent = src.w + '×' + src.h + ' → ' + out.w + '×' + out.h +
                              (q ? '  ≈' + dpi + ' dpi' : '');
  }



  async function nudgeExposure(dir) {
    if (!Camera.running()) { U.toast('Start the camera first'); return; }
    const r = await Camera.nudgeExposure(dir);
    if (!r) {
      U.toast('This camera exposes no exposure control to the browser — raise Preview brightness, or add light', 'bad', 5000);
      return;
    }
    el.expWhat.textContent = r.label;
    el.expValue.textContent = fmtNum(r.value) + (r.max ? ' / ' + fmtNum(r.max) : '');
    buildCapControls();
  }
  el.expUp.addEventListener('click', () => nudgeExposure(1));
  el.expDown.addEventListener('click', () => nudgeExposure(-1));

  el.expAuto.addEventListener('click', async () => {
    if (!Camera.running()) { U.toast('Start the camera first'); return; }
    el.expAuto.disabled = true;
    const label = el.expAuto.textContent;
    const before = measurePageLevel();
    try {
      const r = await Camera.autoExpose(measurePageLevel, {
        onStep: (i, level) => {
          el.pageLevel.textContent = Math.round(level) + ' / 255';
          el.expAuto.textContent = 'Levelling… ' + Math.round(level);
        }
      });
      if (!r) {
        U.toast('This camera exposes no exposure control to the browser — add light, or raise Preview brightness', 'bad', 6000);
        return;
      }
      el.expWhat.textContent = r.label;
      el.expValue.textContent = fmtNum(r.value);
      el.pageLevel.textContent = Math.round(r.level) + ' / 255';
      buildCapControls();
      U.toast((r.settled ? 'Levelled' : 'At this camera\'s limit') +
              ' — page ' + Math.round(before) + ' → ' + Math.round(r.level) + ' / 255',
              r.settled ? 'good' : '', 5000);
    } finally {
      el.expAuto.disabled = false;
      el.expAuto.textContent = label;
    }
  });

  el.btnRefocus.addEventListener('click', async () => {
    if (!Camera.running()) { U.toast('Start the camera first'); return; }
    const ok = await Camera.refocus();
    U.toast(ok ? 'Refocusing…' : 'This camera exposes no focus control to the browser',
            ok ? 'good' : 'bad', ok ? 2000 : 5000);
    setTimeout(buildCapControls, 600);
  });

  function applyPreviewGain() {
    const g = state.settings.previewGain || 1;
    el.video.style.filter = g > 1.001 ? 'brightness(' + g.toFixed(2) + ')' : '';
  }

  /* ── live detection + motion + auto capture ─────────────────── */

  let lastAutoShot = 0, sceneDirty = false, stillFrom = 0, intervalTimer = 0;

  Camera.onMotion = function (m) {
    const thr = 0.06 + (0.004 - 0.06) * (state.settings.sens / 100);
    const pct = Math.min(100, (m / 0.12) * 100);
    el.motionFill.style.width = pct.toFixed(0) + '%';
    el.motionFill.classList.toggle('still', m < thr);
    el.motionLbl.textContent = m < thr ? 'still' : 'moving';

    if (m >= thr) { sceneDirty = true; stillFrom = 0; return; }
    if (!sceneDirty) return;
    if (!stillFrom) { stillFrom = Date.now(); return; }

    const now = Date.now();
    if (state.settings.autoCap && Camera.running() &&
        now - stillFrom >= state.settings.dwell * 1000 &&
        now - lastAutoShot > 1400) {
      lastAutoShot = now;
      sceneDirty = false; stillFrom = 0;
      capture();
    }
  };

  /* The outline is redetected a couple of times a second, and the raw result
     shifts by a pixel or two even on a motionless page. Ease towards each new
     reading, but snap when the page has genuinely moved — otherwise turning a
     page would show the outline crawling across to the new one. A few missed
     frames hold the last outline rather than blinking it away, which is what
     made it look like it was jumping. */
  const live = { quad: null, miss: 0 };

  function updateLiveQuad(q) {
    if (!q) {
      if (++live.miss > 3) live.quad = null;
      return;
    }
    live.miss = 0;
    if (!live.quad) { live.quad = q; return; }
    let moved = 0;
    for (let i = 0; i < 4; i++) {
      moved = Math.max(moved, Math.hypot(q[i].x - live.quad[i].x, q[i].y - live.quad[i].y));
    }
    const a = moved > 0.05 ? 1 : 0.4;
    live.quad = live.quad.map((p, i) => ({
      x: p.x + (q[i].x - p.x) * a,
      y: p.y + (q[i].y - p.y) * a
    }));
  }

  setInterval(() => {
    if (!Camera.running() || state.mode !== 'live') return;
    if (!state.settings.liveDetect) { state.liveQuad = null; live.quad = null; return; }
    if (!el.video.videoWidth) return;
    try {
      updateLiveQuad(Geom.detect(el.video, { sticky: true }));
    } catch (e) { live.quad = null; }
    state.liveQuad = live.quad;
    updateCaptureInfo();
    el.pageLevel.textContent = Math.round(measurePageLevel()) + ' / 255';
    el.stageHint.textContent = state.liveQuad
      ? 'page found' + (state.settings.autoCap ? ' · auto-capture armed' : '')
      : 'no page outline — the whole frame will be captured';
    drawOverlay();
  }, 420);

  function setIntervalCapture(on) {
    clearInterval(intervalTimer);
    intervalTimer = 0;
    if (on) intervalTimer = setInterval(() => { if (Camera.running()) capture(); }, state.settings.interval * 1000);
  }

  /* ── capture ────────────────────────────────────────────────── */

  async function capture() {
    if (!Camera.running()) { U.toast('Start the camera first'); return; }
    const shot = await Camera.grab(state.settings.mirror,
                                   state.settings.photoCapture && Camera.photoIsBigger());
    if (!shot) return;
    el.shutter.classList.remove('flash');
    void el.shutter.offsetWidth;
    el.shutter.classList.add('flash');
    if (state.settings.beep) U.beep(1100, 70);
    await addPage(shot, { quad: state.settings.liveDetect ? state.liveQuad : null });
  }

  el.btnCapture.addEventListener('click', capture);

  el.btnImport.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const files = Array.from(el.fileInput.files || []);
    el.fileInput.value = '';
    for (const f of files) {
      try {
        const bmp = await decode(f);
        const c = U.canvas(bmp.width, bmp.height);
        Imaging.ctx2d(c).drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        await addPage(c, { inheritAdjust: false });
      } catch (e) { U.toast('Could not read ' + f.name, 'bad'); }
    }
    if (files.length) U.toast(files.length + ' image' + (files.length > 1 ? 's' : '') + ' imported', 'good');
  });

  ['dragover', 'drop'].forEach((ev) => {
    el.stageView.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev !== 'drop') return;
      const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      el.fileInput.files = dt.files;
      el.fileInput.dispatchEvent(new Event('change'));
    });
  });

  el.btnClearAll.addEventListener('click', () => {
    if (!state.pages.length) return;
    if (!confirm('Delete all ' + state.pages.length + ' pages?')) return;
    state.pages.forEach((p) => dropCaches(p.id));
    state.pages = [];
    state.current = -1;
    Store.clearPages().catch(() => {});
    renderTray(); updateCounts(); setMode('live');
  });

  /* ── stage buttons ──────────────────────────────────────────── */

  el.modeLive.addEventListener('click', () => setMode('live'));
  el.modeEdit.addEventListener('click', () => setMode('edit'));

  el.btnCorners.addEventListener('click', () => {
    if (!cur()) return;
    setMode('edit');
    state.cornerMode = !state.cornerMode;
    el.btnCorners.classList.toggle('is-on', state.cornerMode);
    if (!state.cornerMode) refreshThumbSoon();
    renderStage();
  });

  el.btnDetect.addEventListener('click', async () => {
    const page = cur();
    if (!page) { U.toast('No page selected'); return; }
    const src = await getPreviewCanvas(page);
    const q = Geom.detect(src);
    if (q) { page.corners = q; U.toast('Page edges detected', 'good'); }
    else { page.corners = null; U.toast('No page edge found — using the full frame'); }
    persistPage(page);
    refreshThumbSoon();
    renderStage();
  });

  let compareHeld = false;
  function setCompare(on) {
    if (compareHeld === on) return;
    compareHeld = on; state.compare = on;
    el.btnCompare.classList.toggle('is-on', on);
    renderStage();
  }
  el.btnCompare.addEventListener('pointerdown', () => setCompare(true));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((e) => el.btnCompare.addEventListener(e, () => setCompare(false)));

  function zoomBy(f) {
    const box = el.stageView.getBoundingClientRect();
    const natW = state.mode === 'live' ? (el.video.videoWidth || 1) : el.stageCanvas.width;
    const natH = state.mode === 'live' ? (el.video.videoHeight || 1) : el.stageCanvas.height;
    const fit = Math.min((box.width - 36) / natW, (box.height - 36) / natH);
    const now = state.zoom > 0 ? state.zoom : fit;
    state.zoom = U.clamp(now * f, fit * 0.5, 8);
    renderStage();
  }
  el.btnZoomIn.addEventListener('click', () => zoomBy(1.25));
  el.btnZoomOut.addEventListener('click', () => zoomBy(0.8));
  el.btnFit.addEventListener('click', () => { state.zoom = 0; renderStage(); });

  /* ── adjust pane ────────────────────────────────────────────── */

  const ADJUST_KEYS = ['straighten', 'flatten', 'temp', 'tint', 'exposure', 'contrast', 'gamma',
                       'highlights', 'shadows', 'saturation', 'vibrance', 'denoise', 'sharpen',
                       'threshold', 'window'];

  const FMT = { gamma: (v) => v.toFixed(2), straighten: (v) => v.toFixed(1) };

  function ctlOf(pane, key) { return $('[data-pane="' + pane + '"] .ctl[data-k="' + key + '"]'); }

  ADJUST_KEYS.forEach((key) => {
    const box = ctlOf('adjust', key);
    if (!box) return;
    const input = box.querySelector('input'), out = box.querySelector('output'), rst = box.querySelector('.rst');
    input.addEventListener('input', () => {
      const page = cur();
      if (!page) return;
      const v = parseFloat(input.value);
      page.adjust[key] = v;
      page.adjust.filter = 'custom';
      out.textContent = (FMT[key] || String)(v);
      markDirty(box, key, v);
      syncFilterButtons();
      renderStage();
      refreshThumbSoon();
      persistPageSoon(page);
    });
    if (rst) rst.addEventListener('click', () => {
      const page = cur();
      if (!page) return;
      const preset = Imaging.FILTERS[page.adjust.filter] || Imaging.DEFAULTS;
      const v = preset[key] !== undefined ? preset[key] : Imaging.DEFAULTS[key];
      page.adjust[key] = v;
      syncAdjustUI();
      renderStage(); refreshThumbSoon(); persistPageSoon(page);
    });
  });

  function markDirty(box, key, v) {
    box.classList.toggle('is-dirty', Math.abs(v - (Imaging.DEFAULTS[key] || 0)) > 1e-9);
  }

  el.filters.addEventListener('click', (e) => {
    const b = e.target.closest('.fbtn');
    if (!b) return;
    const page = cur();
    if (!page) { U.toast('Select a page first'); return; }
    Imaging.setFilter(page.adjust, b.dataset.filter);
    syncAdjustUI();
    renderStage(); refreshThumbSoon(); persistPage(page);
  });

  el.wbSel.addEventListener('change', () => {
    const p = cur(); if (!p) return;
    p.adjust.wb = el.wbSel.value; renderStage(); refreshThumbSoon(); persistPageSoon(p);
  });
  el.invertChk.addEventListener('change', () => {
    const p = cur(); if (!p) return;
    p.adjust.invert = el.invertChk.checked; renderStage(); refreshThumbSoon(); persistPageSoon(p);
  });
  el.outSize.addEventListener('change', () => {
    const p = cur(); if (!p) return;
    p.adjust.outSize = el.outSize.value; renderStage(); persistPageSoon(p);
  });

  function rotate(delta) {
    const p = cur(); if (!p) return;
    p.adjust.rotate = ((p.adjust.rotate + delta) % 360 + 360) % 360;
    renderStage(); refreshThumbSoon(); persistPageSoon(p);
  }
  el.rotL.addEventListener('click', () => rotate(-90));
  el.rotR.addEventListener('click', () => rotate(90));
  el.flipH.addEventListener('click', () => { const p = cur(); if (!p) return; p.adjust.flipH = !p.adjust.flipH; renderStage(); refreshThumbSoon(); persistPageSoon(p); });
  el.flipV.addEventListener('click', () => { const p = cur(); if (!p) return; p.adjust.flipV = !p.adjust.flipV; renderStage(); refreshThumbSoon(); persistPageSoon(p); });

  el.btnResetAdjust.addEventListener('click', () => {
    const p = cur(); if (!p) return;
    p.adjust = Imaging.newAdjust();
    syncAdjustUI(); renderStage(); refreshThumbSoon(); persistPage(p);
    U.toast('Adjustments reset');
  });

  el.btnApplyAll.addEventListener('click', () => {
    const p = cur(); if (!p) return;
    let n = 0;
    state.pages.forEach((q) => {
      if (q === p) return;
      q.adjust = Object.assign({}, p.adjust, {
        rotate: q.adjust.rotate, flipH: q.adjust.flipH, flipV: q.adjust.flipV, straighten: q.adjust.straighten
      });
      persistPage(q); n++;
      refreshThumb(q);
    });
    U.toast('Applied to ' + n + ' other page' + (n === 1 ? '' : 's'), 'good');
  });

  function syncAdjustUI() {
    const p = cur();
    const a = p ? p.adjust : Imaging.newAdjust();
    ADJUST_KEYS.forEach((key) => {
      const box = ctlOf('adjust', key);
      if (!box) return;
      const input = box.querySelector('input'), out = box.querySelector('output');
      const v = a[key] != null ? a[key] : Imaging.DEFAULTS[key];
      input.value = v;
      out.textContent = (FMT[key] || String)(v);
      markDirty(box, key, v);
    });
    el.wbSel.value = a.wb;
    el.invertChk.checked = !!a.invert;
    el.outSize.value = a.outSize;
    syncFilterButtons();
  }

  function syncFilterButtons() {
    // With no page selected the sliders show the defaults, so highlight the
    // filter those defaults came from rather than leaving the row blank.
    const a = cur() ? cur().adjust : Imaging.newAdjust();
    $$('.fbtn', el.filters).forEach((b) => b.classList.toggle('is-on', b.dataset.filter === a.filter));
  }

  /* ── OCR ────────────────────────────────────────────────────── */

  function initOcrUI() {
    el.ocrLang.innerHTML = OCR.LANGS.map(([code, name]) =>
      '<option value="' + code + '">' + name + ' (' + code + ')' +
      (OCR.BUNDLED.indexOf(code) < 0 ? ' — downloads' : '') + '</option>').join('');
    el.ocrLang.value = state.settings.lang;
    el.ocrPsm.value = state.settings.psm;
    if (!OCR.available()) {
      el.ocrStatus.textContent = 'engine not loaded';
      el.btnOcrPage.disabled = el.btnOcrAll.disabled = true;
    }
  }

  function syncOcrUI() {
    const p = cur();
    el.ocrText.value = p && p.ocr ? p.ocr.text : '';
    el.ocrConf.textContent = p && p.ocr && p.ocr.confidence != null
      ? Math.round(p.ocr.confidence) + '% conf' : '—';
    el.ocrStatus.textContent = p && p.ocr ? 'done' : 'idle';
    el.ocrFill.style.width = p && p.ocr ? '100%' : '0%';
  }

  async function runOcr(page) {
    if (!page) return;
    el.btnOcrPage.disabled = el.btnOcrAll.disabled = true;
    el.btnOcrCancel.disabled = false;
    try {
      const src = await getFullCanvas(page);
      const img = Imaging.pipeline(src, page.adjust, page.corners, OCR_MAX);
      const res = await OCR.recognize(img, {
        lang: el.ocrLang.value,
        psm: el.ocrPsm.value,
        onProgress: (status, prog) => {
          el.ocrStatus.textContent = status || 'working';
          el.ocrFill.style.width = Math.round(prog * 100) + '%';
        }
      });
      page.ocr = {
        text: res.text, confidence: res.confidence, words: res.words,
        lang: el.ocrLang.value, imgW: img.width, imgH: img.height
      };
      persistPage(page);
      if (page === cur()) { syncOcrUI(); renderStage(); }
      renderTray();
      el.ocrStatus.textContent = 'done';
      el.ocrFill.style.width = '100%';
      return res;
    } catch (err) {
      if (String(err && err.message) === 'cancelled') { el.ocrStatus.textContent = 'cancelled'; return; }
      el.ocrStatus.textContent = 'failed';
      U.toast('OCR failed: ' + (err && err.message ? err.message : err), 'bad', 6000);
    } finally {
      el.btnOcrPage.disabled = el.btnOcrAll.disabled = false;
      el.btnOcrCancel.disabled = true;
    }
  }

  el.btnOcrPage.addEventListener('click', () => {
    const p = cur();
    if (!p) { U.toast('No page selected'); return; }
    runOcr(p);
  });

  el.btnOcrAll.addEventListener('click', async () => {
    if (!state.pages.length) return;
    for (let i = 0; i < state.pages.length; i++) {
      el.ocrStatus.textContent = 'page ' + (i + 1) + '/' + state.pages.length;
      const r = await runOcr(state.pages[i]);
      if (!r) break;
    }
    U.toast('Batch OCR finished', 'good');
  });

  el.btnOcrCancel.addEventListener('click', () => { OCR.cancel(); el.btnOcrCancel.disabled = true; });

  el.ocrText.addEventListener('input', () => {
    const p = cur();
    if (!p) return;
    if (!p.ocr) p.ocr = { text: '', confidence: null, words: [], imgW: 1, imgH: 1 };
    p.ocr.text = el.ocrText.value;
    persistPageSoon(p);
  });

  el.showBoxes.addEventListener('change', () => {
    state.settings.showBoxes = el.showBoxes.checked; saveSettings(); renderStage();
  });

  el.btnCopyText.addEventListener('click', async () => {
    const t = el.ocrText.value;
    if (!t) { U.toast('No text to copy'); return; }
    try { await navigator.clipboard.writeText(t); U.toast('Text copied', 'good'); }
    catch (e) { U.toast('Clipboard blocked by the browser', 'bad'); }
  });

  el.btnSaveText.addEventListener('click', () => {
    const t = el.ocrText.value;
    if (!t) { U.toast('No text to save'); return; }
    U.download(new Blob([t], { type: 'text/plain' }), 'scan-' + U.stamp() + '.txt');
  });

  el.btnExportTextAll.addEventListener('click', () => {
    const parts = state.pages.map((p, i) => '── page ' + (i + 1) + ' ──\n' + ((p.ocr && p.ocr.text) || ''));
    const txt = parts.join('\n\n');
    if (!txt.trim().replace(/── page \d+ ──/g, '')) { U.toast('No OCR text yet — run "Read all" first'); return; }
    U.download(new Blob([txt], { type: 'text/plain' }), 'scan-' + U.stamp() + '.txt');
  });

  /* ── export ─────────────────────────────────────────────────── */

  async function renderFull(page) {
    const src = await getFullCanvas(page);
    return Imaging.pipeline(src, page.adjust, page.corners, Infinity);
  }

  el.btnExportImage.addEventListener('click', async () => {
    const p = cur();
    if (!p) { U.toast('No page selected'); return; }
    el.btnExportImage.disabled = true;
    try {
      U.toast('Rendering at full resolution…');
      const out = await renderFull(p);
      const type = el.expFormat.value;
      const q = state.settings.expQuality / 100;
      const blob = await U.canvasToBlob(out, type, type === 'image/png' ? undefined : q);
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      U.download(blob, 'scan-' + U.stamp() + '-p' + (state.current + 1) + '.' + ext);
      U.toast('Saved ' + out.width + '×' + out.height + ' · ' + U.bytes(blob.size), 'good');
    } catch (e) {
      U.toast('Export failed: ' + e.message, 'bad');
    } finally { el.btnExportImage.disabled = false; }
  });

  el.btnCopyClip.addEventListener('click', async () => {
    const p = cur();
    if (!p) return;
    try {
      const out = await renderFull(p);
      const blob = await U.canvasToBlob(out, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      U.toast('Image copied to the clipboard', 'good');
    } catch (e) {
      U.toast('Clipboard image copy is not available in this browser', 'bad');
    }
  });

  el.btnExportPdf.addEventListener('click', async () => {
    const list = el.pdfAllPages.checked ? state.pages : (cur() ? [cur()] : []);
    if (!list.length) { U.toast('No pages to export'); return; }
    el.btnExportPdf.disabled = true;
    try {
      const q = state.settings.pdfQuality / 100;
      const out = [];
      for (let i = 0; i < list.length; i++) {
        el.btnExportPdf.textContent = 'Rendering ' + (i + 1) + '/' + list.length + '…';
        await new Promise((r) => setTimeout(r, 0));      // let the label paint
        const canvas = await renderFull(list[i]);
        const jpeg = await U.blobToBytes(await U.canvasToBlob(canvas, 'image/jpeg', q));
        const rec = { jpeg: jpeg, width: canvas.width, height: canvas.height };
        const o = list[i].ocr;
        if (el.pdfSearchable.checked && o && o.words && o.words.length) {
          const kx = canvas.width / o.imgW, ky = canvas.height / o.imgH;
          rec.words = o.words.map((w) => ({
            text: w.text, x0: w.x0 * kx, y0: w.y0 * ky, x1: w.x1 * kx, y1: w.y1 * ky
          }));
        }
        out.push(rec);
      }
      const blob = PDF.build(out, {
        pageSize: el.pdfPageSize.value,
        title: 'Scan ' + U.stamp(),
        searchable: el.pdfSearchable.checked
      });
      U.download(blob, 'scan-' + U.stamp() + '.pdf');
      const withText = out.filter((r) => r.words && r.words.length).length;
      U.toast('PDF saved · ' + out.length + ' page' + (out.length > 1 ? 's' : '') +
              ' · ' + U.bytes(blob.size) + (withText ? ' · ' + withText + ' searchable' : ''), 'good', 4200);
    } catch (e) {
      U.toast('PDF export failed: ' + e.message, 'bad', 6000);
    } finally {
      el.btnExportPdf.disabled = false;
      el.btnExportPdf.textContent = 'Save PDF';
    }
  });

  el.btnPrint.addEventListener('click', async () => {
    const list = state.pages.length ? state.pages : [];
    if (!list.length) { U.toast('Nothing to print'); return; }
    U.toast('Preparing print view…');
    const urls = [];
    for (const p of list) {
      const c = await renderFull(p);
      urls.push(Imaging.fit(c, 2000).toDataURL('image/jpeg', 0.9));
    }
    const w = window.open('', '_blank');
    if (!w) { U.toast('Pop-up blocked — allow pop-ups to print', 'bad'); return; }
    w.document.write('<!doctype html><title>Scan</title><style>' +
      'html,body{margin:0;background:#fff}img{display:block;width:100%;page-break-after:always}' +
      '@page{margin:8mm}</style>' +
      urls.map((u) => '<img src="' + u + '">').join('') +
      '<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>');
    w.document.close();
  });

  el.btnEstimate.addEventListener('click', async () => {
    const p = cur();
    if (!p) { U.toast('No page selected'); return; }
    el.btnEstimate.disabled = true;
    try {
      const out = await renderFull(p);
      const type = el.expFormat.value;
      const blob = await U.canvasToBlob(out, type, type === 'image/png' ? undefined : state.settings.expQuality / 100);
      el.estDims.textContent = out.width + '×' + out.height;
      el.estSize.textContent = U.bytes(blob.size) + ' (' + type.split('/')[1] + ')';
    } finally { el.btnEstimate.disabled = false; }
  });

  /* ── settings bindings ──────────────────────────────────────── */

  function bindSetting(node, key, prop, after) {
    if (!node) return;
    const ev = prop === 'checked' ? 'change' : 'change';
    node.addEventListener(ev, () => {
      state.settings[key] = node[prop];
      saveSettings();
      if (after) after();
    });
  }

  bindSetting(el.autoCapChk, 'autoCap', 'checked', () => {
    el.btnAutoCap.classList.toggle('is-on', state.settings.autoCap);
    renderStage();
  });
  bindSetting(el.beepChk, 'beep', 'checked');
  bindSetting(el.photoChk, 'photoCapture', 'checked', updateCaptureInfo);
  bindSetting(el.guideGrid, 'grid', 'checked', drawOverlay);
  bindSetting(el.guideCross, 'cross', 'checked', drawOverlay);
  bindSetting(el.guideDetect, 'liveDetect', 'checked', drawOverlay);
  bindSetting(el.mirrorChk, 'mirror', 'checked', renderStage);
  bindSetting(el.guideAspect, 'aspect', 'value', drawOverlay);
  bindSetting(el.autoDetectChk, 'autoDetect', 'checked');
  bindSetting(el.autoSelectChk, 'autoSelect', 'checked');
  bindSetting(el.ocrLang, 'lang', 'value');
  bindSetting(el.ocrPsm, 'psm', 'value');
  bindSetting(el.expFormat, 'format', 'value');
  bindSetting(el.pdfPageSize, 'pdfSize', 'value');
  bindSetting(el.pdfSearchable, 'searchable', 'checked');
  bindSetting(el.pdfAllPages, 'allPages', 'checked');

  el.intervalChk.addEventListener('change', () => {
    state.settings.interval_on = el.intervalChk.checked;
    setIntervalCapture(el.intervalChk.checked);
    saveSettings();
  });

  el.btnAutoCap.addEventListener('click', () => {
    state.settings.autoCap = !state.settings.autoCap;
    el.autoCapChk.checked = state.settings.autoCap;
    el.btnAutoCap.classList.toggle('is-on', state.settings.autoCap);
    saveSettings();
    renderStage();
    U.toast(state.settings.autoCap ? 'Auto-capture armed' : 'Auto-capture off');
  });

  const SETTING_SLIDERS = [
    ['capture', 'dwell', (v) => v.toFixed(1)],
    ['capture', 'sens', String],
    ['capture', 'interval', String],
    ['capture', 'previewGain', (v) => v.toFixed(1)],
    ['export', 'expQuality', String],
    ['export', 'pdfQuality', String]
  ];

  SETTING_SLIDERS.forEach(([pane, key, fmt]) => {
    const box = ctlOf(pane, key);
    if (!box) return;
    const input = box.querySelector('input'), out = box.querySelector('output');
    input.addEventListener('input', () => {
      state.settings[key] = parseFloat(input.value);
      out.textContent = fmt(state.settings[key]);
      if (key === 'interval' && state.settings.interval_on) setIntervalCapture(true);
      if (key === 'previewGain') applyPreviewGain();
      saveSettings();
    });
  });

  function saveSettings() { Store.pref('settings', state.settings); }

  function loadSettings() {
    const s = Store.pref('settings');
    if (s) Object.assign(state.settings, s);
    const st = state.settings;
    el.resSel.value = st.res || 'auto';
    el.autoCapChk.checked = st.autoCap;
    el.btnAutoCap.classList.toggle('is-on', st.autoCap);
    el.beepChk.checked = st.beep;
    el.photoChk.checked = st.photoCapture !== false;
    el.intervalChk.checked = st.interval_on;
    el.guideGrid.checked = st.grid; el.guideCross.checked = st.cross;
    el.guideDetect.checked = st.liveDetect; el.mirrorChk.checked = st.mirror;
    el.guideAspect.value = st.aspect || '';
    el.autoDetectChk.checked = st.autoDetect; el.autoSelectChk.checked = st.autoSelect;
    el.showBoxes.checked = st.showBoxes;
    el.expFormat.value = st.format; el.pdfPageSize.value = st.pdfSize;
    el.pdfSearchable.checked = st.searchable; el.pdfAllPages.checked = st.allPages;
    SETTING_SLIDERS.forEach(([pane, key, fmt]) => {
      const box = ctlOf(pane, key);
      if (!box) return;
      box.querySelector('input').value = st[key];
      box.querySelector('output').textContent = fmt(st[key]);
    });
    applyPreviewGain();
    if (st.interval_on) setIntervalCapture(true);
  }

  /* ── persistence ────────────────────────────────────────────── */

  function persistPage(page) {
    if (!page || !Store.available()) return;
    Store.putPage({
      id: page.id, order: state.pages.indexOf(page),
      blob: page.blob, w: page.w, h: page.h,
      corners: page.corners, adjust: page.adjust,
      ocr: page.ocr, thumb: page.thumb
    }).catch(() => {});
  }
  const persistPageSoon = debounce((p) => persistPage(p), 700);

  async function restorePages() {
    if (!Store.available()) return;
    try {
      // Private browsing, a locked profile or a blocked upgrade can leave an
      // IndexedDB open() hanging forever rather than erroring. Restoring the
      // last session is a convenience; never let it strand the app.
      const rows = await Promise.race([
        Store.allPages(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('storage timeout')), 4000))
      ]);
      if (!rows.length) return;
      rows.forEach((r) => {
        state.pages.push({
          id: r.id, blob: r.blob, w: r.w, h: r.h,
          corners: r.corners || null,
          adjust: Object.assign(Imaging.newAdjust(), r.adjust || {}),
          ocr: r.ocr || null, thumb: r.thumb || null
        });
      });
      state.current = 0;
      renderTray(); updateCounts(); syncAdjustUI(); syncOcrUI(); renderStage();
      U.toast('Restored ' + rows.length + ' page' + (rows.length > 1 ? 's' : '') + ' from the last session');
    } catch (e) { /* a fresh session is a fine fallback */ }
  }

  /* ── tabs, help, keyboard ───────────────────────────────────── */

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('is-on', x === t));
    $$('.pane').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === t.dataset.tab));
  }));

  function showHelp(on) { el.helpModal.hidden = !on; }
  el.btnHelp.addEventListener('click', () => showHelp(true));
  el.btnHelpClose.addEventListener('click', () => showHelp(false));
  el.helpModal.addEventListener('click', (e) => { if (e.target === el.helpModal) showHelp(false); });

  const FILTER_ORDER = ['original', 'auto', 'color', 'gray', 'bw', 'whiteboard', 'ink', 'photo'];

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key;
    if (k === 'Escape') { showHelp(false); if (state.cornerMode) el.btnCorners.click(); return; }
    if (k === '?' ) { showHelp(el.helpModal.hidden); e.preventDefault(); return; }
    if (k === ' ') { e.preventDefault(); capture(); return; }
    if (k === 'a' || k === 'A') { el.btnAutoCap.click(); return; }
    if (k === 'c' || k === 'C') { el.btnCorners.click(); return; }
    if (k === 'd' || k === 'D') { el.btnDetect.click(); return; }
    if (k === 'l' || k === 'L') { setMode('live'); return; }
    if (k === 'e' || k === 'E') { setMode('edit'); return; }
    if (k === 'r' || k === 'R') { el.btnOcrPage.click(); return; }
    if (k === 'b' || k === 'B') { if (!e.repeat) setCompare(true); return; }
    if (k === '.' || k === '>') { nudgeExposure(1); return; }
    if (k === ',' || k === '<') { nudgeExposure(-1); return; }
    if (k === '[') { rotate(-90); return; }
    if (k === ']') { rotate(90); return; }
    if (k === '0') { state.zoom = 0; renderStage(); return; }
    if (k === '+' || k === '=') { zoomBy(1.25); return; }
    if (k === '-') { zoomBy(0.8); return; }
    if (k === 'ArrowLeft') { if (state.current > 0) selectPage(state.current - 1, true); return; }
    if (k === 'ArrowRight') { if (state.current < state.pages.length - 1) selectPage(state.current + 1, true); return; }
    if (k === 'Delete' || k === 'Backspace') { if (state.current >= 0) { e.preventDefault(); deletePage(state.current); } return; }
    if (k >= '1' && k <= '8') {
      const f = FILTER_ORDER[parseInt(k, 10) - 1];
      const b = el.filters.querySelector('.fbtn[data-filter="' + f + '"]');
      if (b) b.click();
    }
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'b' || e.key === 'B') setCompare(false); });

  window.addEventListener('resize', U.rafThrottle(() => renderStage()));
  el.video.addEventListener('loadedmetadata', () => renderStage());

  window.addEventListener('beforeunload', (e) => {
    if (state.pages.length && !Store.available()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ── boot ───────────────────────────────────────────────────── */

  (async function init() {
    loadSettings();
    initOcrUI();
    syncAdjustUI();
    updateCounts();
    await renderStageNow();      // direct, not rAF-throttled: paint before the first frame
    restorePages();              // deliberately not awaited — see restorePages()

    if (Camera.supported()) {
      refreshDevices();
      if (navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      }
    } else {
      el.camStatus.textContent = 'unavailable';
      el.camStatus.className = 'chip chip-err';
      U.toast('No camera API here. Serve this folder over http://localhost and reload.', 'bad', 7000);
    }

    if (location.protocol === 'file:') {
      U.toast('Opened from file:// — OCR and Safari camera need http://localhost. See README.', '', 7000);
    }
  })();

  global.ScannerApp = { state: state, render: renderStage, addCanvas: addPage };
})(window);
