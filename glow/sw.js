const CACHE = "glowup-v4";
const ASSETS = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero y, si no hay conexión, caché (funciona offline pero se actualiza sola).
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // No cacheamos peticiones a otros orígenes (modelos de IA, etc.)
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});

/* ---------- IndexedDB mínimo (compartido con la app) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("glowup", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("checks")) db.createObjectStore("checks");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => res(undefined);
  });
}

const DAILY_MSGS = [
  "Tu rutina de hoy te espera. Cada día suma para definir tu rostro.",
  "Constancia sobre intensidad. Haz tu rutina facial y tu cardio de hoy.",
  "Recuerda: agua, postura y mewing. Pequeños hábitos, gran cambio.",
  "2 minutos de ejercicios faciales hoy te acercan a tu potencial.",
  "No falles hoy. Marca tu rutina completada en GlowUp."
];

async function showDaily() {
  const settings = (await kvGet("settings")) || {};
  const profile = (await kvGet("profile")) || {};
  const lastPhoto = settings.lastPhotoTs || 0;
  const days = lastPhoto ? Math.floor((Date.now() - lastPhoto) / 86400000) : 999;
  const name = profile.name ? `, ${profile.name}` : "";

  let title, body;
  if (days >= 7) {
    title = `Foto semanal, toca revisión${name}`;
    body = "Ha pasado una semana. Hazte la foto para ver tu progreso y actualizar tu puntuación.";
  } else {
    title = `GlowUp — Rutina de hoy${name}`;
    // Mensaje "aleatorio" estable por día (sin depender de Math.random en SW)
    body = DAILY_MSGS[(new Date().getDate()) % DAILY_MSGS.length];
  }
  return self.registration.showNotification(title, {
    body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: "glowup-daily",
    renotify: true,
    data: { url: "./" }
  });
}

self.addEventListener("periodicsync", e => {
  if (e.tag === "glowup-daily") e.waitUntil(showDaily());
});

// Permite disparar la notificación manualmente desde la app (fallback / prueba)
self.addEventListener("message", e => {
  if (e.data && e.data.type === "show-daily") e.waitUntil(showDaily());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
