// Motion with a cause (web/DESIGN.md Motion, site/prototype/MOTION.md). Web Animations on transform/opacity only, so nothing is laid out
// again and nothing is left behind when an animation ends; durations and the curve are the CSS tokens (--m-fast/--m-base/--m-slow,
// --m-ease), and with prefers-reduced-motion every helper is an instant change.
const M_EASE = "cubic-bezier(.2, .7, .2, 1)";   // --m-ease
const M_MS = { fast: 150, base: 220, slow: 300 }; // --m-fast, --m-base, --m-slow
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const M_FROM = { rise: "translateY(8px)", top: "translateY(-8px)", fade: "none", side: "translateX(12px)" };

// An element that just arrived: a card rising in, a new row sliding in at the top of its list, a sheet opening.
function motionIn(el, from = "rise", ms = M_MS.base, delay = 0) {
  if (!el || !el.animate || reducedMotion()) return;
  el.animate([{ opacity: 0, transform: M_FROM[from] || M_FROM.rise }, { opacity: 1, transform: "none" }], { duration: ms, delay, easing: M_EASE, fill: "backwards" });
}

const phoneWide = () => matchMedia("(max-width: 639px)").matches;

// A sheet or dialog opens: on a phone it slides up from the bottom edge, wider it fades in 16px low (both 280ms); its scrim fades in (220ms).
// The close is motionSheetOut: a plain 150ms fade, nothing moves.
function motionSheet(box, scrim) {
  if (reducedMotion()) return;
  if (box && box.animate) box.animate(phoneWide() ? [{ transform: "translateY(100%)" }, { transform: "none" }] : [{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: M_EASE });
  if (scrim && scrim.animate) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M_MS.base, easing: M_EASE });
}
const motionSheetOut = (...els) => Promise.all(els.filter(Boolean).map(e => motionOut(e, "fade", M_MS.fast)));

// A native <dialog> (dialog(), the palette): it opens with the sheet motion (the palette: scale .98 -> 1, 180ms), and its close() fades it out first
// (150ms, [data-leaving] fades the ::backdrop in CSS), so every d.close() caller, Esc and the back button included, gets the same leave.
function motionDialog(d, enter = "sheet") {
  if (reducedMotion() || !d.animate) return;
  if (enter === "pop") d.animate([{ opacity: 0, transform: "scale(.98)" }, { opacity: 1, transform: "scale(1)" }], { duration: 180, easing: M_EASE });
  else motionSheet(d);
  const real = d.close.bind(d); let leaving = false;
  d.close = rv => {
    if (!d.open) { real(rv); return; }
    if (leaving) return;
    leaving = true; d.dataset.leaving = "1"; d.style.pointerEvents = "none";
    motionOut(d, "fade", M_MS.fast).then(() => real(rv));
  };
  d.addEventListener("cancel", ev => { if (ev.defaultPrevented) return; ev.preventDefault(); d.close(); });
}

// A count badge that went from nothing to a number: it pops in (scale .6 -> 1, 200ms).
function motionPop(el) {
  if (!el || !el.animate || reducedMotion()) return;
  el.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, easing: M_EASE });
}

// The owner moved to a different view (go(), 05-command-palette.js): the shown view rises in and its first 8 rows follow 35ms apart.
// The first paint and a go() to the view already shown draw as before, and data that loads later never calls this, so a refresh never replays it.
let viewSeen = "";
function motionView(name, boxes, rows = true) {
  const was = viewSeen; viewSeen = name;
  if (!was || was === name || reducedMotion()) return;
  for (const b of boxes) motionIn(b, "rise", M_MS.base);
  if (!rows) return;
  const picked = [];
  for (const b of boxes) for (const r of b.querySelectorAll(".li, .card, .rc, .cv-row, .hr, .pj-card")) if (r.offsetParent && !picked.some(p => p.contains(r))) picked.push(r);
  picked.slice(0, 8).forEach((r, i) => motionIn(r, "rise", M_MS.base, i * 35));
}

// An element about to leave: resolves when it is gone from view, so the caller removes or hides it then.
function motionOut(el, to = "fade", ms = M_MS.fast) {
  if (!el || !el.animate || reducedMotion()) return Promise.resolve();
  const a = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: M_FROM[to] || "none" }], { duration: ms, easing: M_EASE, fill: "forwards" });
  return a.finished.then(() => a, () => a);
}

// The same element changes state in place (보내기 -> 보냈어요, a task finishing): change() runs at once, the new look fades up.
function motionSwap(el, change, ms = M_MS.base) {
  change();
  if (!el || !el.animate || reducedMotion()) return;
  el.animate([{ opacity: .35, transform: "scale(.985)" }, { opacity: 1, transform: "none" }], { duration: ms, easing: M_EASE });
}

// A count that changed: only the digits that differ roll in. textContent stays the plain number.
function rollCount(el, next) {
  if (!el) return;
  const now = String(next ?? ""), was = el.textContent;
  if (now === was) return;
  if (reducedMotion() || !was || !/^\d+$/.test(now) || !/^\d+$/.test(was)) { el.textContent = now; return; }
  const up = Number(now) > Number(was), pad = was.padStart(now.length, " ");
  el.textContent = "";
  for (let i = 0; i < now.length; i++) {
    const d = document.createElement("span");
    d.className = "m-dg"; d.textContent = now[i]; el.append(d);
    if (pad[pad.length - now.length + i] !== now[i] && d.animate)
      d.animate([{ opacity: 0, transform: `translateY(${up ? "60%" : "-60%"})` }, { opacity: 1, transform: "none" }], { duration: M_MS.base, easing: M_EASE });
  }
}

// Which of these keys were not there on the last paint of the same list. The first paint returns none, so opening a screen
// never animates what was already there; only items that really arrive do.
function freshKeys(store, keys) {
  const seeded = store.size > 0 || store.seeded, out = new Set();
  for (const k of keys) if (seeded && !store.has(k)) out.add(k);
  store.clear(); for (const k of keys) store.add(k);
  store.seeded = true;
  return out;
}
