/* =====================================================
   SERVICE WORKER — Aqua Luan v3.0 Enterprise
   ─────────────────────────────────────────────────────
   Cambios v7 → v8:
   [SW-01] Versión de caché actualizada a v8
   [SW-02] SCRIPT_URL actualizada al nuevo Apps Script
   [SW-03] Token de sesión incluido en sync offline
   [SW-04] dashboard.html añadido a ASSETS
   [SW-05] Validación de URL del script antes de sync
   [SW-06] Límite de reintentos por item (máx 3)
   [SW-07] Limpieza automática de items muy antiguos (+7d)
   [SW-08] Notificación de resultado mejorada al cliente
   [SW-09] jsPDF añadido a exclusiones de caché
   [SW-10] Manejo de errores más robusto en syncPendientes
   ===================================================== */

const CACHE_NAME = 'aqualuan-v8';
const ASSETS = [
  './',
  './index.html',
  './dashboard.html',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&display=swap'
];

/* [SW-02] URL del Apps Script — actualizar cuando se migre al servidor */
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzKcilhv6mJf61EnC1Plows6sPd1DIgirpNoSE5KG751k8LW89l0b8HkTvSot07i9F4/exec";

/* [SW-05] Verificar que la URL sea válida antes de hacer fetch */
function scriptUrlValida() {
  return typeof SCRIPT_URL === 'string' &&
    SCRIPT_URL.startsWith('https://script.google.com/') &&
    SCRIPT_URL.length > 60;
}

const DB_NAME = 'aqualuan-db';
const STORE   = 'pedidos-pendientes';

/* [SW-06] Máximo de reintentos por item antes de abandonarlo */
const MAX_REINTENTOS = 3;

/* [SW-07] Antigüedad máxima de un item pendiente (7 días en ms) */
const MAX_EDAD_MS = 7 * 24 * 60 * 60 * 1000;

// ── INSTALL ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .catch(err => {
        /* Si una fuente falla, no bloquear la instalación */
        console.warn('[SW] Algunos assets no se pudieron cachear:', err.message);
      })
  );
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Eliminando caché antigua:', k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* [SW-09] Nunca interceptar estas URLs — siempre ir a la red */
  if (url.includes('script.google.com'))    return;
  if (url.includes('fonts.googleapis.com')) return;
  if (url.includes('fonts.gstatic.com'))    return;
  if (url.includes('cdnjs.cloudflare.com')) return;
  if (url.includes('drive.google.com'))     return;
  if (url.includes('wa.me'))               return;

  /* Solo interceptar GET — los POST van siempre a la red */
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request)
        .then(res => {
          /* Solo cachear respuestas válidas y no opacas */
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => {
          /* Offline y no hay caché: devolver index.html como fallback */
          return caches.match('./index.html');
        });
    })
  );
});

// ── SYNC (Background Sync API) ────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-pedidos') {
    e.waitUntil(syncPendientes());
  }
});

// ── MENSAJE desde la página ───────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'MANUAL_SYNC') {
    syncPendientes().then(result => {
      if (e.source) {
        e.source.postMessage({ type: 'SYNC_RESULT', ...result });
      }
    });
  }

  /* [SW-01] Forzar actualización del SW si la página lo solicita */
  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── SINCRONIZACIÓN ────────────────────────────────────
async function syncPendientes() {
  /* [SW-05] No intentar sync si la URL no es válida */
  if (!scriptUrlValida()) {
    console.warn('[SW] SCRIPT_URL no configurada — sync omitido');
    return { synced: 0, failed: 0, omitido: true };
  }

  let db;
  try {
    db = await abrirDB();
  } catch (err) {
    console.error('[SW] No se pudo abrir IndexedDB:', err.message);
    return { synced: 0, failed: 0 };
  }

  const items = await getAllPendientes(db);
  if (!items.length) return { synced: 0, failed: 0 };

  const ahora   = Date.now();
  let synced = 0, failed = 0, eliminados = 0;

  for (const item of items) {
    /* [SW-07] Eliminar items demasiado antiguos sin intentar enviarlos */
    const edad = ahora - new Date(item.fecha || 0).getTime();
    if (edad > MAX_EDAD_MS) {
      await deletePendiente(db, item.id).catch(() => {});
      eliminados++;
      continue;
    }

    /* [SW-06] Respetar el límite de reintentos */
    const reintentos = item.reintentos || 0;
    if (reintentos >= MAX_REINTENTOS) {
      console.warn('[SW] Item superó máximo de reintentos, omitiendo:', item.id);
      failed++;
      continue;
    }

    try {
      await fetch(SCRIPT_URL, {
        method:  'POST',
        mode:    'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(item.payload)
      });
      /* [SW-10] Fetch sin excepción = éxito (modo no-cors devuelve respuesta opaca) */
      await deletePendiente(db, item.id).catch(() => {});
      synced++;
    } catch (err) {
      /* [SW-06] Incrementar contador de reintentos en el item */
      await incrementarReintentos(db, item.id, reintentos).catch(() => {});
      failed++;
    }
  }

  /* [SW-08] Notificar a todos los clientes con resultado detallado */
  const result = {
    type:       'SYNC_DONE',
    synced,
    failed,
    eliminados,
    remaining:  items.length - synced - eliminados,
    timestamp:  new Date().toISOString()
  };

  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(result));

  console.log(`[SW] Sync completado — enviados: ${synced}, fallidos: ${failed}, eliminados: ${eliminados}`);
  return result;
}

// ── INDEXEDDB HELPERS ─────────────────────────────────
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

/* [SW-06] Actualizar contador de reintentos de un item */
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
