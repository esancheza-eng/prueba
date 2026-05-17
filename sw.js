/* =====================================================
   SERVICE WORKER — Aqua Luan v3
   ===================================================== */

const CACHE_NAME = 'aqualuan-v5';
const ASSETS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&display=swap'
];

// ── INSTALL ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH ────────────────────────────────────────────
self.addEventListener('fetch', e => {
  // NUNCA interceptar peticiones a Google Scripts
  if (e.request.url.includes('script.google.com')) return;
  if (e.request.url.includes('fonts.googleapis.com')) return;
  if (e.request.url.includes('fonts.gstatic.com')) return;
  if (e.request.url.includes('cdnjs.cloudflare.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

// ── SYNC ─────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-pedidos') {
    e.waitUntil(syncPendientes());
  }
});

// ── MENSAJE desde la página ───────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'MANUAL_SYNC') {
    syncPendientes().then(result => {
      e.source && e.source.postMessage({ type: 'SYNC_RESULT', ...result });
    });
  }
});

// ── SINCRONIZACIÓN ────────────────────────────────────
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxCrz4qJfYqmXltMPWyx-1QubHba964f-gpPrIt5ba1yY_J-6_uvwOZr5ORXa8L0l3G/exec";
const DB_NAME    = 'aqualuan-db';
const STORE      = 'pedidos-pendientes';

function abrirDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function syncPendientes() {
  const db    = await abrirDB();
  const items = await getAllPendientes(db);
  if (!items.length) return { synced: 0, failed: 0 };

  let synced = 0, failed = 0;

  for (const item of items) {
    try {
      await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload)
      });
      await deletePendiente(db, item.id);
      synced++;
    } catch {
      failed++;
    }
  }

  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({
    type: 'SYNC_DONE', synced, failed,
    remaining: items.length - synced
  }));

  return { synced, failed };
}

function getAllPendientes(db) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function deletePendiente(db, id) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}
