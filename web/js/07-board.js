/* ---------- board: free-form 12-column card grid shared by 홈 and 레인 ---------- */
// Each card is {id, x, y, w, h} in grid units. Positions are calc() of the container width, so a saved layout paints correctly on the first frame.
// Dragging a card (by its header) pushes the cards it overlaps down, then everything is compacted upward. Layout is kept per board in localStorage.
// Narrow (a phone): one column in the grid's reading order (row, then column); a long press on a card lifts it and a drop writes the
// new order back into the grid, so both widths show the same order. Esc puts a lifted card back.
const BCOLS = 12, BGAP = 12, BROW = 40, BSTEP = BROW + BGAP;
// Auto-scroll while dragging: within B_EDGE px of the scroller's top or bottom edge, up to B_SCROLL px per frame at the very edge.
const B_EDGE = 56, B_SCROLL = 18, B_PRESS = 450;
const boards = new Set();
const narrowMQ = matchMedia("(max-width: 639px), (pointer: coarse) and (max-width: 767px)");
narrowMQ.addEventListener("change", () => boards.forEach(b => b.paint()));
const bClamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bHit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const bOrder = (list, first) => list.sort((a, b) => a.y - b.y || (a.id === first ? -1 : b.id === first ? 1 : 0) || a.x - b.x);
// Push every card that overlaps `m` below it (and whatever those then overlap).
function bPush(list, m) {
  for (const c of bOrder([...list])) if (c !== m && bHit(m, c)) { c.y = m.y + m.h; bPush(list, c); }
}
// Vertical compaction; `first` wins ties, `fixed` are cards that are not shown right now but keep their place.
function bCompact(list, first, fixed = []) {
  const out = [...fixed];
  for (const c of bOrder(list, first)) {
    while (c.y > 0 && !out.some(o => bHit({ ...c, y: c.y - 1 }, o))) c.y--;
    while (out.some(o => bHit(c, o))) c.y++;
    out.push(c);
  }
}
function bFree(list, w, h) {
  for (let y = 0; ; y++) for (let x = 0; x + w <= BCOLS; x++) if (!list.some(o => bHit({ x, y, w, h }, o))) return { x, y };
}
function bFit(r, it) {
  const w = bClamp(r.w, it.min.w, Math.min(it.max.w, BCOLS)), h = bClamp(r.h, it.min.h, it.max.h);
  return { x: bClamp(r.x, 0, BCOLS - w), y: Math.max(0, r.y), w, h };
}
// The cards laid out again in the given order, each keeping its size: left to right, a new row below the tallest card of the row
// once a card does not fit. Reading order (row, then column) then equals `order`.
function bFlow(order) {
  let x = 0, y = 0, rowH = 0;
  return order.map(r => {
    if (x + r.w > BCOLS) { x = 0; y += rowH; rowH = 0; }
    const out = { ...r, x, y };
    x += r.w; rowH = Math.max(rowH, r.h);
    return out;
  });
}
function bLoad(store) {
  const out = {};
  const o = lsJson(store, null); // unreadable layout: start from defaults
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [id, r] of Object.entries(o)) if (r && ["x", "y", "w", "h"].every(k => Number.isInteger(r[k]) && r[k] >= 0) && r.w > 0 && r.h > 0) out[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
  return out;
}
const B_IGNORE = "button, input, textarea, select, a, summary, [role=button], .lrep, [data-nodrag]";
// items: [{id, node, head (selector of the drag handle inside node), def {w,h}, min {w,h}, max {w,h}}]. `keep(id)` tells which saved
// cards that are not in `items` only wait for their data (and so keep their place) instead of being gone.
function makeBoard(container, key, opts = {}) {
  const store = `dotz-board-${key}`;
  let saved = bLoad(store), lastJson = JSON.stringify(saved), cur = [], lay = [], ghost = [], act = null, pending = null, swallow = false;
  const wraps = new Map();
  const ph = el("div", { class: "bph", hidden: true });
  const bar = el("div", { class: "bbar" }, ...(opts.actions || []).map(a => el("button", { class: "btn text", type: "button", onclick: () => a.run() }, a.label)), el("button", { class: "btn text", type: "button", onclick: () => reset() }, "배치 초기화"));
  container.classList.add("board");
  container.before(bar);
  container.append(ph);
  const views = $("#views");
  const meta = id => cur.find(i => i.id === id);
  const pos = (n, r) => {
    n.style.left = `calc((100% + ${BGAP}px) * ${r.x} / ${BCOLS})`;
    n.style.width = `calc((100% + ${BGAP}px) * ${r.w} / ${BCOLS} - ${BGAP}px)`;
    n.style.top = `${r.y * BSTEP}px`;
    n.style.height = `${r.h * BSTEP - BGAP}px`;
  };
  const rows = list => list.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  function paint(list = lay, skip = null) {
    const narrow = narrowMQ.matches;
    container.classList.toggle("narrow", narrow);
    if (narrow) {
      container.style.height = ""; ph.hidden = true;
      bOrder(lay.map(r => ({ ...r }))).forEach((r, i) => { const w = wraps.get(r.id); if (w) { w.removeAttribute("style"); w.style.order = i; } });
    } else {
      for (const r of list) { const w = skip === r.id ? ph : wraps.get(r.id); if (w) { pos(w, r); if (w !== ph) w.style.order = ""; } }
      container.style.height = `${Math.max(0, rows(list) * BSTEP - BGAP)}px`;
    }
    if (!skip && opts.onLayout) opts.onLayout();
  }
  function persist() {
    const o = {};
    for (const r of [...ghost, ...lay]) o[r.id] = { x: r.x, y: r.y, w: r.w, h: r.h };
    saved = o;
    const j = JSON.stringify(o);
    if (j !== lastJson) { lastJson = j; try { localStorage.setItem(store, j); } catch { /* storage full or blocked */ } }
  }
  // Cards that sit side by side (same top row) take one height: the card being resized sets it, otherwise the tallest
  // does; each stays within its own min/max. Growing can overlap the cards below, so they are pushed and compacted again.
  function bEven(list, lead, first) {
    const rows = new Map();
    for (const c of list) { if (!meta(c.id)) continue; if (!rows.has(c.y)) rows.set(c.y, []); rows.get(c.y).push(c); }
    let changed = false;
    for (const g of rows.values()) {
      if (g.length < 2) continue;
      const L = g.find(c => c.id === lead), target = L ? L.h : Math.max(...g.map(c => c.h));
      for (const c of g) { const m = meta(c.id), h = bClamp(target, m.min.h, m.max.h); if (h !== c.h) { c.h = h; changed = true; } }
    }
    if (!changed) return;
    for (const c of bOrder([...list], first)) bPush(list, c);
    bCompact(list, first, ghost);
  }
  function set(items, keep = () => false) {
    if (act) { pending = [items, keep]; return; }
    cur = items;
    const ids = new Set(items.map(i => i.id));
    const placed = [];
    for (const it of items) if (saved[it.id]) placed.push({ id: it.id, ...bFit(saved[it.id], it) });
    ghost = Object.entries(saved).filter(([id]) => !ids.has(id) && keep(id)).map(([id, r]) => ({ id, ...r }));
    bCompact(placed, null, ghost);
    for (const it of items) if (!saved[it.id]) { const d = bFit({ x: 0, y: 0, ...it.def }, it); placed.push({ id: it.id, ...d, ...bFree([...placed, ...ghost], d.w, d.h) }); }
    bEven(placed, null, null);
    lay = placed;
    persist();
    for (const [id, w] of wraps) if (!ids.has(id)) { w.remove(); wraps.delete(id); }
    for (const it of items) {
      let w = wraps.get(it.id);
      if (!w) { w = el("div", { class: "bi", "data-id": it.id }, ...["e", "s", "se"].map(d => el("div", { class: `brz ${d}`, "data-dir": d }))); wraps.set(it.id, w); container.append(w); }
      const h0 = it.node.querySelector(it.head);
      if (h0) { h0.classList.add("bhead"); h0.tabIndex = 0; h0.title = "끌거나 방향키로 옮기고, Shift+방향키로 크기를 바꿔요"; }
      const first = w.firstElementChild, old = first && !first.classList.contains("brz") ? first : null;
      // A card whose markup did not change keeps its node, so scroll positions and hover survive a re-render.
      if (old !== it.node && !(old && old.outerHTML === it.node.outerHTML)) {
        const top = old ? old.scrollTop : 0, oh = old && old.querySelector(it.head), refocus = !!oh && document.activeElement === oh;
        if (old) old.replaceWith(it.node); else w.prepend(it.node);
        if (top) it.node.scrollTop = top;
        if (refocus && h0) h0.focus({ preventScroll: true });
      }
    }
    bar.hidden = !items.length;
    paint();
  }
  function reset() {
    if (opts.onReset) opts.onReset();
    saved = {}; ghost = []; lastJson = "{}";
    try { localStorage.removeItem(store); } catch { /* ignore */ }
    set(cur);
  }
  function settle() {
    const p = pending; pending = null;
    if (p) set(...p); else paint();
  }
  const L = [["pointermove", ev => move(ev)], ["pointerup", ev => up(ev)], ["pointercancel", ev => cancel(ev)], ["keydown", ev => { if (ev.key === "Escape" && act) { ev.preventDefault(); cancel(); } }], ["touchmove", ev => { if (act && act.on) ev.preventDefault(); }, { passive: false }]];
  function finish() {
    for (const [t, fn, o] of L) window.removeEventListener(t, fn, o);
    clearTimeout(act.timer); cancelAnimationFrame(act.raf);
    act.w.classList.remove("bdrag", "bpress"); ph.hidden = true; document.body.classList.remove("boarding");
    const a = act; act = null; return a;
  }
  // Auto-scroll: the scroller moves while the pointer rests near its edge, and the card is re-placed under the pointer each frame.
  function tick() {
    if (!act || !act.on) return;
    act.raf = requestAnimationFrame(tick);
    const vr = views.getBoundingClientRect(), y = act.cy;
    const d = y < vr.top + B_EDGE ? -(vr.top + B_EDGE - y) : y > vr.bottom - B_EDGE ? y - (vr.bottom - B_EDGE) : 0;
    if (!d) return;
    const before = views.scrollTop;
    views.scrollTop += Math.sign(d) * Math.min(B_SCROLL, Math.ceil(Math.abs(d) / B_EDGE * B_SCROLL));
    if (views.scrollTop !== before) track();
  }
  function begin() {
    const wr = act.w.getBoundingClientRect();
    act.on = true; act.ox = act.x0 - wr.left; act.oy = act.y0 - wr.top; act.w0 = wr.width; act.h0 = wr.height; act.s0 = views.scrollTop;
    closeMenu(false);
    act.w.classList.add("bdrag");
    if (act.mode === "order") beginOrder(); else { pos(ph, act.r); ph.hidden = false; }
    document.body.classList.add("boarding");
    const s = getSelection(); if (s) s.removeAllRanges();
    act.raf = requestAnimationFrame(tick);
  }
  // Narrow: the cards in column order with their boxes; the lifted card follows the finger, the ones it passes slide by its height.
  function beginOrder() {
    const rows = bOrder(lay.map(r => ({ ...r }))).map(r => wraps.get(r.id)).filter(Boolean);
    act.rows = rows; act.from = rows.indexOf(act.w); act.to = act.from;
    act.rects = rows.map(w => w.getBoundingClientRect());
    act.gap = rows.length > 1 ? Math.max(0, act.rects[1].top - act.rects[0].bottom) : BGAP;
    container.classList.add("ordering");
  }
  function trackOrder() {
    // boxes were measured at the lift; the finger's place is taken back to that scroll position before comparing
    const dy = act.cy - act.y0 + (views.scrollTop - act.s0), h = act.h0 + act.gap, c = act.rects[act.from].top + act.h0 / 2 + dy;
    act.to = act.rects.filter((r, i) => i !== act.from && r.top + r.height / 2 < c).length;
    act.w.style.transform = `translateY(${dy}px)`;
    act.rows.forEach((w, i) => { if (i !== act.from) w.style.transform = act.from < act.to && i > act.from && i <= act.to ? `translateY(${-h}px)` : act.from > act.to && i < act.from && i >= act.to ? `translateY(${h}px)` : ""; });
  }
  // The dropped card settles into its slot: the others already sit where the new order puts them, the lifted one slides the rest of the way.
  function endOrder(drop) {
    const { w, rows, from, to } = act, top = w.getBoundingClientRect().top;
    rows.forEach(r => { r.style.transition = "none"; r.style.transform = ""; });
    container.classList.remove("ordering");
    if (drop && to !== from) {
      const ids = rows.map(r => r.dataset.id); ids.splice(to, 0, ids.splice(from, 1)[0]);
      reorder(ids, act.id);
    }
    const dy = top - w.getBoundingClientRect().top;
    w.classList.remove("bdrag");
    if (dy) { w.style.transition = "none"; w.style.transform = `translateY(${dy}px)`; void w.offsetHeight; }
    rows.forEach(r => { r.style.transition = ""; });
    w.style.transform = "";
  }
  // The grid rewritten so that its reading order is `ids`: the moved card takes the place of the card now after it (pushing that one
  // down), and when compaction still leaves another order, the cards flow again in `ids` order with their sizes kept.
  function reorder(ids, moved) {
    const order = list => bOrder(list.map(r => ({ ...r }))).map(r => r.id).join("\0");
    if (order(lay) === ids.join("\0")) return;
    let list = lay.map(r => ({ ...r }));
    const t = list.find(r => r.id === moved), i = ids.indexOf(moved), nxt = list.find(r => r.id === ids[i + 1]), prv = list.find(r => r.id === ids[i - 1]);
    if (!t) return;
    if (nxt) { t.x = Math.min(nxt.x, BCOLS - t.w); t.y = nxt.y; } else if (prv) { t.x = Math.min(prv.x, BCOLS - t.w); t.y = prv.y + prv.h; }
    bPush(list, t); bCompact(list, moved, ghost); bEven(list, null, moved);
    if (order(list) !== ids.join("\0")) {
      list = bFlow(ids.map(id => lay.find(r => r.id === id)).filter(Boolean).map(r => ({ ...r })));
      bEven(list, null, null);
    }
    lay = list; persist(); paint();
  }
  // The pointer's latest place applied to the lifted card.
  function track() {
    if (!act || !act.on) return;
    if (act.mode === "order") return trackOrder();
    const cr = container.getBoundingClientRect(), step = (cr.width + BGAP) / BCOLS, { it, w, r, mode } = act, dx = act.cx - act.x0, dy = act.cy - act.y0;
    if (mode === "move") {
      const left = act.cx - cr.left - act.ox, top = act.cy - cr.top - act.oy;
      w.style.left = `${left}px`; w.style.top = `${top}px`;
      preview({ x: bClamp(Math.round(left / step), 0, BCOLS - r.w), y: Math.max(0, Math.round(top / BSTEP)) });
    } else {
      const maxW = Math.min(it.max.w, BCOLS - r.x), minW = Math.min(it.min.w, maxW);
      const pw = bClamp(act.w0 + (mode.includes("e") ? dx : 0), minW * step - BGAP, maxW * step - BGAP);
      const pht = bClamp(act.h0 + (mode.includes("s") ? dy : 0), it.min.h * BSTEP - BGAP, it.max.h * BSTEP - BGAP);
      w.style.width = `${pw}px`; w.style.height = `${pht}px`;
      preview({ w: bClamp(Math.round((pw + BGAP) / step), minW, maxW), h: bClamp(Math.round((pht + BGAP) / BSTEP), it.min.h, it.max.h) });
    }
  }
  function preview(patch) {
    const key = JSON.stringify(patch);
    if (key === act.key) return;
    act.key = key;
    const list = act.base.map(x => ({ ...x })), t = list.find(x => x.id === act.id);
    Object.assign(t, patch);
    bPush(list, t); bCompact(list, act.id, ghost); bEven(list, act.mode === "move" ? null : act.id, act.id);
    act.next = list; paint(list, act.id);
  }
  function move(ev) {
    if (!act || ev.pointerId !== act.pid) return;
    act.cx = ev.clientX; act.cy = ev.clientY;
    const dist = Math.hypot(ev.clientX - act.x0, ev.clientY - act.y0);
    if (!act.on) {
      // a touch that moves before the long press is a scroll, not a drag; a mouse drags after 4px
      if (act.press) { if (dist >= 8) { finish(); settle(); } return; }
      if (dist < 4) return;
      begin();
    }
    track();
  }
  function up(ev) {
    if (!act || ev.pointerId !== act.pid) return;
    const on = act.on;
    if (on && act.mode === "order") endOrder(true);
    const a = finish();
    if (on) {
      if (a.mode !== "order" && a.next) { lay = a.next; persist(); }
      swallow = true; setTimeout(() => { swallow = false; }, 60);
    }
    settle();
  }
  // The pointer was lost (the browser took it for a scroll) or Esc was pressed: the card goes back where it was.
  function cancel(ev) {
    if (!act || (ev && ev.pointerId !== act.pid)) return;
    const on = act.on;
    if (on && act.mode === "order") endOrder(false);
    const a = finish();
    if (on) { a.next = null; swallow = true; setTimeout(() => { swallow = false; }, 60); }
    settle();
  }
  container.addEventListener("pointerdown", ev => {
    if (act || (ev.pointerType === "mouse" ? ev.button !== 0 : !ev.isPrimary)) return;   // a second finger never starts a drag
    const w = ev.target.closest(".bi"), it = w && container.contains(w) && meta(w.dataset.id);
    if (!it) return;
    const narrow = narrowMQ.matches, rz = !narrow && ev.target.closest(".brz");
    if (!rz) { const h = ev.target.closest(it.head); if (!h || !w.contains(h) || ev.target.closest(B_IGNORE)) return; }
    else ev.preventDefault();
    // a finger on a narrow board drags after a long press (a move before that scrolls); a mouse drags at once
    const press = narrow && ev.pointerType !== "mouse";
    act = { id: it.id, it, w, mode: rz ? rz.dataset.dir : narrow ? "order" : "move", pid: ev.pointerId, x0: ev.clientX, y0: ev.clientY, cx: ev.clientX, cy: ev.clientY, on: false, press, timer: 0, raf: 0, base: lay.map(x => ({ ...x })), r: lay.find(x => x.id === it.id), key: "", next: null };
    for (const [t, fn, o] of L) window.addEventListener(t, fn, o);
    if (press) { w.classList.add("bpress"); act.timer = setTimeout(() => { if (act && act.press) { act.press = false; begin(); } }, B_PRESS); }
    else if (rz) begin();
  });
  container.addEventListener("click", ev => { if (swallow) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  container.addEventListener("keydown", ev => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!d || act || !ev.target.classList.contains("bhead")) return;
    const w = ev.target.closest(".bi"), it = w && meta(w.dataset.id), r = it && lay.find(x => x.id === it.id);
    if (!r) return;
    ev.preventDefault();
    // one column: up and down move the card one place in the order
    if (narrowMQ.matches) {
      if (ev.shiftKey || !d[1]) return;
      const ids = bOrder(lay.map(x => ({ ...x }))).map(x => x.id), i = ids.indexOf(it.id), j = i + d[1];
      if (j < 0 || j >= ids.length) return;
      ids.splice(j, 0, ids.splice(i, 1)[0]);
      reorder(ids, it.id);
      const h = w.querySelector(it.head); if (h) h.focus({ preventScroll: true });
      return;
    }
    const list = lay.map(x => ({ ...x })), t = list.find(x => x.id === it.id);
    Object.assign(t, bFit(ev.shiftKey ? { ...r, w: r.w + d[0], h: r.h + d[1] } : { ...r, x: r.x + d[0], y: r.y + d[1] }, it));
    bPush(list, t); bCompact(list, it.id, ghost); bEven(list, ev.shiftKey ? it.id : null, it.id);
    lay = list; persist(); paint();
  });
  // Size one card from code (a preset in its ⋯ menu): the same push, compact and persist as Shift+arrow.
  function resize(id, w, h) {
    const it = meta(id), r = lay.find(x => x.id === id);
    if (!it || !r) return;
    const list = lay.map(x => ({ ...x })), t = list.find(x => x.id === id);
    Object.assign(t, bFit({ ...r, w, h }, it));
    bPush(list, t); bCompact(list, id, ghost); bEven(list, id, id);
    lay = list; persist(); paint();
  }
  // Move one card before another (or to the end with `before` null), the way a drop on a narrow board does; the ⋯ menu offers it too.
  function moveBefore(id, before) {
    const ids = bOrder(lay.map(x => ({ ...x }))).map(x => x.id).filter(x => x !== id);
    const i = before ? ids.indexOf(before) : -1;
    ids.splice(i < 0 ? ids.length : i, 0, id);
    reorder(ids, id);
  }
  const board = { set, reset, paint, bar, resize, moveBefore, order: () => bOrder(lay.map(x => ({ ...x }))).map(x => x.id), cancel: () => { if (act) cancel(); } };
  boards.add(board);
  return board;
}
