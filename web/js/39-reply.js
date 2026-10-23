/* ---------- reply: swipe a message (or the hover button) to quote it in the next message ---------- */
// The quoted message travels with the new one (hub/intake.ts parseReply) and reaches the model like a Discord reply, as the context of
// the new message. Message ids: an owner message's mid, an assistant message's ts.
ICONS.reply = "M9 7L4 12l5 5M4 12h9a7 7 0 0 1 7 7";
const RP = { cur: null, bar: null, drag: null, src: new WeakMap() };
const RP_PULL = 60, RP_MAX = 92, RP_EDGE = 24, RP_QUOTE = 300;
const rpOwnerKind = e => e.kind === "message" || e.kind === "lane_message";
function rpText(e) {
  const raw = String(e.text ?? "");
  return (e.kind === "out" || e.kind === "lane_report" ? parseTone(noHandoff(raw)).text : raw).trim();
}
// Called for each drawn message row (chatPush): rows that carry text get an id, a hover button and the swipe.
function rpMark(n, e) {
  if (!n.matches(".um, .bm") || e.card || !/^(message|lane_message|out|lane_report)$/.test(e.kind) || !rpText(e)) return;
  n.dataset.rid = e.mid || e.message_id || e.ts;
  RP.src.set(n, e);
  n.append(el("button", { class: "rp-btn", type: "button", "aria-label": "답글", title: "답글", onclick: () => rpStart(n) }, icon("reply")));
}
function rpStart(n) {
  const e = RP.src.get(n);
  if (!e) return;
  RP.cur = { t: target, id: n.dataset.rid, author: rpOwnerKind(e) ? "" : ($(".mn", n)?.textContent || botName), content: rpText(e).slice(0, RP_QUOTE) };
  rpPaint();
  const ta = $("#text");
  if (!ta.disabled) ta.focus({ preventScroll: true });
}
function rpPaint() {
  const r = RP.cur && RP.cur.t === target ? RP.cur : null;
  if (!RP.bar) {
    if (!r) return;
    const tx = el("button", { class: "rp-tx", type: "button", "aria-label": "인용한 메시지로 이동", onclick: () => rpJump(RP.cur && RP.cur.id) }, el("span", { class: "rp-au" }), el("span", { class: "rp-ct" }));
    RP.bar = el("div", { class: "rpbar", id: "replybar", role: "group", "aria-label": "답글 대상", onpointerdown: ev => ev.preventDefault() }, icon("reply", "rp-ic"), tx, el("button", { class: "ib rp-x", type: "button", "aria-label": "답글 취소", title: "답글 취소", onclick: rpClear }, icon("close")));
    $("#composer").insertBefore(RP.bar, $("#send"));
  }
  RP.bar.hidden = !r;
  if (r) { $(".rp-au", RP.bar).textContent = r.author || "나"; $(".rp-ct", RP.bar).textContent = r.content; }
}
function rpClear() { RP.cur = null; rpPaint(); }
// The pending reply for the message being sent (cleared); sendChat puts it back when the send fails.
function rpTake() {
  const r = RP.cur && RP.cur.t === target ? RP.cur : null;
  if (!r) return null;
  RP.cur = null; rpPaint();
  return { id: r.id, author: r.author, content: r.content };
}
function rpRestore(reply) { if (reply) { RP.cur = { t: target, ...reply }; rpPaint(); } }
function rpJump(id) {
  const n = id && $("#tl [data-rid=\"" + CSS.escape(id) + "\"]");
  if (!n) return;
  n.scrollIntoView({ block: "center", behavior: "smooth" });
  n.classList.add("rp-flash");
  n.addEventListener("animationend", () => n.classList.remove("rp-flash"), { once: true });
}
// The owner message a bot message (kind "out") answers: the hub sends it as `reply` (hub/outbound.ts); an older event only has reply_to,
// then it is looked up among the messages loaded for this conversation.
function rpAsked(e) {
  if (e.reply) return e.reply;
  if (e.kind !== "out" || !e.reply_to || typeof ts !== "function") return null;
  const o = ts(target).msgs.find(m => (m.mid || m.message_id) === e.reply_to);
  const content = o ? rpText(o).slice(0, RP_QUOTE) : "";
  return content ? { id: e.reply_to, author: o.author || "", content } : null;
}
// The quote above a sent message (its reply field, hub/intake.ts) or above a bot message that answers one: tap to jump to the quoted
// message when it is still drawn.
function rpQuote(e) {
  const r = rpAsked(e);
  if (!r || !r.content) return null;
  return el("button", { class: "rpq", type: "button", onclick: () => rpJump(r.id) }, el("span", { class: "rpq-au", text: e.kind === "out" || r.author === e.author ? "나" : r.author }), el("span", { class: "rpq-ct", text: r.content }));
}
// Swipe a message from right to left (touch / pen; a mouse uses the hover button). The row follows the finger with a rubber band to the
// left and the reply icon shows on the right; it snaps at RP_PULL. A vertical drag (scroll) or a start at a screen edge (the system back
// gesture) is left alone. Touch events and pointer events feed the same drag; a touchstart takes over from the pointer events of the same
// finger, because only touch events can be cancelled (preventDefault) once the drag is horizontal.
function rpDown(src, id, row, tg, x, y) {
  if (RP.drag || !row || !row.dataset.rid) return;
  if (tg.closest("a, button, summary, input, textarea, pre, table")) return;
  if (x < RP_EDGE || x > innerWidth - RP_EDGE) return;
  RP.drag = { src, row, id, x, y, dx: 0, lock: false, hit: false, ind: null };
}
// Returns true while the drag is locked horizontal (the caller cancels the event then).
function rpMove(src, id, x, y, ev) {
  const d = RP.drag;
  if (!d || d.src !== src || id !== d.id) return false;
  const dx = d.x - x, dy = y - d.y; // dx > 0: the finger moved left
  if (!d.lock) {
    if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { RP.drag = null; return false; }
    if (dx <= 12 || dx <= Math.abs(dy) * 1.6) return false;
    d.lock = true;
    d.ind = el("span", { class: "rp-ind" }, icon("reply"));
    d.row.classList.remove("rp-snap");
    d.row.classList.add("rp-pull");
    d.row.append(d.ind);
    try { const sel = getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges(); } catch {}
    if (src === "p") try { d.row.setPointerCapture(id); } catch {}
  }
  d.dx = dx;
  const px = Math.min(RP_MAX, dx <= RP_PULL ? Math.max(0, dx) : RP_PULL + (dx - RP_PULL) * 0.3);
  d.row.style.setProperty("--rp-x", px + "px");
  d.row.style.setProperty("--rp-p", String(Math.min(1, px / RP_PULL)));
  const hit = dx >= RP_PULL;
  if (hit !== d.hit) {
    d.hit = hit;
    d.row.classList.toggle("rp-hit", hit);
    if (hit) try { navigator.vibrate && navigator.vibrate(8); } catch {}
  }
  if (ev.cancelable) ev.preventDefault();
  return true;
}
function rpEnd(src, id, ok) {
  const d = RP.drag;
  if (!d || d.src !== src || id !== d.id) return;
  RP.drag = null;
  if (!d.lock) return;
  const row = d.row;
  if (d.ind) d.ind.remove();
  row.classList.remove("rp-pull", "rp-hit");
  row.classList.add("rp-snap");
  row.style.removeProperty("--rp-x"); row.style.removeProperty("--rp-p");
  if (ok && d.dx >= RP_PULL) rpStart(row);
}
tl.addEventListener("pointerdown", ev => {
  if (ev.pointerType === "mouse" || !ev.isPrimary) return;
  rpDown("p", ev.pointerId, ev.target.closest("[data-rid]"), ev.target, ev.clientX, ev.clientY);
}, { passive: true });
tl.addEventListener("pointermove", ev => { rpMove("p", ev.pointerId, ev.clientX, ev.clientY, ev); });
tl.addEventListener("pointerup", ev => rpEnd("p", ev.pointerId, true));
tl.addEventListener("pointercancel", ev => rpEnd("p", ev.pointerId, false));
tl.addEventListener("touchstart", ev => {
  if (ev.touches.length !== 1) { if (RP.drag && RP.drag.src === "t") rpEnd("t", RP.drag.id, false); return; }
  const t = ev.changedTouches[0];
  if (RP.drag && RP.drag.src === "p" && !RP.drag.lock) RP.drag = null;
  rpDown("t", t.identifier, ev.target.closest("[data-rid]"), ev.target, t.clientX, t.clientY);
}, { passive: true });
tl.addEventListener("touchmove", ev => {
  const t = [...ev.changedTouches].find(c => RP.drag && c.identifier === RP.drag.id);
  if (t) rpMove("t", t.identifier, t.clientX, t.clientY, ev);
}, { passive: false });
const rpTouchEnd = ok => ev => { for (const t of ev.changedTouches) rpEnd("t", t.identifier, ok); };
tl.addEventListener("touchend", rpTouchEnd(true));
tl.addEventListener("touchcancel", rpTouchEnd(false));
