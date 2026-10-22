// dotz service worker: app-shell cache for a fast start, and Web Push display. /api (JSON, SSE, files) is never touched.
// The page, script and styles answer from the cache at once (a tapped notification starts the app without waiting for the
// network) and are fetched again in the background. When that fetch brings a changed shell, the open pages get a
// {type:"shell-updated"} message (web/js/23-installable-app-web.js shellUpdated) and reload onto it, so a web change does not wait for the open after next.
const CACHE = "dotz-shell-v6";
// the page and its joined script and styles: cache first, refreshed together in the background; icons are cache-first
const FRESH = ["/", "/app.js", "/app.css"];
const SHELL = [...FRESH, "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/badge-96.png"];
// Web Share Target (manifest share_target): the phone's share sheet POSTs photos to /share-target. The worker keeps them in this
// cache and redirects to the chat, where the page (web/js/23-installable-app-web.js sharedIntake) takes them into the composer.
const SHARE = "dotz-share";

async function stashShare(req) {
  try {
    const form = await req.formData();
    const c = await caches.open(SHARE);
    for (const k of await c.keys()) await c.delete(k);
    const files = form.getAll("files").filter(f => typeof f !== "string" && f.size);
    await Promise.all(files.map((f, i) => c.put(`/share/file/${i}`, new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name || "") } }))));
    const parts = ["title", "text", "url"].map(k => String(form.get(k) || "").trim()).filter(Boolean);
    const text = parts.filter((p, i) => !parts.some((o, j) => j !== i && o.length > p.length && o.includes(p))).join("\n");
    await c.put("/share/meta", new Response(JSON.stringify({ n: files.length, text })));
  } catch (e) { console.warn("share target", e); }
  return Response.redirect(new URL("/?shared=1#chat", location.origin).href, 303);
}

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// One refresh at a time. The three files are stored only when all of them arrived, so the page never meets a script of another version.
// A file counts as changed when its ETag differs from the cached copy's (or, with no ETag on either side, its body); a path with no cached copy is no baseline.
const changed = async (old, now) => {
  if (!old) return false;
  const a = old.headers.get("ETag"), b = now.headers.get("ETag");
  return a && b ? a !== b : (await old.text()) !== (await now.clone().text());
};
let refreshing = null;
function refreshShell() {
  if (!refreshing) {
    refreshing = (async () => {
      const res = await Promise.all(FRESH.map(p => fetch(p, { cache: "no-cache" })));
      if (!res.every(r => r.ok)) return;
      const c = await caches.open(CACHE);
      const diff = await Promise.all(FRESH.map(async (p, i) => changed(await c.match(p), res[i])));
      await Promise.all(FRESH.map((p, i) => c.put(p, res[i])));
      if (diff.some(Boolean)) for (const w of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) w.postMessage({ type: "shell-updated" });
    })().catch(() => {}).finally(() => { refreshing = null; });
  }
  return refreshing;
}
// The page asks for a check when it comes back after a while away.
self.addEventListener("message", ev => { if (ev.data && ev.data.type === "refresh-shell") ev.waitUntil(refreshShell()); });

self.addEventListener("activate", ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.origin === location.origin && url.pathname === "/share-target") { ev.respondWith(stashShare(req)); return; }
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // the manifest is never answered from the cache: a stale one would decide the install (name, start_url, display)
  if (url.pathname === "/manifest.webmanifest") return;
  if (req.mode === "navigate" || FRESH.includes(url.pathname)) {
    const key = req.mode === "navigate" ? "/" : url.pathname;
    if (req.mode === "navigate") ev.waitUntil(refreshShell());
    ev.respondWith(caches.match(key).then(hit => hit || fetch(req)));
    return;
  }
  if (SHELL.includes(url.pathname)) ev.respondWith(caches.match(url.pathname).then(hit => hit || fetch(req)));
});

self.addEventListener("push", ev => {
  let m = {};
  try { m = ev.data ? ev.data.json() : {}; } catch { m = { body: ev.data ? ev.data.text() : "" }; }
  // A decision (m.id): up to two of its option buttons where the platform shows action buttons (Android); a tap elsewhere opens the detail.
  const max = typeof Notification !== "undefined" && Notification.maxActions ? Math.min(2, Notification.maxActions) : 0;
  const actions = m.id && Array.isArray(m.actions) ? m.actions.slice(0, max) : [];
  ev.waitUntil(self.registration.showNotification(m.title || "dotz", {
    body: m.body || "",
    tag: m.tag || undefined,
    renotify: Boolean(m.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    ...(actions.length ? { actions } : {}),
    data: { url: m.url || "/", ts: m.id ? "" : m.ts || "", id: m.id || "" },
  }));
});

self.addEventListener("notificationclick", ev => {
  ev.notification.close();
  const data = ev.notification.data || {};
  const url = new URL(data.url || "/", location.origin).href;
  // The message the notification is about: the page makes sure it is loaded before it jumps to it (a cold start gets it as ?m=).
  const at = data.ts || "", id = data.id || "";
  const openApp = async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ open: url, ts: at, ...(id ? { notice: id } : {}) });
      return;
    }
    const cold = new URL(id ? "/" : url, location.origin);   // a decision opens its sheet over the start screen, not its conversation
    if (at) cold.searchParams.set("m", at);
    if (id) cold.searchParams.set("n", id);
    await self.clients.openWindow(cold.href);
  };
  // An option button of a decision: the answer is posted from here, the app stays closed. If it could not be delivered the detail opens.
  if (id && /^opt:\d+$/.test(ev.action || "")) {
    ev.waitUntil((async () => {
      let ok = false;
      try {
        const r = await fetch(`/api/notices/${encodeURIComponent(id)}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: Number(ev.action.slice(4)) }) });
        ok = r.ok;
      } catch {}
      if (!ok) return openApp();
      await self.registration.showNotification("답변을 보냈어요", { tag: `decision:${id}`, silent: true, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", data: { url, ts: "", id: "" } });
      await new Promise(res => setTimeout(res, 3500));
      for (const n of await self.registration.getNotifications({ tag: `decision:${id}` })) n.close();
    })());
    return;
  }
  ev.waitUntil(openApp());
});
