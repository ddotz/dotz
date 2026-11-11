// dotz service worker: app-shell cache for a fast start, and Web Push display. /api (JSON, SSE, files) is never answered from here; a push reads ahead (warmConv).
// The page, script and styles answer from the cache at once (a tapped notification starts the app without waiting for the
// network) and are fetched again in the background. When that fetch brings a changed shell, the open pages get a
// {type:"shell-updated"} message (web/js/23-installable-app-web.js shellUpdated) and reload onto it, so a web change does not wait for the open after next.
const CACHE = "dotz-shell-v12";
// the page, its joined script and styles and the owner's custom.js: cache first, refreshed together in the background. A file the page loads that
// is not here waits on the gateway, and with the gateway off the page never finished loading (2026-10-28).
const FRESH = ["/", "/app.js", "/app.css", "/custom.js"];
// icons: cache first too, but each is fetched again in the same background refresh (no ETag test, no reload), so a changed icon never needs a CACHE bump
const ICONS = ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/badge-96.png"];
const SHELL = [...FRESH, ...ICONS];
// Web Share Target (manifest share_target): the phone's share sheet POSTs photos to /share-target. The worker keeps them in this
// cache and redirects to the chat, where the page (web/js/23-installable-app-web.js sharedIntake) takes them into the composer.
const SHARE = "dotz-share";
// A tap that has to start the app, kept beside the shares: a phone may bring the app back at the address it started with, not the one openWindow named
// (a stale ?n= came back on the owner's Samsung Internet app, and every push landed on one old decision, 2026-11-05). The page reads it on load (23-installable-app-web.js pushTapCheck).
const TAP = "/push/tap";
// `how`: the tap's tag and why no open window took it, which the page reports to the gateway with where it landed (hub/push.ts POST /api/push/tap).
async function openAt(href, how) {
  try { await (await caches.open(SHARE)).put(TAP, new Response(JSON.stringify({ href, at: Date.now(), path: "new-window", ...how }))); } catch (e) { console.warn("push tap", e); }
  await self.clients.openWindow(href);
}
// The app itself: a top-level window at the root. Other windows of this origin (a user app under /apps/<id>/, a screen share) have no receiver for a tap.
const isAppWin = (w, origin) => { try { const u = new URL(w.url); return u.origin === origin && u.pathname === "/"; } catch { return false; } };
// How long a window has to say it got a tap's message: a frozen or reloading page drops it, and the tap then opens the address instead.
const ACK_MS = 2500;
function tellWindow(win, msg) {
  return new Promise(res => {
    const ch = new MessageChannel();
    const t = setTimeout(() => res(false), ACK_MS);
    ch.port1.onmessage = () => { clearTimeout(t); res(true); };
    try { win.postMessage(msg, [ch.port2]); } catch { clearTimeout(t); res(false); }
  });
}
// A navigation answers from the cache at once; its background check waits this long, so its eight requests do not join the page's own first ones on a busy gateway.
const REFRESH_AFTER_MS = 3000;

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
      // Icons are stored one by one (a missing icon must not block a shell update) and never trigger a reload.
      const icons = Promise.all(ICONS.map(async p => { try { const r = await fetch(p, { cache: "no-cache" }); if (r.ok) await (await caches.open(CACHE)).put(p, r); } catch {} }));
      const res = await Promise.all(FRESH.map(p => fetch(p, { cache: "no-cache" })));
      if (!res.every(r => r.ok)) { await icons; return; }
      const c = await caches.open(CACHE);
      const old = await Promise.all(FRESH.map(p => c.match(p)));
      const diff = await Promise.all(FRESH.map((p, i) => changed(old[i], res[i])));
      // An unchanged file keeps its entry: storing it again costs a 1.3 MB write per open and drops the compiled code the browser keeps beside the entry.
      await Promise.all([icons, ...FRESH.map((p, i) => (!old[i] || diff[i] ? c.put(p, res[i]) : null))]);
      if (diff.some(Boolean)) for (const w of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) w.postMessage({ type: "shell-updated" });
    })().catch(() => {}).finally(() => { refreshing = null; });
  }
  return refreshing;
}
// The page asks for a check when it comes back after a while away.
// A port in the message gets a reply when the refresh is done, so the page can reload onto the stored copies.
self.addEventListener("message", ev => { if (ev.data && ev.data.type === "refresh-shell") ev.waitUntil(refreshShell().then(() => { if (ev.ports && ev.ports[0]) ev.ports[0].postMessage("done"); })); });

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
  // the old JANDI chat address is the gateway's redirect into the app's chat view (hub/relay-route.ts); the app shell would lose the conversation
  if (url.pathname.startsWith("/jandi-peer/")) return;
  // the pairing door (hub/pair-page.ts) is the gateway's own page, never the app shell
  if (url.pathname === "/pair" || url.pathname === "/pair.js") return;
  // the remote desktop (hub/remote-desktop.ts) is the gateway's own page, never the app shell
  if (url.pathname === "/desk" || url.pathname.startsWith("/desk/")) return;
  // user apps (hub/apps-web.ts) are served by the gateway at /apps/<id>/, never the app shell
  if (url.pathname.startsWith("/apps/")) return;
  if (req.mode === "navigate" || FRESH.includes(url.pathname)) {
    const key = req.mode === "navigate" ? "/" : url.pathname;
    if (req.mode === "navigate") ev.waitUntil(new Promise(res => setTimeout(res, REFRESH_AFTER_MS)).then(refreshShell));
    ev.respondWith(caches.match(key).then(hit => hit || fetch(req)));
    return;
  }
  if (SHELL.includes(url.pathname)) ev.respondWith(caches.match(url.pathname).then(hit => hit || fetch(req)));
});

// Whether a notification would only repeat what is on screen: an open window of this app that is visible and focused shows the same conversation
// (#chat/<conv>) the notification opens, or the 알림 screen for #chat/alert. A notification for any other page or conversation still shows. Pure, so hub/push-sw-web.test.ts runs it.
function pushSuppressed(wins, url, origin) {
  let want;
  try { want = new URL(url || "/", origin); } catch { return false; }
  if (!/^#chat\/./.test(want.hash)) return false;
  return wins.some(w => {
    try {
      const at = new URL(w.url);
      return at.origin === want.origin && at.pathname === "/" && w.visibilityState === "visible" && w.focused === true && (at.hash === want.hash || (want.hash === "#chat/alert" && at.hash === "#notices"));
    } catch { return false; }
  });
}

const WARM_MSGS = 60;
const snapTx = (fn) => new Promise((res, rej) => {
  const q = indexedDB.open("dotz-snap", 1);
  q.onupgradeneeded = () => q.result.createObjectStore("conv");
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const tx = q.result.transaction("conv", "readwrite"); fn(tx.objectStore("conv")); tx.oncomplete = () => { q.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
});
async function warmConv(url, nid) {
  const hash = new URL(url || "/", location.origin).hash, at = hash.match(/^#chat\/(.+)$/);
  if (!at || typeof indexedDB === "undefined") return;
  const t = decodeURIComponent(at[1]);
  if (t === "alert" && !nid) return;   // an alert push without a notice opens the 알림 screen, not this conversation
  if (t.startsWith("mail:")) return;   // 13-snapshot.js snapOk: mail stays off the device
  const r = await fetch(`/api/history?target=${encodeURIComponent(t)}&limit=${WARM_MSGS}`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
  if (r.status === 403 && r.headers.get("x-dotz-pair")) return new Promise(res => { const q = indexedDB.deleteDatabase("dotz-snap"); q.onsuccess = q.onerror = q.onblocked = res; });
  if (!r.ok) return;
  const events = (await r.json()).events || [];
  if (events.length) await snapTx(os => { const g = os.get(t); g.onsuccess = () => os.put({ v: 1, t, acts: [], amore: true, ahist: false, read: "", ...g.result, at: Date.now(), msgs: events, hmore: events.length >= WARM_MSGS }, t); });
}

self.addEventListener("push", ev => {
  let m = {};
  try { m = ev.data ? ev.data.json() : {}; } catch { m = { body: ev.data ? ev.data.text() : "" }; }
  // A decision (m.id): up to two of its option buttons where the platform shows action buttons (Android); a tap elsewhere opens the detail.
  const max = typeof Notification !== "undefined" && Notification.maxActions ? Math.min(2, Notification.maxActions) : 0;
  const actions = m.id && Array.isArray(m.actions) ? m.actions.slice(0, max) : [];
  // Notifications about something already handled are closed (hub/push.ts withdraw): a "withdraw" push carries only those; a real one may carry
  // them too. A push must still show something (Chrome otherwise posts its own "updated in the background" line): when nothing else is left,
  // one silent line is shown and closed at once. Apple endpoints never get a bare withdraw (Safari revokes push that shows nothing).
  const gone = Array.isArray(m.withdraw) ? m.withdraw.filter(t => typeof t === "string") : [];
  const closeGone = async () => { for (const n of await self.registration.getNotifications()) if (gone.includes(n.tag)) n.close(); };
  if (m.kind === "withdraw") {
    ev.waitUntil((async () => {
      await closeGone();
      if ((await self.registration.getNotifications()).length) return;
      await self.registration.showNotification("{{shell.sw.cleanup_title}}", { tag: "withdrawn", body: "{{shell.sw.cleanup_body}}", silent: true, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" });
      for (const n of await self.registration.getNotifications({ tag: "withdrawn" })) n.close();
    })());
    return;
  }
  if (gone.length) ev.waitUntil(closeGone());
  const show = () => self.registration.showNotification(m.title || "{{common.alerts}}", {
    body: m.body || "",
    tag: m.tag || undefined,
    renotify: Boolean(m.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",   // Android draws it as a white mask: the dotz mark on a transparent background
    ...(actions.length ? { actions } : {}),
    data: { url: m.url || "/", ts: m.ts || "", id: m.id || "", nid: m.nid || "", pc: m.pc || "" },
  });
  // The app is usually closed when a push lands: its conversation is read now, so the tap paints the very message without the network (web/js/13-snapshot.js).
  if (!m.pc && m.kind !== "test") ev.waitUntil(warmConv(m.url, m.nid).catch(() => {}));
  ev.waitUntil((async () => {
    const wins = m.pc ? [] : await self.clients.matchAll({ type: "window", includeUncontrolled: true }).catch(() => []);
    if (!pushSuppressed(wins, m.url, location.origin)) return show();
    // The owner is looking at that conversation already. Safari revokes a subscription whose push shows nothing (webkit.org/blog/16535), so an Apple
    // endpoint still gets a silent notification that is closed at once; other browsers show nothing while a focused window of the app is open.
    const sub = await self.registration.pushManager.getSubscription().catch(() => null);
    if (!sub || !/(^|\.)push\.apple\.com$/.test(new URL(sub.endpoint).host)) return;
    await self.registration.showNotification(m.title || "{{common.alerts}}", { tag: "on-screen", body: m.body || "", silent: true, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" });
    for (const n of await self.registration.getNotifications({ tag: "on-screen" })) n.close();
  })());
});

// The push service swapped this app's subscription (Chrome moved fcm.googleapis.com endpoints, a key rotation): the old endpoint answers 410 from now on,
// so the worker subscribes again and tells the gateway, naming the endpoint it replaces so the new one keeps the device id and app role (hub/push.ts
// /api/push/subscribe `replaces`). Without this the device went silent until its app was opened (2026-10-30).
async function resubscribe(ev) {
  const old = ev.oldSubscription || null;
  let sub = ev.newSubscription || null;
  if (!sub) {
    let key = old && old.options && old.options.applicationServerKey;
    if (!key) {
      const s = (await (await fetch("/api/push")).json()).publicKey;
      key = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
    }
    sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), ...(old ? { replaces: old.endpoint } : {}) }) });
}
self.addEventListener("pushsubscriptionchange", ev => ev.waitUntil(resubscribe(ev).catch(() => {})));

self.addEventListener("notificationclick", ev => {
  ev.notification.close();
  const data = ev.notification.data || {};
  const url = new URL(data.url || "/", location.origin).href;
  // The message the notification is about: the page makes sure it is loaded before it jumps to it (a cold start gets it as ?m=, its notice as ?i=).
  const at = data.ts || "", id = data.id || "", nid = data.nid || "";
  const tag = ev.notification.tag || "";
  const openApp = async () => {
    const wins = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(w => isAppWin(w, location.origin));
    const win = wins.find(w => w.focused) || wins.find(w => w.visibilityState === "visible") || wins[0];
    // A window that refuses focus (a browser may) would change where nobody sees it, and one that does not answer has not got the tap: a new one opens at the item instead.
    let why = "no-window";
    if (win) {
      if (await win.focus().then(() => true, () => false)) {
        const tap = { path: "open-window", tag };
        // A notice relayed from another computer: this app opens, then the page switches to that computer (33-peers.js prFollow), at the item.
        if (await tellWindow(win, data.pc ? { follow: url, tap } : { open: url, ts: at, tap, ...(nid ? { nid } : {}), ...(id ? { notice: id } : {}) })) return;
        why = "no-ack";
      } else why = "focus-refused";
    }
    if (data.pc) { await openAt(url, { tag, why }); return; }
    const cold = new URL(url);   // the conversation draws first; the page then lands on the message (a decision also opens its sheet over it)
    if (at) cold.searchParams.set("m", at);
    if (nid) cold.searchParams.set("i", nid);
    if (id) cold.searchParams.set("n", id);
    await openAt(cold.href, { tag, why });
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
      await self.registration.showNotification("{{shell.sw.reply_sent}}", { tag: `decision:${id}`, silent: true, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", data: { url, ts: "", id: "" } });
      await new Promise(res => setTimeout(res, 3500));
      for (const n of await self.registration.getNotifications({ tag: `decision:${id}` })) n.close();
    })());
    return;
  }
  ev.waitUntil(openApp());
});
