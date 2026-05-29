/* =====================================================
   SERVICE WORKER — Aqua Luan v3.2 Enterprise
   ─────────────────────────────────────────────────────
   Cambios v9 → v10:
   [SW-12] Sync automático limpia localStorage en cliente
   [SW-13] Banner se oculta solo tras sync exitoso
   ===================================================== */

const CACHE_NAME = 'aqualuan-v10';
const ASSETS = [
  './',
  './index.html',
  './dashboard.html',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&display=swap'
];

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzKcilhv6mJf61EnC1Plows6sPd1DIgirpNoSE5KG751k8LW89l0b8HkTvSot07i9F4/exec";

function scriptUrlValida() {
  return typeof SCRIPT_URL === 'string' &&
    SCRIPT_URL.startsWith('https://script.google.com/') &&
    SCRIPT_URL.length > 60;
}

const DB_NAME        = 'aqualuan-db';
const STORE          = 'pedidos-pendientes';
const MAX_REINTENTOS = 3;
const MAX_EDAD_MS    = 7 * 24 * 60 * 60 * 1000;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .catch(err => console.warn('[SW] Cache parcial:', err.message))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('script.google.com'))    return;
  if (url.includes('fonts.googleapis.com')) return;
  if (url.includes('fonts.gstatic.com'))    return;
  if (url.includes('cdnjs.cloudflare.com')) return;
  if (url.includes('drive.google.com'))     return;
  if (url.includes('wa.me'))                return;
  if (e.request.method !== 'GET')           return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(res => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

self.addEventListener('sync', e => {
  if (e.tag === 'sync-pedidos') e.waitUntil(syncPendientes());
});

self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function syncPendientes() {
  if (!scriptUrlValida()) return { synced: 0, failed: 0 };

  let db;
  try { db = await abrirDB(); }
  catch { return { synced: 0, failed: 0 }; }

  const items = await getAllPendientes(db);
  if (!items.length) {
    notificarClientes({ type: 'SYNC_DONE', synced: 0, failed: 0, eliminados: 0, remaining: 0, idsEnviados: [] });
    return { synced: 0, failed: 0 };
  }

  const ahora = Date.now();
  let synced = 0, failed = 0, eliminados = 0;
  const idsEnviados = [];

  for (const item of items) {
    const edad = ahora - new Date(item.fecha || 0).getTime();
    if (edad > MAX_EDAD_MS) {
      await deletePendiente(db, item.id).catch(() => {});
      eliminados++;
      continue;
    }

    const reintentos = item.reintentos || 0;
    if (reintentos >= MAX_REINTENTOS) { failed++; continue; }

    try {
      await fetch(SCRIPT_URL, {
        method:  'POST',
        mode:    'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(item.payload)
      });
      await deletePendiente(db, item.id).catch(() => {});
      idsEnviados.push(item.id);
      synced++;
    } catch {
      await incrementarReintentos(db, item.id, reintentos).catch(() => {});
      failed++;
    }
  }

  notificarClientes({ type: 'SYNC_DONE', synced, failed, eliminados, remaining: items.length - synced - eliminados, idsEnviados });
  return { synced, failed };
}

async function notificarClientes(result) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(result));
}

function abrirDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
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

function incrementarReintentos(db, id, reintentoActual) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (!item) { res(); return; }
      item.reintentos = (reintentoActual || 0) + 1;
      const putReq = store.put(item);
      putReq.onsuccess = () => res();
      putReq.onerror   = e => rej(e.target.error);
    };
    getReq.onerror = e => rej(e.target.error);
  });
}
