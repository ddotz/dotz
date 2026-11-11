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

// A sheet or dialog opens: on a phone it slides up from the bottom edge, wider it fades in 16px low; box and scrim take one length (--m-base), so they end together.
// The close is motionSheetOut: a plain 150ms fade, nothing moves.
function motionSheet(box, scrim) {
  if (reducedMotion()) return;
  if (box && box.animate) box.animate(phoneWide() ? [{ transform: "translateY(100%)" }, { transform: "none" }] : [{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: M_MS.base, easing: M_EASE });
  if (scrim && scrim.animate) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M_MS.base, easing: M_EASE });
}
const motionSheetOut = (...els) => Promise.all(els.filter(Boolean).map(e => motionOut(e, "fade", M_MS.fast)));

// A native <dialog> (dialog(), the palette): it opens with the sheet motion (the palette: scale .98 -> 1, --m-fast), and its close() fades it out first
// (150ms, [data-leaving] fades the ::backdrop in CSS), so every d.close() caller, Esc and the back button included, gets the same leave.
function motionDialog(d, enter = "sheet") {
  if (reducedMotion() || !d.animate) return;
  if (enter === "pop") d.animate([{ opacity: 0, transform: "scale(.98)" }, { opacity: 1, transform: "scale(1)" }], { duration: M_MS.fast, easing: M_EASE });
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

// A count badge that went from nothing to a number: it pops in (scale .6 -> 1, --m-base).
function motionPop(el) {
  if (!el || !el.animate || reducedMotion()) return;
  el.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: M_MS.base, easing: M_EASE });
}

// The owner moved to a different view (go(), 05-command-palette.js): the shown view rises in and its first 8 rows follow 12ms apart, all in about 240ms.
// The first paint and a go() to the view already shown draw as before, and data that loads later never calls this, so a refresh never replays it.
let viewSeen = "";
function motionView(name, boxes, rows = true) {
  const was = viewSeen; viewSeen = name;
  if (!was || was === name || reducedMotion()) return;
  for (const b of boxes) motionIn(b, "rise", M_MS.fast);
  if (!rows) return;
  const picked = [];
  for (const b of boxes) for (const r of b.querySelectorAll(".li, .card, .rc, .cv-row, .hr, .pj-card")) if (r.offsetParent && !picked.some(p => p.contains(r))) picked.push(r);
  picked.slice(0, 8).forEach((r, i) => motionIn(r, "rise", M_MS.fast, i * 12));
}

// An element about to leave: resolves when it is gone from view, so the caller removes or hides it then.
function motionOut(el, to = "fade", ms = M_MS.fast) {
  if (!el || !el.animate || reducedMotion()) return Promise.resolve();
  const a = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: M_FROM[to] || "none" }], { duration: ms, easing: M_EASE, fill: "forwards" });
  return a.finished.then(() => a, () => a);
}

// The same element changes state in place (보내기 -> 보냈어요, a task finishing): change() runs at once, the new look fades up at its own size.
function motionSwap(el, change, ms = M_MS.base) {
  change();
  if (!el || !el.animate || reducedMotion()) return;
  el.animate([{ opacity: .35 }, { opacity: 1 }], { duration: ms, easing: M_EASE });
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

// A result the hub confirmed (approved, sent, dropped, answered, dismissed, moved): the card or row folds away and what was under it rises into
// its place, so the owner sees it really went. Call it only after the hub said yes; on a failure the card stays and the button comes back.
// How (compositor only, one layout at the start): the leaving element is lifted out of the flow at its own spot (position absolute, same
// box) and fades (--m-fast); its neighbours take their final places at once and are moved back by transform, then glide there (--m-base).
// While they glide they are inert, so a second tap on the same spot does not press the next card's button. Focus that was inside the
// leaving element goes to the row that took its place. Resolves (and fires "motion-gone" on document, detail.el) once it is out of the DOM;
// with prefers-reduced-motion it is removed at once and only the short tap guard remains.
// o.keep: a box that is used again (the decision dock) is hidden and given its own styles back instead of removed. o.with: more elements
// that move when it goes but are not after it (the conversation above the dock, which grows into the freed room).
const M_GONE = new WeakMap(), M_LATER = new WeakMap(), M_STAY = new WeakMap();
const mFocusable = "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
function motionGone(el, o = {}) {
  if (!el || !el.isConnected) return Promise.resolve();
  if (M_GONE.has(el)) return M_GONE.get(el);
  const p = mGone(el, o);
  M_GONE.set(el, p);
  if (o.keep) p.then(() => M_GONE.delete(el));
  return p;
}
// A kept box (o.keep) that is needed again before it is gone (a new question for the dock): it stops leaving and stands as it was.
// Its motionGone resolves false. True when there was a leave to stop.
function motionStay(el) {
  const stop = el && M_STAY.get(el);
  if (stop) stop();
  return !!stop;
}
const M_GONE_STYLE = ["position", "left", "top", "width", "height", "margin", "boxSizing", "zIndex", "pointerEvents", "translate"];
// The list box the row leaves (a white card with rounded, clipping corners) would shrink at once and cut the rows still gliding up at its bottom.
// It keeps its height while what follows it takes its place at once (a negative bottom margin, so the next boxes glide like the rows), and
// its bottom edge is wiped up with a clip-path on the same curve, so the card closes as the last row arrives. Several rows leaving the same
// box add up. When the last one is gone the box gets its own styles back and lays out at exactly the size the clip showed.
const M_FOLD = new WeakMap();
function mFold(p, before) {
  const shrink = before.height - p.getBoundingClientRect().height;
  if (shrink < 0.5) return null;
  const cs = getComputedStyle(p);
  let f = M_FOLD.get(p);
  if (!f) { f = { total: 0, n: 0, h: before.height, base: parseFloat(cs.marginBottom) || 0, keep: [p.style.minHeight, p.style.marginBottom], anim: null }; M_FOLD.set(p, f); }
  const at = f.anim ? Number((/inset\(\S+ \S+ ([\d.]+)px/.exec(getComputedStyle(p).clipPath) || [])[1] || 0) : 0;
  if (f.anim) f.anim.cancel();
  f.total += shrink; f.n++;
  p.style.minHeight = `${f.h}px`; p.style.marginBottom = `${f.base - f.total}px`;
  const r = cs.borderBottomLeftRadius;
  f.anim = p.animate([{ clipPath: `inset(0px 0px ${at}px 0px round ${r})` }, { clipPath: `inset(0px 0px ${f.total}px 0px round ${r})` }], { duration: M_MS.base, easing: M_EASE, fill: "forwards" });
  return f;
}
function mUnfold(p) {
  const f = p && M_FOLD.get(p);
  if (!f || --f.n > 0) return;
  M_FOLD.delete(p);
  f.anim.cancel();
  [p.style.minHeight, p.style.marginBottom] = f.keep;
}
const mUnstyle = el => { delete el.dataset.gone; el.removeAttribute("aria-hidden"); for (const k of M_GONE_STYLE) el.style[k] = ""; };
async function mGone(el, o) {
  const parent = el.parentElement, after = el.nextElementSibling, before = el.previousElementSibling, hadFocus = el.contains(document.activeElement);
  el.dataset.gone = "1"; el.setAttribute("aria-hidden", "true"); el.style.pointerEvents = "none";
  // Movers: what follows the element in its list and in the two lists around it, on screen (what is off screen just takes its place).
  const movers = (o.with || []).filter(Boolean).map(s => [s, s.getBoundingClientRect()]);
  for (let n = el, lv = 0; n && n.parentElement && lv < 3; n = n.parentElement, lv++)
    for (let s = n.nextElementSibling; s && movers.length < 30; s = s.nextElementSibling) {
      const r = s.getBoundingClientRect();
      if (r.height || r.width) { if (r.top > innerHeight) break; movers.push([s, r]); }
    }
  const box = el.getBoundingClientRect(), quiet = reducedMotion() || !el.animate, pbox = parent && parent.getBoundingClientRect();
  let fold = null;
  const done = () => {
    if (o.keep) {
      for (const a of el.getAnimations()) a.cancel();
      el.hidden = true; mUnstyle(el);
    } else el.remove();
    if (fold) mUnfold(parent);
    if (hadFocus) {
      const to = [after, before].find(n => n && n.isConnected && !n.dataset.gone), f = to && (to.matches(mFocusable) ? to : to.querySelector(mFocusable));
      if (f) f.focus({ preventScroll: true });
      else if (parent && parent.isConnected) { if (!parent.hasAttribute("tabindex")) parent.tabIndex = -1; parent.focus({ preventScroll: true }); }
    }
    document.dispatchEvent(new CustomEvent("motion-gone", { detail: { el } }));
    mLater(parent);
  };
  const guard = movers.map(([s]) => s).filter(s => !s.inert && !s.contains(document.activeElement));
  for (const s of guard) s.inert = true;
  const unguard = () => { for (const s of guard) s.inert = false; };
  if (quiet) { done(); setTimeout(unguard, M_MS.base); return true; }
  // Lift it out at its own box: offsets from its offsetParent, so it stays on the same spot inside the same styles.
  const left = el.offsetLeft, top = el.offsetTop;
  Object.assign(el.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${box.width}px`, height: `${box.height}px`, margin: "0", boxSizing: "border-box", zIndex: "0" });
  // A container held at its bottom (the composer) moves its top when the element leaves its flow: the lifted element is put back on its spot.
  const lifted = el.getBoundingClientRect();
  if (Math.abs(lifted.top - box.top) > 0.5 || Math.abs(lifted.left - box.left) > 0.5) el.style.translate = `${box.left - lifted.left}px ${box.top - lifted.top}px`;
  if (!o.keep && parent) fold = mFold(parent, pbox);
  const glides = [];
  for (const [s, r] of movers) {
    const now = s.getBoundingClientRect(), dx = r.left - now.left, dy = r.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    glides.push(s.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: M_MS.base, easing: M_EASE, composite: "add" }));   // added to a glide already running (several rows leaving at once) and to its own transform
  }
  const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: M_MS.fast, easing: M_EASE, fill: "forwards" });
  let stayed = false;
  if (o.keep) M_STAY.set(el, () => { stayed = true; for (const a of [fade, ...glides]) a.cancel(); mUnstyle(el); });
  await Promise.all([fade, ...glides].map(a => a.finished.catch(() => {})));
  M_STAY.delete(el);
  unguard();
  if (stayed) { mLater(parent); return false; }
  done();
  return true;
}
// A list that is drawn again as a whole (innerHTML, a render function) while one of its rows folds away: the redraw waits until the row
// is gone, so it neither cuts the motion nor draws the row back; only the last redraw asked for runs. Returns true when it waited.
function motionAfter(box, fn) {
  if (!box || !box.querySelector("[data-gone]")) return false;
  M_LATER.set(box, fn);
  return true;
}
function mLater(parent) {
  for (let n = parent; n; n = n.parentElement) {
    const fn = M_LATER.get(n);
    if (fn && !n.querySelector("[data-gone]")) { M_LATER.delete(n); fn(); }
  }
}
// The press of a button whose result comes from the hub: it says what it is doing (보내는 중…) at its own width and takes no second press.
// Returns the undo for a failure (the button comes back as it was); on success the card leaves through motionGone and takes it along.
function pressWait(btn, label) {
  if (!btn) return () => {};
  const was = [...btn.childNodes], dis = btn.disabled;
  btn.style.minWidth = `${btn.offsetWidth}px`;
  if (label) btn.textContent = label;
  btn.disabled = true; btn.setAttribute("aria-busy", "true");
  return () => { if (label) btn.replaceChildren(...was); btn.disabled = dis; btn.removeAttribute("aria-busy"); btn.style.minWidth = ""; };
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
