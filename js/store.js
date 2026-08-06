/* store.js — IndexedDB session persistence, so a reload doesn't lose the batch.
 * Originals are kept as JPEG blobs (q 0.94); full-resolution bitmaps live in
 * memory only for the pages you are actually looking at.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'overhead-scanner';
  const DB_VER = 1;
  const S = {};
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!global.indexedDB) return rej(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }

  S.available = () => !!global.indexedDB;

  S.putPage = (rec) => tx('pages', 'readwrite', (s) => s.put(rec));
  S.deletePage = (id) => tx('pages', 'readwrite', (s) => s.delete(id));
  S.clearPages = () => tx('pages', 'readwrite', (s) => s.clear());

  S.allPages = () => tx('pages', 'readonly', (s) => s.getAll())
    .then((rows) => (rows || []).sort((a, b) => (a.order || 0) - (b.order || 0)));

  S.setMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put({ k: k, v: v }));
  S.getMeta = (k) => tx('meta', 'readonly', (s) => s.get(k)).then((r) => (r ? r.v : undefined));

  /* Small, non-critical UI preferences go to localStorage — synchronous and
     good enough for checkbox state. */
  S.pref = function (key, value) {
    try {
      if (value === undefined) {
        const raw = localStorage.getItem('ohs:' + key);
        return raw === null ? undefined : JSON.parse(raw);
      }
      localStorage.setItem('ohs:' + key, JSON.stringify(value));
    } catch (e) { /* private mode — preferences simply don't persist */ }
  };

  global.Store = S;
})(window);
