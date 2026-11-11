/* ---------- 분할 창: dragging (docs/split-panes.md 배치) ----------
   A row of the chat list (conversations, sessions, mail, KakaoTalk) or a pane's head is pulled over a pane: after 6px a ghost of the title follows
   the pointer and the hovered zone (the outer quarter at an edge, or the middle) is drawn over that pane. A row with nothing a pane can show says so in its ghost
   and draws no zone; so does any row off the chat tab (owner 8f7c8c3d: a split is the chat tab's). Pointer events on the document, so nothing is added to the rows; Escape cancels. The motion is 43-panes-motion.js. */
const PD_MOVE = 6;
let PD = null;   // {src, x, y, on, dead, ghost, zone, hit, from}

// What a row of the chat list opens: its conversation (data-t, a mail w:<target>) or a KakaoTalk room (w:kk:<room>, an app pane). null for a row a pane cannot hold.
function paneRowItem(row) {
  const { t, k = "" } = row.dataset;
  if (t) return validTarget(t) ? { kind: "chat", t } : null;
  if (k.startsWith("w:kk:")) return { kind: "app", t: paneKkT(k.slice(5)) };
  if (k.startsWith("w:")) return validTarget(k.slice(2)) ? { kind: "chat", t: k.slice(2) } : null;
  return null;
}
const paneRowLabel = row => (row.querySelector(".cv-n, .pl-n") || {}).textContent || (row.getAttribute("aria-label") || row.textContent).split(" · ")[0].trim();
// What a pressed row would put in a pane: {kind, t, label}, {no: true, label} when a pane cannot hold it (off: true when the tab is not 채팅), null when it is not a row.
// The menu's tabs are not rows: they are only pressed (owner 78c482b1).
function paneDragItem(t) {
  const row = t.closest(".pl-row[data-key], .cv-row, .hr[data-t], .mr[data-t]");
  if (!row || row.closest("#tl, .pane-tl")) return null;
  if (!paneTabOk()) return { no: true, off: true, label: paneRowLabel(row) };
  const it = row.matches(".pl-row") ? null : paneRowItem(row);
  return it ? { ...it, label: it.kind === "chat" ? targetName(it.t) : paneRowLabel(row) } : { no: true, label: paneRowLabel(row) };
}
function paneDragSource(ev) {
  const t = ev.target;
  if (ev.button !== 0 || PD || narrowChat() || !(t instanceof Element)) return null;
  const hd = t.closest(".pane-hd, #cv-head, .pmv-head"), pane = hd && !t.closest("button, a, input, textarea, select, [contenteditable]") && hd.closest(".pane");
  if (pane && PNV.el && PNV.el.contains(pane)) return { pane: pane.dataset.id, label: paneName(paneFind(pane.dataset.id)), el: hd };
  const it = paneDragItem(t);
  return it && { ...it, el: t.closest(".pl-row, .cv-row, .hr, .mr") };
}
document.addEventListener("pointerdown", ev => {
  const src = paneDragSource(ev);
  if (!src) return;
  PD = { src, x: ev.clientX, y: ev.clientY, on: false, dead: false, ghost: null, zone: null, hit: null, from: src.el.getBoundingClientRect() };
  for (const [type, fn] of PD_EVENTS) document.addEventListener(type, fn, true);
}, true);

// Where the pointer can drop: every pane when split, else the open conversation (head to composer) on the chat tab.
function paneDragBoxes() {
  if (paneCount() > 1 && PNV.el && !PNV.el.hidden) return [...PNV.el.querySelectorAll(".pane")].map(n => ({ id: n.dataset.id, r: n.getBoundingClientRect() }));
  if (current !== "chat") return [];
  const a = $("#cv-head").getBoundingClientRect(), b = $("#composer").getBoundingClientRect();
  return [{ id: "", r: new DOMRect(a.left, a.top, a.width, b.bottom - a.top) }];
}
// The left or right edge when the pointer is in the outer quarter of that side, else the middle (panes sit side by side only, owner 950d715f);
// edges are off when they cannot add a pane, and so are they when the two halves would be narrower than a pane may be (280px, 43-panes-view.js).
// The keys ask the same (43-panes-keys.js paneKeySplit).
const paneSplitFits = r => (r.width - 16) / 2 >= 280;
function paneDragZone(r, x, y, edges) {
  if (!edges || !paneSplitFits(r)) return "center";
  const l = (x - r.left) / r.width, rt = (r.right - x) / r.width;
  return l < 0.25 && l <= rt ? "left" : rt < 0.25 ? "right" : "center";
}
// With two panes there is no edge to split at: the whole pane is the zone and the drop replaces it (full: true says why).
function paneDragAim(x, y) {
  const boxes = PD.src.no ? [] : paneDragBoxes(), box = boxes.find(b => b.id !== PD.src.pane && x >= b.r.left && x < b.r.right && y >= b.r.top && y < b.r.bottom);
  const edges = !!PD.src.pane || paneCount() < PANE_MAX;
  PD.hit = box ? { id: box.id, r: box.r, side: paneDragZone(box.r, x, y, edges), full: !edges, narrow: edges && !paneSplitFits(box.r) } : null;
  paneDragPaint();
}
const PD_SIDE = { left: "왼쪽", right: "오른쪽" };
// The ghost's second line says what letting go does.
function paneDragHint() {
  const { src, hit } = PD;
  if (src.off) return "분할은 채팅 탭에서만 할 수 있어요";
  if (src.no) return "칸에 넣을 수 없어요";
  if (!hit) return "";
  if (src.pane) return hit.side === "center" ? "자리 바꾸기" : `${PD_SIDE[hit.side]}으로 옮기기`;
  if (paneCount() > 1 && paneOpenIn(src.kind, src.t)) return "열려 있는 칸으로 가요";
  if (hit.side !== "center") return `${PD_SIDE[hit.side]}에 새 칸`;
  return hit.full ? "칸은 2개까지라 이 칸을 바꿔요" : paneCount() > 1 ? "이 칸을 바꿔요" : hit.narrow ? "창이 좁아 여기서 열어요" : "여기서 열기";
}
function paneDragPaint() {
  const h = PD.hit, hint = PD.ghost && PD.ghost.querySelector(".pn-gh");
  if (hint) { const s = paneDragHint(); hint.textContent = s; hint.hidden = !s; }
  if (!h) { if (PD.zone) paneZoneOut(PD.zone); PD.zone = null; return; }
  const { r, side } = h, w = side === "center" ? r.width : r.width / 4, ht = r.height;
  const fresh = !PD.zone;
  if (fresh) { PD.zone = el("div", { class: "pn-zone" }); document.body.append(PD.zone); }
  Object.assign(PD.zone.style, { left: `${side === "right" ? r.right - w : r.left}px`, top: `${r.top}px`, width: `${w}px`, height: `${ht}px` });
  if (fresh) motionIn(PD.zone, "fade", M_MS.fast);
}

function paneDragMove(ev) {
  if (!PD || PD.dead) return;
  if (!PD.on) {
    if (Math.hypot(ev.clientX - PD.x, ev.clientY - PD.y) < PD_MOVE) return;
    PD.on = true;
    PD.ghost = el("div", { class: `pn-ghost${PD.src.no ? " no" : ""}` }, el("div", { class: "pn-gt", text: PD.src.label }), el("div", { class: "pn-gh", hidden: true }));
    document.body.append(PD.ghost);
    document.body.classList.add("pn-drag");
    document.body.classList.toggle("pn-no", !!PD.src.no);
    PD.src.el.classList.add("pn-src");
    paneGhostLift(PD.ghost);
  }
  ev.preventDefault();
  getSelection().removeAllRanges();
  paneDragAim(ev.clientX, ev.clientY);
  // measured after the aim wrote the hint line, which can widen the ghost past the window's edge
  const gw = PD.ghost.offsetWidth, gh = PD.ghost.offsetHeight, flip = ev.clientX + 12 + gw > innerWidth, up = ev.clientY + 12 + gh > innerHeight;
  Object.assign(PD.ghost.style, { left: `${flip ? ev.clientX - 12 - gw : ev.clientX + 12}px`, top: `${up ? ev.clientY - 12 - gh : ev.clientY + 12}px` });
}
// back: the drag ends without a drop, so the ghost goes back to where it was picked up.
function paneDragEnd(back) {
  const was = PD;
  PD = null;
  for (const [type, fn] of PD_EVENTS) document.removeEventListener(type, fn, true);
  if (!was || !was.on) return;
  if (was.ghost) { if (back) paneGhostBack(was.ghost, was.from); else paneGhostDrop(was.ghost); }
  if (was.zone) { if (back) paneZoneOut(was.zone); else was.zone.remove(); }
  was.src.el.classList.remove("pn-src");
  document.body.classList.remove("pn-drag", "pn-no");
  // The click that follows a drag must not open the row it started on.
  const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener("click", stop, true);
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}
function paneDragUp(ev) {
  if (!PD) return;
  if (PD.on && !PD.dead) paneDragAim(ev.clientX, ev.clientY);
  const { src, hit, on, dead } = PD, drop = on && !dead && hit;
  paneDragEnd(!drop);
  if (drop) paneDropMoving(src, hit);
}
// Escape drops the drag but keeps listening until the button is up, so the click that follows is still swallowed.
function paneDragKey(ev) {
  if (ev.key !== "Escape" || !PD) return;
  ev.preventDefault(); ev.stopPropagation();
  PD.dead = true; PD.hit = null;
  if (PD.ghost) paneGhostBack(PD.ghost, PD.from);
  PD.ghost = null;
  paneDragPaint();
  PD.src.el.classList.remove("pn-src");
  document.body.classList.remove("pn-no");
}
const PD_EVENTS = [["pointermove", paneDragMove], ["pointerup", paneDragUp], ["pointercancel", () => { if (PD) { PD.dead = true; paneDragEnd(true); } }], ["keydown", paneDragKey]];

// What a drop does. A pane's head: swap (middle) or move next to the pane. A list row: an edge splits next to that pane, the middle replaces it (one pane: opens in place);
// a target that is already open only brings its pane forward.
function paneDrop(src, { id, side }) {
  if (src.pane) { paneMove(src.pane, id, side); return; }
  const { kind, t } = src;
  paneListShut();
  if (paneCount() > 1) {
    const dup = paneOpenIn(kind, t);
    if (dup) paneFocus(dup.id);
    else if (side === "center") paneReplace(id, t, kind);
    else paneSplit(t, kind, side, id);
    return;
  }
  const here = paneHere();
  if (here.kind === kind && here.t === t) return;
  if (side !== "center") paneSplit(t, kind, side);
  else if (kind === "app") { go("monitoring", KK_KEY); kkOpen(paneKkId(t)); }   // one pane: the row opens as a click on it does
  else go("chat", t);
}
