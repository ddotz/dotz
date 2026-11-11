/* ---------- 입력 진단 (설정 > 표시, 또는 주소 끝 ?kbdiag=1) ---------- */
// For the phone keyboard that jumps or closes while typing (an unproven cause). Off by default. When on, every blur of a text field leaves one entry in a ring
// buffer in localStorage (KBD_CAP entries): when, which field (tag, id, name, data-* and a selector path, never its value or any typed text), whether the
// node left the page or was replaced, where the focus went, the last few events before (type and target only, no keys), visibility and a short call
// stack (a blur fires inside the call that moved or removed the field, so the stack names it). Nothing is sent anywhere: the owner copies the buffer
// as JSON from the settings row and sends it by hand.
const KBD_FLAG = "dotz-kbdiag", KBD_LOG = "dotz-kbdiag-log", KBD_CAP = 200, KBD_RECENT = 6;
const KBD_TEXT = "textarea, input:not([type=button], [type=checkbox], [type=radio], [type=range], [type=file], [type=submit], [type=reset], [type=color])";
const KBD_EVENTS = ["pointerdown", "pointerup", "click", "touchstart", "touchend", "focusin", "input", "change", "submit", "compositionstart", "compositionend", "visibilitychange", "pagehide", "pageshow", "resize", "orientationchange"];
let kbdActive = false, kbdBuf = null, kbdCur = null, kbdSeq = 0, kbdMo = null;
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
function kbdSave() { try { if (kbdBuf && kbdBuf.length) localStorage.setItem(KBD_LOG, JSON.stringify(kbdBuf)); else localStorage.removeItem(KBD_LOG); } catch (e) { console.warn("kbdiag", e); } }
function kbdPush(entry) { const b = kbdLoad(); b.push(entry); if (b.length > KBD_CAP) b.splice(0, b.length - KBD_CAP); kbdSave(); }
const kbdCount = () => kbdLoad().length;
function kbdEntry(kind, field, extra) {
  return { n: ++kbdSeq, at: new Date().toISOString(), kind, field: { ...field }, vis: document.visibilityState, hasFocus: document.hasFocus(), active: kbdSel(document.activeElement), recent: kbdRecent.slice(-KBD_RECENT), stack: kbdStack(), ...extra };
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
  if (e.type === "focusin" && kbdIsText(e.target)) kbdCur = { node: e.target, field: kbdField(e.target) };
  if (e.type !== "focusout") {
    kbdRecent.push({ type: e.type, on: kbdSel(e.target) });
    if (kbdRecent.length > 12) kbdRecent.shift();
  }
}
function kbdOnBlur(e) {
  const n = e.target;
  if (!kbdActive || !kbdIsText(n)) return;
  const field = kbdCur && kbdCur.node === n && !n.isConnected ? kbdCur.field : kbdField(n);
  if (kbdCur && kbdCur.node === n) kbdCur = null;
  const entry = kbdEntry("blur", field, { connected: n.isConnected, to: kbdSel(e.relatedTarget) });
  kbdPush(entry);
  kbdSettle(entry, field, n);
}
// A focused field taken out of the page may not blur at all (browsers differ): the observer notes that too, once.
function kbdOnMutation() {
  if (!kbdCur || kbdCur.node.isConnected) return;
  const { node, field } = kbdCur;
  kbdCur = null;
  const entry = kbdEntry("removed", field, { connected: false });
  kbdPush(entry);
  kbdSettle(entry, field, node);
}
function kbdWatch() {
  for (const t of KBD_EVENTS) { removeEventListener(t, kbdOnEvent, true); if (kbdActive) addEventListener(t, kbdOnEvent, true); }
  removeEventListener("focusout", kbdOnBlur, true);
  if (window.visualViewport) { visualViewport.removeEventListener("resize", kbdOnEvent); if (kbdActive) visualViewport.addEventListener("resize", kbdOnEvent); }
  if (kbdMo) { kbdMo.disconnect(); kbdMo = null; }
  kbdCur = null;
  if (!kbdActive) return;
  addEventListener("focusout", kbdOnBlur, true);
  const f = document.activeElement;
  if (kbdIsText(f)) kbdCur = { node: f, field: kbdField(f) };
  kbdMo = new MutationObserver(kbdOnMutation);
  kbdMo.observe(document.documentElement, { childList: true, subtree: true });
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
  kbdSet(q === "1" ? true : q === "0" ? false : localStorage.getItem(KBD_FLAG) === "1");
} catch { kbdSet(false); }
