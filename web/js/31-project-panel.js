const PV = { on: false, want: "", t: "", shown: false };
const pvBox = el("aside", { id: "pv-panel", class: "pv-panel", "aria-label": TX("project.panel.aria"), hidden: true });
const pvTab = (k, text) => el("button", { class: "mx-tab", type: "button", role: "tab", "data-k": k, "aria-selected": "false", onclick: () => pvSet(k === "overview") }, text);
const pvTabs = el("div", { class: "mx-tabs pv-seg", role: "tablist", "aria-label": TX("project.panel.seg_aria"), hidden: true }, pvTab("chat", TX("common.conversation")), pvTab("overview", TX("project.panel.toggle")));
monChatTop.after(pvTabs);
$("#v-chat").append(pvBox);
const pvKey = () => current === "chat" && !chatList && !monCtx && isProjT(target) && paneCount() <= 1 && canvasPane.hidden ? (pmOfTarget(target) || {}).key || target : "";
function pvShown() { return PV.on && !!pvKey(); }
function pvChatOf(key) {
  const p = ((PRJ && PRJ.projects) || []).find(x => !x.builtin && (x.key === key || x.recordKey === key)), c = p ? prjChat(p) : isProjT(key) ? key : "";
  return c && S && projTargets().includes(c) ? c : "";
}
const pvWant = t => { PV.want = t; };
const pvClose = () => { PV.on = false; };
const pvHash = () => pvShown() ? projectHash(pvKey()) : "";
function pvRoute(tgt) {
  PV.t = target; PV.shown = false;
  if (PV.want) { PV.on = PV.want === target; PV.want = ""; }
  else { const h = parseHash(); if (narrowChat() || (isProjT(target) && h.view === "chat" && h.t === tgt)) PV.on = false; }
  pvSync();
}
function pvSet(on) {
  if (!pvKey() || PV.on === on) return;
  const wide = !narrowChat(), at = wide && !chatStick ? chatAnchor() : null;
  PV.on = on;
  const hash = pvHash() || `chat/${target}`, S = history.state, w = S && S.dz ? S.w || S.c : null;
  if (wide || (!on && w && w[w.length - 2] !== hash)) routeReplace(hash); else navSync("chat", hash);
  pvSync();
  if (at) { cvPinAt(at.ts, at.off); chatPin("at"); }
  else if (wide) chatPin("bottom");
}
function pvBack() {
  if (!pvShown() || !narrowChat()) return false;
  pvSet(false);
  return true;
}
const pvTogBtn = () => pvKey() && !narrowChat() ? el("button", { class: "btn tonal sm pv-tog", type: "button", "aria-pressed": String(pvShown()), onpointerdown: ev => ev.preventDefault(), onclick: () => pvSet(!PV.on) }, TX("project.panel.toggle")) : null;
function pvSync() {
  if (PV.t !== target) { if (narrowChat()) PV.on = false; PV.t = target; }
  const key = pvKey(), on = PV.on && !!key;
  $("#v-chat").classList.toggle("pv-on", on);
  pvBox.hidden = !on;
  pvTabs.hidden = !(key && narrowChat());
  for (const b of pvTabs.children) { const sel = (b.dataset.k === "overview") === on; b.classList.toggle("on", sel); b.setAttribute("aria-selected", String(sel)); }
  const tog = convHead.querySelector(".pv-tog");
  if (tog) tog.setAttribute("aria-pressed", String(on));
  if (on && PM.key !== key) pmOpen(key);
  else if (on && !PV.shown) { pmPaint(); pmLoad(); }
  PV.shown = on;
}
function pvAddr() {
  if (current !== "chat" || chatList || monCtx || H.moving || H.hold) return;
  const want = pvHash() || `chat/${target}`, now = location.hash.slice(1);
  if (now !== want && (want.startsWith("project/") || now.startsWith("project/"))) routeReplace(want);
}
screenHooks("chat", { route: pvRoute, hash: pvHash, back: pvBack, away: pvSync });
