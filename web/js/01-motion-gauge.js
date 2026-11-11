/* ---------- usage gauges: when what is left goes up, the bar fills and the number counts up (web/DESIGN.md Motion) ---------- */
// The top strip, the sidebar row and the 사용량 cards are drawn again from nothing on every usage read, so a motion cannot live on
// their elements. It lives here, keyed by gauge: gaugeSet(key, pct, paint) remembers what the gauge shows and hands `paint` (which closes
// over the elements drawn this time) the value to show, once now and then on each frame until it reaches pct.
//   up by GAUGE_STEP or more  -> the bar and the number run together, GAUGE_MS.min..max, the --m-ease curve (a recovery)
//   any other change          -> the bar glides GAUGE_MS.calm and the number is simply the new one (work eating the limit stays calm)
//   first paint / reduced motion / hidden page -> the value at once
// A redraw or a new value in the middle of a motion carries on from what is shown and ends on the latest pct.
// paint({ w, n, moving, gd }): w the bar width in percent (a fraction while moving), n the whole number to write, moving while the
// number counts, gd the digits of the final number (gaugeNum keeps that width while counting so nothing beside it moves).
const GAUGE_MS = { min: 600, max: 900, calm: 300 };   // a recovery grows with its size; --m-slow for the calm glide
const GAUGE_STEP = 3;                                  // points; a smaller rise is the window sliding, not a recovery
const GAUGE_MARK = "\u2063";                        // stands for the number inside a sentence from TX, see gaugeSplit
const GAUGE_CLOCK = { now: () => performance.now(), raf: cb => requestAnimationFrame(cb) };   // tests drive these two
const GAUGE = new Map();

// cubic-bezier(.2, .7, .2, 1) is --m-ease; the curve is solved for x by bisection (x1 = x2 = .2, so x(s) rises steadily)
function gaugeEase(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const at = (s, a, b) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (at(m, .2, .2) < t) lo = m; else hi = m; }
  return at((lo + hi) / 2, .7, 1);
}
function gaugePaint(g, moving) {
  const count = moving && g.count;
  g.paint({ w: g.cur, n: Math.round(count ? g.cur : g.target), moving: count, gd: String(Math.round(g.target)).length });
}
function gaugeFrame(g) {
  g.raf = 0;
  if (g.dead) return;
  const p = reducedMotion() ? 1 : Math.min(1, (GAUGE_CLOCK.now() - g.t0) / g.dur);
  g.cur = p >= 1 ? g.target : g.from + (g.target - g.from) * gaugeEase(p);
  gaugePaint(g, p < 1);
  if (p < 1) g.raf = GAUGE_CLOCK.raf(() => gaugeFrame(g));
}
function gaugeSet(key, pct, paint) {
  const target = Math.max(0, Math.min(100, Number(pct) || 0));
  let g = GAUGE.get(key);
  if (!g) { g = { target, cur: target, count: false, paint, raf: 0, dead: false }; GAUGE.set(key, g); gaugePaint(g, false); return; }
  g.paint = paint;
  if (target === g.target) { gaugePaint(g, !!g.raf); return; }   // a redraw: show what is shown now, the running motion goes on
  g.from = g.cur; g.target = target;
  if (reducedMotion() || document.hidden) { g.cur = target; g.count = false; gaugePaint(g, false); return; }
  g.count = Math.round(target) - Math.round(g.cur) >= GAUGE_STEP;
  g.dur = g.count ? Math.min(GAUGE_MS.max, GAUGE_MS.min + Math.abs(target - g.cur) * 3) : GAUGE_MS.calm;
  g.t0 = GAUGE_CLOCK.now();
  gaugePaint(g, true);
  if (!g.raf) g.raf = GAUGE_CLOCK.raf(() => gaugeFrame(g));
}
// Forget the gauges whose key starts with `prefix`: the next gaugeSet draws their value at once (opening a screen, a gauge that went away).
function gaugeForget(prefix) {
  for (const [k, g] of GAUGE) if (k.startsWith(prefix)) { g.dead = true; GAUGE.delete(k); }
}
// A sentence with its number in a span of its own: gaugeSplit(TX("k", { n: GAUGE_MARK })) -> { nodes, sp }; put `nodes` in the line and
// give `sp` to gaugeNum on each paint.
function gaugeSplit(text) {
  const [a, b = ""] = String(text).split(GAUGE_MARK), sp = el("span", { class: "gn" });
  return { nodes: [a, sp, b], sp };
}
function gaugeNum(sp, s) {
  sp.textContent = String(s.n);
  sp.classList.toggle("gn-live", s.moving);
  if (s.moving) sp.style.setProperty("--gd", String(s.gd));
}
