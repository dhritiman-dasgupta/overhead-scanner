/* ocr.js — Tesseract WASM wrapper.
 *
 * Everything is served from vendor/ so recognition works offline. Languages
 * other than the bundled `eng` fall back to the CDN, which is the only place
 * in the app that ever touches the network — and only if you ask for one.
 */
(function (global) {
  'use strict';

  const O = {};

  // Resolve vendor/ relative to THIS script, not to the page. The worker fetches
  // these URLs from a blob context where relative paths are meaningless, and
  // deriving them from location.href would break for any page that isn't a
  // sibling of vendor/ — the test pages under test/, for instance.
  const SELF = (document.currentScript && document.currentScript.src) || '';
  const BASE = SELF ? new URL('..', SELF).href : new URL('.', location.href).href;

  const LOCAL = {
    workerPath: BASE + 'vendor/tesseract/worker.min.js',
    corePath:   BASE + 'vendor/tesseract',
    langPath:   BASE + 'vendor/tessdata'
  };
  const CDN_LANG = 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast';

  /** Bundled offline; everything else is fetched on demand. */
  O.BUNDLED = ['eng'];

  O.LANGS = [
    ['eng', 'English'], ['fra', 'French'], ['deu', 'German'], ['spa', 'Spanish'],
    ['ita', 'Italian'], ['por', 'Portuguese'], ['nld', 'Dutch'], ['rus', 'Russian'],
    ['pol', 'Polish'], ['tur', 'Turkish'], ['ara', 'Arabic'], ['hin', 'Hindi'],
    ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi_sim', 'Chinese (simplified)'],
    ['chi_tra', 'Chinese (traditional)'], ['osd', 'Orientation & script only']
  ];

  O.available = () => typeof global.Tesseract !== 'undefined';

  let worker = null;
  let workerLang = null;
  let busy = false;
  let cancelled = false;

  O.busy = () => busy;

  async function getWorker(lang, onStatus) {
    if (worker && workerLang === lang) return worker;
    if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; workerLang = null; }

    const opts = {
      workerPath: LOCAL.workerPath,
      corePath: LOCAL.corePath,
      langPath: O.BUNDLED.indexOf(lang) >= 0 ? LOCAL.langPath : CDN_LANG,
      logger: (m) => {
        if (!onStatus) return;
        onStatus(m.status || '', typeof m.progress === 'number' ? m.progress : 0);
      },
      errorHandler: (e) => console.warn('[ocr]', e)
    };

    worker = await Tesseract.createWorker(lang, 1, opts);
    workerLang = lang;
    return worker;
  }

  /** Flatten v5 block/paragraph/line/word nesting (or v4's flat list). */
  function extractWords(data) {
    if (Array.isArray(data.words) && data.words.length) return normalise(data.words);
    const out = [];
    const blocks = data.blocks || [];
    for (const b of blocks) {
      for (const p of (b.paragraphs || [])) {
        for (const l of (p.lines || [])) {
          for (const w of (l.words || [])) out.push(w);
        }
      }
    }
    return normalise(out);
  }

  function normalise(words) {
    const out = [];
    for (const w of words) {
      const bb = w.bbox || w;
      if (bb.x0 == null) continue;
      out.push({
        text: w.text || '',
        conf: typeof w.confidence === 'number' ? w.confidence : 0,
        x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1
      });
    }
    return out;
  }

  /* ── engines ────────────────────────────────────────────────── */

  O.ENGINES = [
    { id: 'paddle', label: 'PaddleOCR — PP-OCRv4' },
    { id: 'tesseract', label: 'Tesseract' }
  ];

  O.engineAvailable = (id) =>
    id === 'paddle' ? (typeof global.Paddle !== 'undefined' && global.Paddle.available())
                    : O.available();

  /**
   * @param {HTMLCanvasElement} canvas  the PROCESSED page image
   * @param {Object} opts { engine, lang, psm, onProgress(status, 0..1) }
   * @returns {Promise<{text, confidence, words}>}
   */
  O.run = function (canvas, opts) {
    opts = opts || {};
    if (opts.engine === 'paddle') {
      if (!O.engineAvailable('paddle')) {
        throw new Error('PaddleOCR did not load — check vendor/onnx/ and vendor/paddle/');
      }
      return global.Paddle.recognize(canvas, opts);
    }
    return O.recognize(canvas, opts);
  };

  O.cancelAll = async function () {
    if (typeof global.Paddle !== 'undefined') global.Paddle.cancel();
    await O.cancel();
  };

  /* ── Tesseract ──────────────────────────────────────────────── */

  O.recognize = async function (canvas, opts) {
    if (!O.available()) throw new Error('OCR engine did not load — check vendor/tesseract/');
    opts = opts || {};
    const lang = opts.lang || 'eng';
    cancelled = false;
    busy = true;
    try {
      const w = await getWorker(lang, opts.onProgress);
      if (cancelled) throw new Error('cancelled');
      await w.setParameters({
        tessedit_pageseg_mode: String(opts.psm != null ? opts.psm : 3),
        preserve_interword_spaces: '1'
      });
      if (cancelled) throw new Error('cancelled');

      const res = await w.recognize(canvas);
      if (cancelled) throw new Error('cancelled');
      const data = res.data || {};
      return {
        text: (data.text || '').replace(/\n{3,}/g, '\n\n').trimEnd(),
        confidence: typeof data.confidence === 'number' ? data.confidence : null,
        words: extractWords(data)
      };
    } finally {
      busy = false;
    }
  };

  O.cancel = async function () {
    cancelled = true;
    if (worker) {
      try { await worker.terminate(); } catch (e) {}
      worker = null; workerLang = null;
    }
    busy = false;
  };

  global.OCR = O;
})(window);
