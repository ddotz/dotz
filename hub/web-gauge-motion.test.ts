// The usage gauges (web/js/01-motion-gauge.js): a rise in what is left counts up and fills over one eased motion, everything else stays
// calm, and whatever happens in the middle the last pushed value is what ends up shown. Time is a clock the test moves by hand.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "js", "01-motion-gauge.js"), "utf8");
type Shown = { w: number; n: number; moving: boolean; gd: number };

function gauges(reduced = false) {
	const doc = { hidden: false };
	const clock = { t: 0, queue: [] as (() => void)[] };
	const scope = { reducedMotion: () => reduced, document: doc, el: () => ({}), performance: { now: () => clock.t }, requestAnimationFrame: () => 0 };
	const mod = new Function("scope", "with (scope) { " + src + "\nreturn { gaugeSet, gaugeForget, gaugeEase, GAUGE_CLOCK, GAUGE_MS }; }")(scope);
	mod.GAUGE_CLOCK.now = () => clock.t;
	mod.GAUGE_CLOCK.raf = (cb: () => void) => (clock.queue.push(cb), clock.queue.length);
	const shown: Shown[] = [];
	const paint = (s: Shown) => shown.push({ ...s });
	const last = () => shown[shown.length - 1]!;
	// moves the clock and runs the frame that was asked for
	const advance = (ms: number) => { clock.t += ms; const q = clock.queue.splice(0); for (const f of q) f(); };
	return { ...mod, doc, paint, shown, last, advance, pending: () => clock.queue.length };
}

test("the first paint shows the value as it is, with no motion", () => {
	const g = gauges();
	g.gaugeSet("a", 40, g.paint);
	expect(g.shown).toEqual([{ w: 40, n: 40, moving: false, gd: 2 }]);
	expect(g.pending()).toBe(0);
});

test("a recovery fills and counts up, then ends on the new value", () => {
	const g = gauges();
	g.gaugeSet("a", 20, g.paint);
	g.gaugeSet("a", 80, g.paint);
	expect(g.last()).toMatchObject({ w: 20, n: 20, moving: true });
	let prev = 20;
	for (let i = 0; i < 30 && g.pending(); i++) {
		g.advance(50);
		expect(g.last().w).toBeGreaterThanOrEqual(prev);
		prev = g.last().w;
	}
	expect(g.pending()).toBe(0);
	expect(g.last()).toEqual({ w: 80, n: 80, moving: false, gd: 2 });
	const mid = g.shown.filter(s => s.moving && s.n > 20 && s.n < 80);
	expect(mid.length).toBeGreaterThan(3);
});

test("the motion is ease-out and a recovery takes between 600 and 900 ms", () => {
	const g = gauges();
	expect(g.gaugeEase(.5)).toBeGreaterThan(.5);
	expect(g.gaugeEase(0)).toBe(0);
	expect(g.gaugeEase(1)).toBe(1);
	g.gaugeSet("a", 10, g.paint);
	g.gaugeSet("a", 100, g.paint);
	g.advance(590);
	expect(g.pending()).toBe(1);
	g.advance(310);
	expect(g.pending()).toBe(0);
	expect(g.last().w).toBe(100);
});

test("a small decrease keeps the number plain and only the bar glides", () => {
	const g = gauges();
	g.gaugeSet("a", 80, g.paint);
	g.gaugeSet("a", 78, g.paint);
	expect(g.last()).toMatchObject({ n: 78, moving: false });
	g.advance(g.GAUGE_MS.calm);
	expect(g.last()).toEqual({ w: 78, n: 78, moving: false, gd: 2 });
});

test("a small rise is the window sliding: no count", () => {
	const g = gauges();
	g.gaugeSet("a", 50, g.paint);
	g.gaugeSet("a", 51, g.paint);
	expect(g.last()).toMatchObject({ n: 51, moving: false });
});

test("a redraw in the middle carries on from what is shown", () => {
	const g = gauges();
	g.gaugeSet("a", 20, g.paint);
	g.gaugeSet("a", 80, g.paint);
	g.advance(300);
	const mid = g.last().w;
	expect(mid).toBeGreaterThan(20);
	const again: Shown[] = [];
	g.gaugeSet("a", 80, s => again.push({ ...s }));
	expect(again[0]).toMatchObject({ w: mid, moving: true });
	g.advance(900);
	expect(again[again.length - 1]).toEqual({ w: 80, n: 80, moving: false, gd: 2 });
});

test("a newer value in the middle ends on the latest one, rises or falls", () => {
	const up = gauges();
	up.gaugeSet("a", 20, up.paint);
	up.gaugeSet("a", 60, up.paint);
	up.advance(200);
	const mid = up.last().w;
	up.gaugeSet("a", 90, up.paint);
	expect(up.last().w).toBe(mid);
	up.advance(2000);
	expect(up.last()).toEqual({ w: 90, n: 90, moving: false, gd: 2 });
	const down = gauges();
	down.gaugeSet("a", 20, down.paint);
	down.gaugeSet("a", 80, down.paint);
	down.advance(200);
	down.gaugeSet("a", 30, down.paint);
	expect(down.last()).toMatchObject({ n: 30, moving: false });
	down.advance(2000);
	expect(down.last()).toEqual({ w: 30, n: 30, moving: false, gd: 2 });
	expect(down.pending()).toBe(0);
});

test("with reduced motion, or on a hidden page, the value changes at once", () => {
	const reduced = gauges(true), hidden = gauges();
	hidden.doc.hidden = true;
	for (const g of [reduced, hidden]) {
		g.gaugeSet("a", 20, g.paint);
		g.gaugeSet("a", 80, g.paint);
		expect(g.last()).toEqual({ w: 80, n: 80, moving: false, gd: 2 });
		expect(g.pending()).toBe(0);
	}
});

test("a forgotten gauge draws its next value at once", () => {
	const g = gauges();
	g.gaugeSet("usage:x", 20, g.paint);
	g.gaugeForget("usage:");
	g.gaugeSet("usage:x", 80, g.paint);
	expect(g.last()).toEqual({ w: 80, n: 80, moving: false, gd: 2 });
	expect(g.pending()).toBe(0);
});
