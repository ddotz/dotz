// dotz service worker: app-shell cache for a fast start, and Web Push display. /api (JSON, SSE, files) is never touched,
// the page itself is network-first so an update shows on the next open; the cache only answers when the network fails.
const CACHE = "dotz-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate" || url.pathname === "/") {
    ev.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/", copy)); }
      return res;
    }).catch(() => caches.match("/")));
    return;
  }
  if (SHELL.includes(url.pathname)) ev.respondWith(caches.match(url.pathname).then(hit => hit || fetch(req)));
});

self.addEventListener("push", ev => {
  let m = {};
  try { m = ev.data ? ev.data.json() : {}; } catch { m = { body: ev.data ? ev.data.text() : "" }; }
  ev.waitUntil(self.registration.showNotification(m.title || "dotz", {
    body: m.body || "",
    tag: m.tag || undefined,
    renotify: Boolean(m.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: m.url || "/" },
  }));
});

self.addEventListener("notificationclick", ev => {
  ev.notification.close();
  const url = new URL((ev.notification.data && ev.notification.data.url) || "/", location.origin).href;
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ open: url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
