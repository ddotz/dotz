/* ---------- 입력 진단 (설정 > 표시, 또는 주소 끝 ?kbdiag=1) ---------- */
// For the phone keyboard that jumps or closes while typing (an unproven cause). Off by default. When on, every blur of a text field leaves one entry in a ring
// buffer in localStorage (KBD_CAP entries): when, which field (tag, id, name, data-* and a selector path, never its value or any typed text), whether the
// node left the page or was replaced, where the focus went, the last few events before (type and target only, no keys), visibility and a short call
// stack (a blur fires inside the call that moved or removed the field, so the stack names it). The switch sends nothing: the owner copies the buffer
// as JSON from the settings row and sends it by hand.
// On a phone (coarse pointer) a cheap part is always on, switch or not: a text field that loses focus (or leaves the page) while the page is visible and the
// owner did not just tap, press back or change the route posts that one entry to the gateway (POST /api/input-diag, hub/input-diag.ts, capped file in the data
// dir). The owner's own taps are no report: a tap anywhere (send, another control, another field) or a route change within KBD_TAP_MS before the blur. At most
// KBD_POSTS posts a minute; a failed post is dropped. The ring a phone already has in localStorage is uploaded once. A desktop pointer posts nothing.
const KBD_FLAG = "dotz-kbdiag", KBD_LOG = "dotz-kbdiag-log", KBD_SENT = "dotz-kbdiag-sent", KBD_CAP = 200, KBD_RECENT = 6;
const KBD_TAP_MS = 800, KBD_POSTS = 3, KBD_POST_MS = 60000, KBD_SETTLE_MS = 500;
const KBD_TAPS = new Set(["pointerdown", "touchstart", "hashchange", "popstate"]);
const KBD_LIGHT = new Set(["input", "compositionstart", "compositionend", "resize"]);
const KBD_TEXT = "textarea, input:not([type=button], [type=checkbox], [type=radio], [type=range], [type=file], [type=submit], [type=reset], [type=color])";
const KBD_EVENTS = ["pointerdown", "pointerup", "click", "touchstart", "touchend", "focusin", "input", "change", "submit", "compositionstart", "compositionend", "visibilitychange", "pagehide", "pageshow", "resize", "orientationchange"];
let kbdActive = false, kbdAuto = false, kbdBuf = null, kbdCur = null, kbdSeq = 0, kbdMo = null, kbdTapAt = -1e9, kbdPosts = [];
const kbdRecent = [];
const kbdIsText = n => n instanceof Element && (n.isContentEditable || n.matches(KBD_TEXT));
function kbdSel(n) {
  if (!(n instanceof Element)) return n === document ? "document" : n === window ? "window" : "";
  const path = [];
  for (let e = n; e && e !== document.body && path.length < 4; e = e.parentElement) {
    let s = e.tagName.toLowerCase();
    if (e.id) s += `#${e.id.slice(0, 40)}`;
    else if (typeof e.className === "string" && e.className.trim()) s += `.${e.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
    if (e.dataset && e.dataset.k) s += `[data-k=${e.dataset.k.slice(0, 40)}]`;
    path.unshift(s);
  }
  return path.join(" > ");
}
function kbdField(f) {
  const data = {};
  for (const [k, v] of Object.entries(f.dataset || {})) data[k] = String(v).slice(0, 40);
  return { sel: kbdSel(f), tag: f.tagName.toLowerCase(), type: f.getAttribute("type") || "", id: f.id.slice(0, 40), name: (f.getAttribute("name") || "").slice(0, 40), data, ce: !!f.isContentEditable };
}
const kbdIdent = f => `${f.tag}|${f.type}|${f.id}|${f.name}|${f.data && f.data.k || ""}|${f.sel.split(" > ").pop()}`;
function kbdStack() {
  return String(new Error().stack || "").split("\n").map(l => l.trim().replace(/https?:\/\/[^\s)]*\//g, "")).filter(l => l && !/\bkbd[A-Z]/.test(l)).slice(0, 8).map(l => l.slice(0, 120));
}
function kbdLoad() {
  if (kbdBuf) return kbdBuf;
  const a = lsJson(KBD_LOG, []);
  kbdBuf = Array.isArray(a) ? a : [];
  return kbdBuf;
}
function kbdSave() { if (!kbdBuf) return; try { if (kbdBuf && kbdBuf.length) localStorage.setItem(KBD_LOG, JSON.stringify(kbdBuf)); else localStorage.removeItem(KBD_LOG); } catch (e) { console.warn("kbdiag", e); } }
function kbdPush(entry) { const b = kbdLoad(); b.push(entry); if (b.length > KBD_CAP) b.splice(0, b.length - KBD_CAP); kbdSave(); }
const kbdCount = () => kbdLoad().length;
function kbdEntry(kind, field, extra) {
  return { n: ++kbdSeq, app: typeof WEB_BUILD === "string" ? WEB_BUILD : "", at: new Date().toISOString(), kind, field: { ...field }, vis: document.visibilityState, hasFocus: document.hasFocus(), active: kbdSel(document.activeElement), recent: kbdRecent.slice(-KBD_RECENT), stack: kbdStack(), ...extra };
}
// Filled once the code that moved the field has finished (a microtask): is the node still in the page, did a same-looking field take its place, who has the focus.
function kbdSettle(entry, field, node) {
  queueMicrotask(() => {
    const act = document.activeElement, live = node.isConnected;
    const twin = !live && [...document.querySelectorAll(`${KBD_TEXT}, [contenteditable]`)].some(n => kbdIdent(kbdField(n)) === kbdIdent(field));
    entry.after = { active: kbdSel(act), activeIsField: kbdIsText(act), connected: live, replaced: twin, sameNodeFocused: act === node };
    kbdSave();
  });
}
function kbdOnEvent(e) {
  if (KBD_TAPS.has(e.type)) kbdTapAt = performance.now();
  if (e.type === "focusin" && kbdIsText(e.target)) { kbdCur = { node: e.target, field: kbdField(e.target) }; kbdObserve(true); }
  if (e.type !== "focusout") {
    kbdRecent.push({ type: e.type, on: KBD_LIGHT.has(e.type) ? (e.target instanceof Element ? e.target.tagName.toLowerCase() + (e.target.id ? `#${e.target.id.slice(0, 40)}` : "") : "") : kbdSel(e.target) });
    if (kbdRecent.length > 12) kbdRecent.shift();
  }
}
// The page is in front, has the focus, and the owner did not just tap or change the route: the field lost its focus on its own.
const kbdOnItsOwn = () => document.visibilityState === "visible" && document.hasFocus() && performance.now() - kbdTapAt > KBD_TAP_MS;
const kbdVh = () => Math.round((window.visualViewport ? visualViewport.height : innerHeight) || 0);
function kbdRecord(kind, field, node, extra) {
  const post = kbdAuto && kbdOnItsOwn();
  if (!kbdActive && !post) return;
  const entry = kbdEntry(kind, field, extra);
  if (kbdActive) kbdPush(entry);
  kbdSettle(entry, field, node);
  if (post) kbdReport(entry);
}
// Few posts a minute; the viewport height is read again once the keyboard has had time to move it.
function kbdReport(entry) {
  const now = Date.now();
  kbdPosts = kbdPosts.filter(t => now - t < KBD_POST_MS);
  if (kbdPosts.length >= KBD_POSTS) return;
  kbdPosts.push(now);
  entry.vh = { before: kbdVh(), after: 0 };
  setTimeout(() => { entry.vh.after = kbdVh(); if (kbdActive) kbdSave(); kbdPost([entry], true); }, KBD_SETTLE_MS);
}
async function kbdPost(entries, small) {
  try {
    const r = await fetch("/api/input-diag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: typeof WEB_BUILD === "string" ? WEB_BUILD : "", entries }), keepalive: !!small });
    return r.ok;
  } catch { return false; }
}
function kbdUploadRing() {
  try {
    if (localStorage.getItem(KBD_SENT) || !kbdLoad().length) return;
    kbdPost(kbdLoad().slice(-KBD_CAP), false).then(ok => { try { if (ok) localStorage.setItem(KBD_SENT, "1"); } catch { /* no storage: it is sent again next time */ } });
  } catch { /* unreadable ring: nothing to send */ }
}
function kbdOnBlur(e) {
  const n = e.target;
  if (!(kbdActive || kbdAuto) || !kbdIsText(n)) return;
  const field = kbdCur && kbdCur.node === n && !n.isConnected ? kbdCur.field : kbdField(n);
  if (kbdCur && kbdCur.node === n) kbdCur = null;
  kbdObserve(false);
  kbdRecord("blur", field, n, { connected: n.isConnected, to: kbdSel(e.relatedTarget) });
}
// A focused field taken out of the page may not blur at all (browsers differ): the observer notes that too, once.
function kbdOnMutation() {
  if (!kbdCur || kbdCur.node.isConnected) return;
  const { node, field } = kbdCur;
  kbdCur = null;
  kbdObserve(false);
  kbdRecord("removed", field, node, { connected: false });
}
// Watching the page for a removed field costs a call per change of the page: only while a text field has the focus.
function kbdObserve(on) {
  if (kbdMo) { kbdMo.disconnect(); kbdMo = null; }
  if (!on || !(kbdActive || kbdAuto)) return;
  kbdMo = new MutationObserver(kbdOnMutation);
  kbdMo.observe(document.documentElement, { childList: true, subtree: true });
}
function kbdWatch() {
  const on = kbdActive || kbdAuto;
  for (const t of [...KBD_EVENTS, "hashchange", "popstate"]) { removeEventListener(t, kbdOnEvent, true); if (on) addEventListener(t, kbdOnEvent, true); }
  removeEventListener("focusout", kbdOnBlur, true);
  if (window.visualViewport) { visualViewport.removeEventListener("resize", kbdOnEvent); if (on) visualViewport.addEventListener("resize", kbdOnEvent); }
  kbdObserve(false);
  kbdCur = null;
  if (!on) return;
  addEventListener("focusout", kbdOnBlur, true);
  const f = document.activeElement;
  if (kbdIsText(f)) { kbdCur = { node: f, field: kbdField(f) }; kbdObserve(true); }
}
function kbdSet(on) {
  kbdActive = !!on;
  try { if (on) localStorage.setItem(KBD_FLAG, "1"); else localStorage.removeItem(KBD_FLAG); } catch (e) { console.warn("kbdiag", e); }
  kbdWatch();
}
async function kbdCopy() {
  const out = { app: typeof WEB_BUILD === "string" ? WEB_BUILD : "", agent: navigator.userAgent, coarse: matchMedia("(pointer: coarse)").matches, entries: kbdLoad() };
  if (await copyText(JSON.stringify(out, null, 1))) toast(TX("connect.copied")); else toast(TX("chat.att.copy_failed"), true);
}
function kbdClear() { kbdBuf = []; kbdSave(); }
// The settings rows (22-settings-pages.js displayPage): the switch, and while it is on the buffer's size with 복사 and 지우기.
function kbdRows() {
  const row = (title, sub, end) => el("div", { class: "li" }, el("span", { class: "lead" }, icon("list")), el("span", { class: "tx" }, el("div", { class: "hd", text: title }), el("div", { class: "sup", text: sub })), liEnd(...end));
  const rows = [row(TX("misc.kbd.title"), kbdActive ? TX("misc.kbd.on_note") : TX("misc.kbd.off_note"),
    [el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(kbdActive), "aria-label": TX("misc.kbd.title"), "data-k": "kbdiag", onclick: () => { kbdSet(!kbdActive); renderSettings(); } })])];
  // one control per row (docs/ui-spec.md 설정 행): 복사 and 지우기 are two rows
  if (kbdActive) rows.push(row(TX("misc.kbd.log"), TX("misc.kbd.count", { n: kbdCount() }), [
    el("button", { type: "button", class: "btn tonal inrow", "data-k": "kbdiag-copy", onclick: () => kbdCopy(), text: TX("connect.copy") })]),
    row(TX("misc.kbd.clear"), "", [el("button", { type: "button", class: "btn text inrow", "data-k": "kbdiag-clear", onclick: () => { kbdClear(); renderSettings(); }, text: TX("misc.clear") })]));
  return rows;
}
try {
  const q = new URLSearchParams(location.search).get("kbdiag");
  kbdAuto = matchMedia("(pointer: coarse)").matches;
  kbdSet(q === "1" ? true : q === "0" ? false : localStorage.getItem(KBD_FLAG) === "1");
} catch { kbdSet(false); }
if (kbdAuto) setTimeout(kbdUploadRing, 5000);
