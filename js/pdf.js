/* pdf.js — minimal PDF 1.4 writer.
 *
 * Written by hand rather than pulled from a CDN so that export keeps working
 * with the network off (NFR-2/NFR-4). Embeds each page as a DCTDecode (JPEG)
 * XObject and, when OCR words are supplied, lays invisible Helvetica text
 * (rendering mode 3) over it so the PDF is selectable and searchable.
 */
(function (global) {
  'use strict';

  const PDF = {};

  const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

  /* Helvetica advance widths, /1000 em, for ASCII 32..126. Anything outside
     falls back to 500 — close enough, the text is invisible; only the
     selection rectangles are user-visible. */
  const HELV = [
    278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
    1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
    333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
    556,556,333,500,278,556,500,722,500,500,500,334,260,334,584
  ];

  function widthOf(text, size) {
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      w += (c >= 32 && c <= 126) ? HELV[c - 32] : 500;
    }
    return w * size / 1000;
  }

  /* Map to WinAnsi, dropping what we cannot represent. */
  const WINANSI_EXTRA = {
    0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x2026: 0x85, 0x20AC: 0x80, 0x2122: 0x99
  };

  function pdfString(text) {
    let out = '(';
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (WINANSI_EXTRA[c] !== undefined) c = WINANSI_EXTRA[c];
      if (c > 255) c = 63;                       // '?'
      if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
      else if (c < 32) out += ' ';
      else out += String.fromCharCode(c);
    }
    return out + ')';
  }

  function latin1(str) {
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  }

  function pdfDate(d) {
    const p = (x) => String(x).padStart(2, '0');
    const tz = -d.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
           sign + p(Math.floor(Math.abs(tz) / 60)) + "'" + p(Math.abs(tz) % 60) + "'";
  }

  /**
   * @param {Array} pages  [{ jpeg:Uint8Array, width, height, words?:[{text,x0,y0,x1,y1}] }]
   *                       word coordinates are pixels in the page image.
   * @param {Object} opts  { pageSize:'auto'|'a4'|'letter', title, searchable }
   * @returns {Blob}
   */
  PDF.build = function (pages, opts) {
    opts = opts || {};
    const chunks = [];
    let len = 0;
    const push = (x) => {
      const b = typeof x === 'string' ? latin1(x) : x;
      chunks.push(b); len += b.length;
    };

    const nObjs = 4 + pages.length * 3;
    const offsets = new Array(nObjs + 1).fill(0);
    const begin = (n) => { offsets[n] = len; push(n + ' 0 obj\n'); };
    const end = () => push('endobj\n');

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    // 1 Catalog, 2 Pages, 3 Font, 4 Info, then 3 objects per page from 5.
    const pageObj = (i) => 5 + i * 3;

    begin(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\n');
    end();

    begin(2);
    push('<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
         pages.map((_, i) => pageObj(i) + ' 0 R').join(' ') + '] >>\n');
    end();

    begin(3);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
    end();

    begin(4);
    push('<< /Producer (Overhead Scanner) /Creator (Overhead Scanner) /Title ' +
         pdfString(opts.title || 'Scan') + ' /CreationDate (' + pdfDate(new Date()) + ') >>\n');
    end();

    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      const iw = pg.width, ih = pg.height;

      // Page box
      let pw, ph;
      if (opts.pageSize === 'a4' || opts.pageSize === 'letter') {
        const s = PAGE_SIZES[opts.pageSize];
        const landscape = iw > ih;
        pw = landscape ? s[1] : s[0];
        ph = landscape ? s[0] : s[1];
      } else {
        const long = 841.89;
        if (iw >= ih) { pw = long; ph = long * ih / iw; }
        else { ph = long; pw = long * iw / ih; }
      }

      // Image placement — fit inside, centred.
      const k = Math.min(pw / iw, ph / ih);
      const dw = iw * k, dh = ih * k;
      const ox = (pw - dw) / 2, oy = (ph - dh) / 2;

      let content = 'q\n' +
        dw.toFixed(2) + ' 0 0 ' + dh.toFixed(2) + ' ' + ox.toFixed(2) + ' ' + oy.toFixed(2) + ' cm\n' +
        '/Im0 Do\nQ\n';

      const words = (opts.searchable !== false && pg.words) ? pg.words : null;
      if (words && words.length) {
        const sx = dw / iw, sy = dh / ih;
        let t = 'BT\n3 Tr\n';
        for (const wd of words) {
          const text = (wd.text || '').trim();
          if (!text) continue;
          const bw = (wd.x1 - wd.x0) * sx, bh = (wd.y1 - wd.y0) * sy;
          if (bw <= 0.3 || bh <= 0.3) continue;
          const fs = Math.min(bh * 0.92, 200);
          const natural = widthOf(text, fs);
          if (natural <= 0) continue;
          const tz = Math.max(1, Math.min(3000, (bw / natural) * 100));
          const x = ox + wd.x0 * sx;
          const y = oy + dh - wd.y1 * sy + fs * 0.16;
          t += '/F1 ' + fs.toFixed(2) + ' Tf\n' + tz.toFixed(1) + ' Tz\n' +
               '1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm\n' +
               pdfString(text) + ' Tj\n';
        }
        t += 'ET\n';
        content += t;
      }

      const contentBytes = latin1(content);
      const nPage = pageObj(i), nContent = nPage + 1, nImg = nPage + 2;

      begin(nPage);
      push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw.toFixed(2) + ' ' + ph.toFixed(2) + ']' +
           ' /Resources << /XObject << /Im0 ' + nImg + ' 0 R >> /Font << /F1 3 0 R >> >>' +
           ' /Contents ' + nContent + ' 0 R >>\n');
      end();

      begin(nContent);
      push('<< /Length ' + contentBytes.length + ' >>\nstream\n');
      push(contentBytes);
      push('\nendstream\n');
      end();

      begin(nImg);
      push('<< /Type /XObject /Subtype /Image /Width ' + iw + ' /Height ' + ih +
           ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.jpeg.length + ' >>\nstream\n');
      push(pg.jpeg);
      push('\nendstream\n');
      end();
    }

    const xrefAt = len;
    let xref = 'xref\n0 ' + (nObjs + 1) + '\n0000000000 65535 f \n';
    for (let n = 1; n <= nObjs; n++) {
      xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + (nObjs + 1) + ' /Root 1 0 R /Info 4 0 R >>\n' +
         'startxref\n' + xrefAt + '\n%%EOF\n');

    return new Blob(chunks, { type: 'application/pdf' });
  };

  global.PDF = PDF;
})(window);
