/* ═══════════════════════════════════════════════════════════════════════
   AQUA LUAN — Service Worker
   Responsable únicamente de:
   1) Permitir que la app sea instalable como PWA.
   2) Background Sync: cuando vuelve la conexión, reenvía en segundo
      plano los pedidos guardados en IndexedDB (store 'pedidos-pendientes')
      hacia el mismo SCRIPT_URL que usa index.html, sin depender de que
      la persona tenga la app abierta en pantalla.

   IMPORTANTE: este archivo debe ser JavaScript puro. Si el archivo sw.js
   de tu repo contiene HTML, el registro
     navigator.serviceWorker.register('./sw.js')
   falla en silencio y el Background Sync nunca se activa.
   ═══════════════════════════════════════════════════════════════════════ */

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzKcilhv6mJf61EnC1Plows6sPd1DIgirpNoSE5KG751k8LW89l0b8HkTvSot07i9F4/exec";
const DB_NAME    = "aqualuan-db";
const STORE      = "pedidos-pendientes";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ── IndexedDB helpers (misma estructura que usa index.html) ── */
function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function obtenerPendientes(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function eliminarPendiente(db, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function notificarClientes(msg) {
  const listaClientes = await self.clients.matchAll({ includeUncontrolled: true });
  listaClientes.forEach((c) => c.postMessage(msg));
}

/* ── Reenvía todo lo pendiente guardado offline ── */
async function sincronizarPedidosPendientes() {
  let db;
  try {
    db = await abrirDB();
  } catch {
    return;
  }

  const pendientes = await obtenerPendientes(db).catch(() => []);
  if (!pendientes.length) return;

  let synced = 0;
  for (const item of pendientes) {
    try {
      await fetch(SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.payload),
      });
      await eliminarPendiente(db, item.id);
      synced++;
    } catch {
      // Si falla, se queda en IndexedDB y se reintenta en el próximo evento 'sync'
    }
  }

  if (synced > 0) {
    await notificarClientes({ type: "SYNC_DONE", synced });
  }
}

/* ── Background Sync: se dispara automáticamente cuando vuelve la conexión ── */
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-pedidos") {
    event.waitUntil(sincronizarPedidosPendientes());
  }
});

/* ── Permite forzar sincronización manual desde la app si algún navegador
      no soporta Background Sync (ej. Safari/iOS) ── */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "FORCE_SYNC") {
    event.waitUntil(sincronizarPedidosPendientes());
  }
});
