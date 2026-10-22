/* ---------- installable app + web push (web/sw.js, /api/push in hub/push.ts) ---------- */
const PWA = { reg: null, sub: null, info: null };
const PUSH_KINDS = [["answer", "웹에서 맡긴 작업 완료 (짧은 답은 안 울려요)"], ["ask", "확인 필요 (질문 · 승인)"], ["lane", "세션 시작 · 완료 · 실패"], ["usage", "중요한 경고 (한도 · 오류 · 멈춤)"], ["update", "dotz 새 버전"]];
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const pushCapable = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
// Photos shared from the phone's gallery arrive through the service worker (sw.js stashShare) and a redirect to /?shared=1#chat:
// they join the composer like picked files, and any shared text goes into the input box. Nothing is sent.
async function sharedIntake() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(history.state, "", location.pathname + location.hash);
  if (!("caches" in window)) return;
  try {
    const c = await caches.open("dotz-share");
    const mr = await c.match("/share/meta");
    if (!mr) return;
    const meta = await mr.json(), files = [];
    for (let i = 0; i < meta.n; i++) {
      const r = await c.match(`/share/file/${i}`);
      if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get("X-Name") || ""), { type: r.headers.get("Content-Type") || "" }));
    }
    await caches.delete("dotz-share");
    go("chat");
    if (meta.text) { ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, "")}\n${meta.text}` : meta.text; ta.dispatchEvent(new Event("input")); ta.focus(); }
    if (!files.length) return;
    const n = Math.min(files.length, Math.max(0, 10 - ATT.length));
    toast(files.every(f => /^image\//.test(f.type)) ? `사진 ${n}장을 붙였어요` : `파일 ${n}개를 붙였어요`);
    addFiles(files);
  } catch (e) { console.warn("shared files", e); }
}
window.addEventListener("load", sharedIntake);
// a tapped notification asks an open window to show its conversation; listened for as the script runs (not after the page's load
// event) so a tap that lands while the page is still starting is not dropped
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", ev => { const d = ev.data || {}, h = d.open ? new URL(d.open, location.href).hash : ""; if (!h || d.notice) return;   // a decision push (d.notice) opens its sheet over the current screen (30-notices.js), no jump
  if (d.ts) pushOpen(h, d.ts); else if (location.hash !== h) { const p = parseHash(h); go(p.view, p.t); } });
// A new shell version: sw.js refreshShell posts {type:"shell-updated"} when its background fetch brought a changed page, script or styles.
// The page reloads onto it at once if nothing would be lost (empty composer, no attachment, sheet, dialog, or viewer open), else a chip
// offers it. The route is the hash and survives the reload; the scroll place is kept in sessionStorage and put back (chatOpen, shellRestoreViews).
// One automatic reload per minute at most, so a shell that keeps changing cannot loop.
const SHELL_KEY = "dotz-shell-reload", SHELL_LOOP_MS = 60000, SHELL_AWAY_MS = 3 * 60000;
const shellMem = () => { try { return JSON.parse(sessionStorage.getItem(SHELL_KEY) || "null") || {}; } catch { return {}; } };
let SHELL_RESTORE = (() => { const m = shellMem(); if (!m.at || m.used || Date.now() - m.at > 30000) return null; try { sessionStorage.setItem(SHELL_KEY, JSON.stringify({ ...m, used: true })); } catch {} return m; })();
if (SHELL_RESTORE) setTimeout(() => { SHELL_RESTORE = null; }, 15000);
const shellSafe = () => !ta.value.trim() && !ATT.length && !OV.length && !SUBD && !document.querySelector("dialog[open]");
function shellApply() {
  const s = { at: Date.now(), hash: location.hash, views: $("#views").scrollTop };
  if (current === "chat" && !convListing()) Object.assign(s, { key: target, stick: chatStick, anchor: chatAnchor() });
  try { sessionStorage.setItem(SHELL_KEY, JSON.stringify(s)); } catch {}
  location.reload();
}
function shellUpdated() {
  if (shellSafe() && Date.now() - (shellMem().at || 0) > SHELL_LOOP_MS) return shellApply();
  if (!document.querySelector(".shell-chip")) document.body.append(el("button", { class: "shell-chip", type: "button", text: "새 버전 · 눌러서 적용", onclick: shellApply }));
}
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", ev => { if (ev.data && ev.data.type === "shell-updated") shellUpdated(); });
// Back after a while away: ask the worker to look for a new shell now (a notification tap or a long sleep leaves the open page behind).
let shellHiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { shellHiddenAt = Date.now(); return; }
  const away = shellHiddenAt ? Date.now() - shellHiddenAt : 0;
  shellHiddenAt = 0;
  const sw = away > SHELL_AWAY_MS && "serviceWorker" in navigator && (navigator.serviceWorker.controller || (PWA.reg && PWA.reg.active));
  if (sw) sw.postMessage({ type: "refresh-shell" });
});
// The hub reports the build id of the shell it serves (/api/state web_build). A page that runs another one, however long it stayed open,
// has the worker store the new shell, then reloads onto it (or shows the chip). One try per build and page life.
let webBuildAsked = "";
async function webBuildCheck(b) {
  if (!b || b === WEB_BUILD || webBuildAsked === b) return;
  webBuildAsked = b;
  const sw = "serviceWorker" in navigator && (navigator.serviceWorker.controller || (PWA.reg && PWA.reg.active));
  if (sw) await new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = res; setTimeout(res, 8000); sw.postMessage({ type: "refresh-shell" }, [ch.port2]); });
  shellUpdated();
}
// Views other than a conversation have no anchor: put their scroll back once they are drawn.
if (SHELL_RESTORE && !SHELL_RESTORE.key && SHELL_RESTORE.views) for (const ms of [300, 1200]) setTimeout(() => { const v = $("#views"); if (SHELL_RESTORE && !v.scrollTop) v.scrollTop = SHELL_RESTORE.views; }, ms);
// A tap that had to start the app carries the message as ?m=<ts>: 99-boot.js opens it once the state is in. A decision carries ?n=<id> (its sheet,
// 30-notices.js): it stays in the address and never also jumps to a conversation.
const pushQ = new URLSearchParams(location.search);
// The device id: every subscription this device makes, on any computer, carries it, so the computers know they are one device (hub/push.ts fanOut).
// It is minted once here; opening another computer from this app (33-peers.js) hands it on as ?did=, and the page that arrives with one keeps that one.
let DEVICE_ID = "";
try {
  const incoming = pushQ.get("did") || "";
  if (/^[\w-]{8,64}$/.test(incoming)) localStorage.setItem("dotz-did", incoming);
  DEVICE_ID = localStorage.getItem("dotz-did") || "";
  if (!DEVICE_ID) localStorage.setItem("dotz-did", DEVICE_ID = crypto.randomUUID());
} catch {}
if (pushQ.has("did")) { pushQ.delete("did"); const rest = pushQ.toString(); history.replaceState(history.state, "", location.pathname + (rest ? `?${rest}` : "") + location.hash); }
// ?pc=<origin> (a notice relayed from another computer): the page switches to that computer (33-peers.js prFollow), with ?n / ?m as its own item.
const PUSH_FOLLOW = pushQ.has("pc") ? location.href : "";
let pushOpenTs = pushQ.has("n") || PUSH_FOLLOW ? "" : pushQ.get("m") || "";
if (pushQ.has("m") && !PUSH_FOLLOW) { pushQ.delete("m"); const rest = pushQ.toString(); history.replaceState(history.state, "", location.pathname + (rest ? `?${rest}` : "") + location.hash); }
async function pwaInit() {
  if (!("serviceWorker" in navigator)) return;
  try { PWA.reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch (e) { console.warn("service worker", e); return; }
  if (pushCapable()) PWA.sub = await PWA.reg.pushManager.getSubscription().catch(() => null);
  await pushLoad();
  presence();
}
async function pushLoad() {
  try { PWA.info = await api(`/api/push${PWA.sub ? `?endpoint=${enc(PWA.sub.endpoint)}` : ""}`); } catch {}
  // This computer learns which device the subscription is (the id) and whether it is the installed app's (hub/push.ts): once per change.
  if (PWA.sub && PWA.info && PWA.info.subscribed && (PWA.info.did !== DEVICE_ID || (!PWA.info.app && isStandalone()))) {
    try { await api("/api/push/subscribe", "POST", { subscription: PWA.sub.toJSON(), did: DEVICE_ID, ...(isStandalone() ? { app: true } : {}) }); PWA.info.did = DEVICE_ID; if (isStandalone()) PWA.info.app = true; } catch {}
  }
  if (current === "settings") renderSettings();
}
async function pushEnable(btn) {
  await busy(btn, async () => {
    if ((await Notification.requestPermission()) !== "granted") throw new Error("알림 권한이 꺼져 있어요. 기기 설정에서 dotz 알림을 허용해 주세요");
    const reg = PWA.reg || await navigator.serviceWorker.ready;
    const info = PWA.info || await api("/api/push");
    PWA.sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(info.publicKey) });
    await api("/api/push/subscribe", "POST", { subscription: PWA.sub.toJSON(), app: isStandalone(), did: DEVICE_ID });
    toast("알림을 켰어요");
  });
  await pushLoad();
  presence();
}
async function pushDisable(btn) {
  await busy(btn, async () => {
    const sub = PWA.sub;
    PWA.sub = null;
    if (sub) { await api("/api/push/unsubscribe", "POST", { endpoint: sub.endpoint }); await sub.unsubscribe().catch(() => {}); }
    toast("알림을 껐어요");
  });
  await pushLoad();
}
async function pushPref(kind, on) {
  try { PWA.info.prefs = (await api("/api/push/prefs", "PUT", { endpoint: PWA.sub.endpoint, prefs: { [kind]: on } })).prefs; } catch (e) { toast(e.message, true); }
  renderSettings();
}
const pushTest = btn => busy(btn, async () => { await api("/api/push/test", "POST", { endpoint: PWA.sub.endpoint }); toast("테스트 알림을 보냈어요"); });
// The gateway skips a push to this device while its page is visible and focused (heartbeat every 25s, stale after 60s).
let presTimer = 0;
function presence() {
  clearTimeout(presTimer);
  if (!PWA.sub) return;
  const active = document.visibilityState === "visible" && document.hasFocus();
  fetch("/api/push/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: PWA.sub.endpoint, active }), keepalive: true }).catch(() => {});
  if (active) presTimer = setTimeout(presence, 25000);
}
document.addEventListener("visibilitychange", presence);
["focus", "blur", "pagehide"].forEach(t => window.addEventListener(t, presence));
window.addEventListener("load", pwaInit);
// Install: Chrome/Edge/Samsung hand over beforeinstallprompt (a real app install, never the menu's shortcut);
// iOS has no prompt, so the button opens the Share -> 홈 화면에 추가 steps.
let installEvt = null;
window.addEventListener("beforeinstallprompt", ev => { ev.preventDefault(); installEvt = ev; if (current === "settings") renderSettings(); });
window.addEventListener("appinstalled", () => { installEvt = null; toast("앱을 설치했어요. 홈 화면의 dotz로 열어 주세요"); if (current === "settings") renderSettings(); });
async function installApp() {
  if (installEvt) {
    const e = installEvt;
    installEvt = null;
    await e.prompt();
    await e.userChoice.catch(() => null);
    if (current === "settings") renderSettings();
    return;
  }
  const ua = navigator.userAgent;
  const steps = isIOS()
    ? [/CriOS|FxiOS|EdgiOS/.test(ua) ? "주소창의 공유 버튼을 눌러요" : "Safari 아래쪽(또는 주소창)의 공유 버튼을 눌러요", "'홈 화면에 추가'를 골라요", "'웹 앱으로 열기'가 켜져 있는지 보고 '추가'를 눌러요"]
    : /Android/.test(ua)
      ? ["브라우저 메뉴(⋮)를 열어요", "'앱 설치'를 골라요. '홈 화면에 추가'라면 다음 창에서 '설치'를 골라요", "'바로가기 만들기'는 브라우저로 열려요. 고르지 마세요"]
      : ["주소창 오른쪽의 설치 아이콘을 눌러요", "없으면 브라우저 메뉴에서 '앱 설치'를 골라요"];
  dialog({ title: "앱 설치", body: el("div", {}, el("ol", { class: "steps" }, ...steps.map(s => el("li", { text: s }))), el("p", { class: "note", text: "전에 추가한 dotz 아이콘이 브라우저로 열리면 지우고 다시 추가해 주세요." })), actions: [{ label: "확인", kind: "pri", onclick: c => c() }] });
}
function pushSection() {
  const li = (ic, title, sub, ...trail) => el("div", { class: "li" }, el("span", { class: "lead" }, icon(ic)), el("span", { class: "tx" }, el("div", { class: "hd", text: title }), sub ? el("div", { class: "sup", text: sub }) : null), ...trail);
  const ios = isIOS(), standalone = isStandalone();
  const rows = [];
  if (!standalone) rows.push(li("home", "앱 설치", "주소창 없이 홈 화면에서 앱으로 열어요", el("button", { class: "btn", type: "button", onclick: () => installApp() }, "앱 설치")));
  const subscribed = PWA.sub && PWA.info && PWA.info.subscribed;
  if (!pushCapable()) rows.push(li("bell", "알림", ios && !standalone ? "iPhone은 홈 화면에 추가한 dotz 앱에서 켤 수 있어요 (iOS 16.4 이상)" : "이 브라우저는 푸시 알림을 지원하지 않아요"));
  else if (Notification.permission === "denied") rows.push(li("bell", "알림", "알림 권한이 막혀 있어요. 기기 설정에서 dotz 알림을 허용해 주세요"));
  else if (!subscribed) rows.push(li("bell", "알림", "작업 시작 · 완료 · 확인 필요 · 중요한 경고만 폰으로 받아요", el("button", { class: "btn", type: "button", onclick: ev => pushEnable(ev.currentTarget) }, "알림 켜기")));
  else {
    for (const [k, label] of PUSH_KINDS) {
      const on = PWA.info.prefs[k] !== false;
      rows.push(li("bell", label, "", el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(on), "aria-label": label, onclick: () => pushPref(k, !on) })));
    }
    rows.push(li("bell", "알림 확인", "이 기기로 알림 하나를 보내요", el("button", { class: "btn tonal", type: "button", onclick: ev => pushTest(ev.currentTarget) }, "테스트 알림 보내기"), el("button", { class: "btn text", type: "button", onclick: ev => pushDisable(ev.currentTarget) }, "끄기")));
  }
  const out = [el("div", { class: "sec", text: "앱 · 알림" }), el("div", { class: "list" }, ...rows), el("div", { class: "note", text: "휴대폰 갤러리에서 공유 → dotz로 사진을 바로 보낼 수 있어요 (홈 화면에 설치한 앱에서)" })];
  if (subscribed) out.push(el("div", { class: "note", text: "이 화면을 보고 있는 동안에는 알림을 보내지 않아요." }));
  return out;
}
