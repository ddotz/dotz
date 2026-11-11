/* ---------- 분할 창: the motion of a drag (43-panes-drag.js, web/DESIGN.md Motion) ----------
   The ghost lifts in when the drag starts, the zone glides between edges (26-panes.css transition), a new pane opens from nothing on the side it was
   dropped and pushes its neighbour over (its flex share grows, like the board's cards resize: the text reflows instead of stretching), a replace fades
   the new content up in place, a moved pane slides from where it was, a cancel sends the ghost back to its row. The motion tokens throughout; with
   prefers-reduced-motion each one is an instant change. */
function paneGhostLift(g) {
  if (reducedMotion()) return;
  g.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: M_MS.fast, easing: M_EASE });
}
function paneGhostDrop(g) { motionOut(g, "fade", M_MS.fast).then(() => g.remove()); }
function paneZoneOut(z) { motionOut(z, "fade", M_MS.fast).then(() => z.remove()); }
// Back to the row it was picked up from (its top left corner), fading as it lands.
function paneGhostBack(g, from) {
  if (reducedMotion() || !from) { g.remove(); return; }
  const r = g.getBoundingClientRect();
  const a = g.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translate(${from.left - r.left}px, ${from.top - r.top}px) scale(.96)` }], { duration: M_MS.base, easing: M_EASE, fill: "forwards" });
  a.finished.then(() => g.remove(), () => g.remove());
}

// Where every pane is now: pane id -> rect, or "" -> the one screen when there is no split.
function paneRects() {
  const out = new Map();
  if (PNV.el && !PNV.el.hidden) for (const n of PNV.el.querySelectorAll(".pane")) out.set(n.dataset.id, n.getBoundingClientRect());
  else { const b = paneDragBoxes()[0]; if (b) out.set("", b.r); }
  return out;
}
// A moved pane slides from where it was (its size changes at once).
function paneSlide(n, a) {
  const b = n.getBoundingClientRect();
  if (!a || Math.abs(a.left - b.left) + Math.abs(a.top - b.top) < 1) return;
  n.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: "none" }], { duration: M_MS.base, easing: M_EASE });
}
// A new pane opens: its share of the split grows from nothing while the other side gives it up.
function paneGrow(n) {
  const box = n.parentElement, other = [...box.children].find(c => c !== n && !c.classList.contains("pane-bar"));
  const share = parseFloat(n.style.flexGrow) || 0.5, rest = other ? parseFloat(other.style.flexGrow) || 0.5 : 0;
  const o = { duration: M_MS.base, easing: M_EASE };
  n.animate([{ flexGrow: 0, opacity: 0 }, { flexGrow: share, opacity: 1 }], o);
  if (other) other.animate([{ flexGrow: share + rest }, { flexGrow: rest }], o);
}
// A drop with its motion: a new pane grows in, a replaced pane (or the one screen) fades its new content up in place, moved panes slide.
function paneDropMoving(src, hit) {
  const before = paneRects(), one = before.has("");
  paneDrop(src, hit);
  if (reducedMotion()) return;
  if (!PNV.el || PNV.el.hidden) { if (one) motionSwap($(current === "activity" ? "#v-chat" : `#v-${current}`), () => {}); return; }
  for (const n of PNV.el.querySelectorAll(".pane")) {
    const id = n.dataset.id, p = paneFind(id);
    if (src.pane) paneSlide(n, before.get(id));
    else if (before.has(id)) { if (id === hit.id && hit.side === "center") motionSwap(n, () => {}); }
    else if (p && p.kind === src.kind && p.t === src.t) paneGrow(n);
  }
}
