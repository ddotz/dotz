/* ---------- 분할 창: the screen (docs/split-panes.md) ----------
   #split sits in #views from the second pane on, on a wide screen and the chat tab only: the tree of panes takes the whole width (the list column is folded,
   owner 8f7c8c3d), and the chat list (convSide) lies over the panes from the left when the active pane's 목록 button asks for it. The active pane holds the
   real #v-chat (go() finds the sections by id). Another tab, back to one pane or a narrow window: every node goes where it was (the tab, #split hidden
   with the panes kept) or #split goes (one pane, narrow). */
let PNV = { el: null, side: null, tree: null, sig: "", order: null, cmp: null, open: false };

function paneRoot() {
  if (PNV.el) return PNV.el;
  PNV.order = [...$("#views").children].map(n => n.id);
  PNV.side = el("div", { class: "pane-side" });
  PNV.tree = el("div", { class: "pane-tree" });
  PNV.el = el("div", { id: "split", class: "view fill split", hidden: true }, PNV.side, PNV.tree);
  $("#views").append(PNV.el);
  return PNV.el;
}

// The chat list over the panes (the 목록 button of the active pane): it lies from the left edge at its own width, so neither pane moves. It closes on a pick,
// a press outside it and Esc. It comes in the way a sheet does (280ms, the motion curve) and instantly under reduced motion.
// The same fold holds for the conversation with a 캔버스 open (cnvFoldSync below): there #v-chat is the host, and its own 목록 button is this one.
const paneHost = () => (PNV.el && !PNV.el.hidden ? PNV.el : $("#v-chat").classList.contains("cnv-fold") ? $("#v-chat") : null);
const paneListOutside = ev => { if (!ev.target.closest("#chat-convo, .pane-ls")) paneListShut(); };
const paneListKey = ev => { if (ev.key === "Escape") paneListShut(); };
// a row of the list that lies over the panes (or the 캔버스 chat) is a pick: the list closes (the row itself opens in the active pane, 31-conversations.js)
convSide.addEventListener("click", ev => { if (PNV.open && ev.target.closest(".cv-row")) paneListShut(); });
function paneListMark() {
  const b = document.querySelector(".pane-ls");
  if (b) b.setAttribute("aria-expanded", String(PNV.open));
}
function paneListOpen() {
  const host = paneHost();
  if (!host || PNV.open) return;
  PNV.open = true;
  convSide.getAnimations().forEach(a => a.cancel());
  host.classList.add("ls-open");
  paneListMark();
  if (!reducedMotion()) convSide.animate([{ opacity: 0, transform: "translateX(-16px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: M_EASE });
  document.addEventListener("pointerdown", paneListOutside, true);
  document.addEventListener("keydown", paneListKey, true);
}
const paneListGone = () => { for (const n of [PNV.el, $("#v-chat")]) if (n) n.classList.remove("ls-open"); convSide.getAnimations().forEach(a => a.cancel()); };
function paneListShut(now) {
  if (!PNV.open) return;
  PNV.open = false;
  document.removeEventListener("pointerdown", paneListOutside, true);
  document.removeEventListener("keydown", paneListKey, true);
  paneListMark();
  if (now) paneListGone();
  else motionOut(convSide, "fade", M_MS.fast).then(() => { if (!PNV.open) paneListGone(); });
}
// The 목록 button of the pane that is open (also the one the conversation shows beside a 캔버스 that has no room for the list column).
const paneLsBtn = () => el("button", { class: "ib pane-ls", type: "button", "aria-label": TX("misc.pane.list"), "aria-expanded": String(PNV.open), title: TX("misc.pane.list"), onclick: () => (PNV.open ? paneListShut() : paneListOpen()) }, icon("list"));
// With a 캔버스 open in the conversation, the list column folds exactly as in split panes when the window cannot give the canvas cnv-min wide next to the
// conversation's own minimum (the width a split pane keeps, 20-canvas.css): the list lies over the conversation from the 목록 button, and comes back as a column when the canvas closes.
function cnvNeed(c) {
  const cs = getComputedStyle(c), n = p => parseFloat(cs.getPropertyValue(p)) || 0;
  return n("--cv-w") + n("--cnv-conv") + n("--cnv-min") + 2 * n("column-gap") + n("padding-left") + n("padding-right");
}
function cnvFoldSync() {
  const c = $("#v-chat");
  if (current !== "chat") return;
  const want = c.classList.contains("canvas-open") && !narrowChat() && !(PNV.el && !PNV.el.hidden) && c.clientWidth < cnvNeed(c);
  if (want === c.classList.contains("cnv-fold")) return;
  if (!want) { paneListShut(true); $(":scope > .pane-ls", c)?.remove(); }
  c.classList.toggle("cnv-fold", want);
  if (want) c.append(paneLsBtn());
}
new MutationObserver(cnvFoldSync).observe($("#v-chat"), { attributes: true, attributeFilter: ["class"] });
new ResizeObserver(cnvFoldSync).observe($("#v-chat"));
// Called at the end of go()'s view switch, on a resize across 1100px, and by the model after every change.
function paneSync() { paneSyncRun(); cnvFoldSync(); }
function paneSyncRun() {
  if (!PNV.el && paneCount() < 2) return;
  if (paneCount() < 2 || narrowChat()) { paneTeardown(); return; }
  const show = paneTabOk();
  if (show) paneAdopt();
  paneRoot().hidden = !show;
  if (!show) { paneAway(); return; }
  $("#views").classList.remove("pp");
  const sig = paneSig();
  if (sig !== PNV.sig) { PNV.sig = sig; paneDraw(); }
  paneHeadSync();
}
// Not on the chat tab: the panes wait (targets, places, the active one and the mirrors are kept) and every section is where it belongs on its own screen.
function paneAway() {
  if (!PNV.sig) return;
  paneRelease();
  PNV.sig = "";
  paneListShut();
}
// The active screen's head follows the screen without a redraw (the KakaoTalk room open inside it).
function paneHeadSync() {
  const a = paneFind(PN.active), n = PNV.el && a.kind === "app" && PNV.el.querySelector(".pane.on > .pane-hd .cv-hd-t"), name = n && paneName(a);
  if (n && n.lastChild.textContent !== name) { n.lastChild.textContent = name; n.title = name; }
}
matchMedia("(max-width: 1099px)").addEventListener("change", paneSync);

// The tab that is lit while 모니터링's screen sits in an app pane: 채팅 (go() in 05-command-palette.js).
const paneLit = name => name === "monitoring" && !!PNV.el && !PNV.el.hidden && paneTabOk();
// The real 모니터링 screen sits in a pane: as narrow as a phone's column, so its back arrow closes an open room first (30-kakao.js kkBack).
const paneMonIn = () => $("#v-monitoring").classList.contains("in-pane");

// What the active pane shows is whatever the page shows: go() and openTarget() change its content (a target open in another pane activates that pane instead).
function paneAdopt() {
  const a = paneFind(PN.active), h = paneHere();
  if (!a || PN.going || current !== "chat" || (a.kind === h.kind && a.t === h.t)) return;
  const dup = paneOpenIn(h.kind, h.t);
  if (dup) { PN.active = dup.id; dup.t = h.t; dup.dot = ""; paneForget(dup.id); }
  else Object.assign(a, { kind: h.kind, t: h.t, at: null, stick: true, dot: "" });
  paneForget(a.id);
  panePersist();
}
const paneShape = n => (paneLeaf(n) ? [n.id, n.kind, n.id === PN.active ? "" : n.t] : [n.dir, paneShape(n.a), paneShape(n.b)]);
const paneSig = () => JSON.stringify([PN.active, paneShape(PN.root)]);

function paneHome(n) {
  const views = $("#views");
  if (n === convSide) { $("#v-chat").insertBefore(convSide, convHead); return; }
  const next = PNV.order.slice(PNV.order.indexOf(n.id) + 1).map(id => document.getElementById(id)).find(x => x && x.parentNode === views);
  views.insertBefore(n, next || null);
}
function paneRelease() {
  for (const n of [$("#v-chat"), $("#v-monitoring")]) {
    n.classList.remove("in-pane");
    if (n.parentNode !== $("#views")) paneHome(n);
  }
  if (convSide.parentNode !== $("#v-chat")) paneHome(convSide);
}
function paneTeardown() {
  if (!PNV.el) return;
  const chat = current === "chat", at = chat ? chatAnchor() : null, stick = chatStick;
  paneRelease();
  paneListShut();
  PNV.el.remove(); PNV.el = PNV.side = PNV.tree = null; PNV.sig = "";
  paneMirrorsClear();
  if (chat) paneLand(at, stick);
}
function paneDraw() {
  const chat = current === "chat", at = chat ? chatAnchor() : null, stick = chatStick;
  paneRelease();
  PNV.cmp = $("#composer");   // the open pane's section leaves the document while its pane is built, so the mirrors take the composer from here
  const kind = paneFind(PN.active).kind, sec = $(kind === "app" ? "#v-monitoring" : "#v-chat");
  sec.classList.add("in-pane");
  PNV.side.replaceChildren(convSide);
  PNV.tree.replaceChildren(paneNode(PN.root, sec));
  paneMirrorsPlace();
  if (chat) paneLand(at, stick);
}

function paneNode(n, sec) {
  if (paneLeaf(n)) return paneLeafEl(n, sec);
  const row = n.dir === "row", a = paneNode(n.a, sec), b = paneNode(n.b, sec);
  const bar = el("div", { class: "pane-bar", role: "separator", "aria-orientation": row ? "vertical" : "horizontal", title: TX("misc.pane.bar_tip") });
  const box = el("div", { class: `pane-${n.dir}` }, a, bar, b);
  paneShare(n, box);
  bar.addEventListener("pointerdown", ev => paneDrag(ev, n, box, bar));
  bar.addEventListener("dblclick", () => { n.r = 0.5; paneShare(n, box); panePersist(); });
  return box;
}
function paneShare(n, box) {
  box.firstElementChild.style.flex = `${n.r} 1 0px`;
  box.lastElementChild.style.flex = `${1 - n.r} 1 0px`;
}
function paneLeafEl(p, sec) {
  const on = p.id === PN.active;
  const x = el("button", { class: "ib pane-x", type: "button", "aria-label": TX("misc.pane.close"), title: TX("misc.pane.close"), onclick: () => paneClose(p.id) }, icon("close"));
  // the active pane's 목록 button sits at its head's left, over the head (the head leaves room for it, 26-panes.css)
  const ls = on && paneLsBtn();
  const kids = !on ? (p.kind === "chat" ? [paneMirror(p), x] : [paneMirror(p)]) : p.kind === "app" ? [paneHeadEl(p).head, sec, ls] : [sec, x, ls];
  const box = el("div", { class: `pane${on ? " on" : ""}`, "data-id": p.id, "data-kind": p.kind }, ...kids);
  box.addEventListener("pointerdown", ev => {
    if (ev.button !== 0 || p.id === PN.active || ev.target.closest(".pane-x")) return;
    const stub = !!ev.target.closest(".pane-chat .composer");
    paneFocus(p.id);
    if (stub) requestAnimationFrame(() => $("#text").focus());
  }, true);
  return box;
}
// The divider between two children: a drag changes r (a pane keeps 280px wide / 240px high at least, r stays 0.2..0.8); a double click is 반반.
function paneDrag(ev, n, box, bar) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const row = n.dir === "row", min = row ? 280 : 240, rect = box.getBoundingClientRect(), bw = row ? bar.offsetWidth : bar.offsetHeight;
  const total = (row ? rect.width : rect.height) - bw, from = row ? rect.left : rect.top;
  const lo = Math.max(0.2, min / total), hi = Math.min(0.8, 1 - min / total);
  bar.setPointerCapture(ev.pointerId);
  const move = e => {
    const r = ((row ? e.clientX : e.clientY) - from - bw / 2) / total;
    n.r = lo > hi ? 0.5 : Math.min(hi, Math.max(lo, r));
    paneShare(n, box);
  };
  const done = () => {
    bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", done); bar.removeEventListener("pointercancel", done);
    panePersist();
  };
  bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", done); bar.addEventListener("pointercancel", done);
}

// Goes to the pane's content (the page follows the active pane: address, back button) and puts the reader back where this pane was left.
function paneEnter(p) {
  const h = paneHere(), on = h.kind === p.kind && h.t === p.t && (p.kind !== "chat" || current === "chat");
  if (!on) paneGo(p.kind, p.t);
  else paneSync();
  paneLand(p.at, p.stick);
}
// The place of a conversation, the way closeChatList keeps it: the first message in view and its distance from the top, or the bottom.
function paneLand(at, stick) {
  if (current !== "chat") return;
  chatUnpin();
  if (!stick && at) { CV.pinTs = at.ts; CV.pinOff = at.off; chatPin("at"); }
  else timeline.scrollTop = timeline.scrollHeight;
  chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
  $("#chat-jump").hidden = chatStick;
}
