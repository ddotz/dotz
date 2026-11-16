import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ev, fakeHub, waitFor, type View } from "./test-web.ts";

// Golden behaviour trace (IS-8 of .omo/plans/web-structure.md): for every screen in hub/ui-surfaces.json, opened with its own `open` and
// waited on with its own `ready` at 390 and 1280 px, the requests the page issues, the address and history entries it leaves, the tags of
// the view it shows, the nav order, and where one back press lands. hub/web-golden.json is today's behaviour; a refactor that is meant to
// change nothing must leave it equal. DOTZ_GOLDEN_WRITE=1 rewrites the fixture instead of comparing (review its diff before committing).
//
// Fixed state: the page is served by fakeHub with slow timers, and before the app loads the head carries a frozen clock, the demo's fixtures
// and in-page transport (site/demo/fixtures.js, demo-api.js) and the kakao test fixture, as hub/layout-measure.ts does: the `ready` fields
// were written against that data (`reach: "demo"`). No /api/* request reaches the server, so the order of server answers never matters.
//
// Requests are recorded in the page in the order it issues them, as runs: one run is what one synchronous stretch of code issued (closed on
// the next microtask). Order inside a run is kept, so swapping two api() calls fails; runs are compared as a sorted list, so which of two
// independent callbacks ran first does not.
const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "web-golden.json");
const WRITE = process.env.DOTZ_GOLDEN_WRITE === "1";
const WIDTHS = [390, 1280];
const NOW = Date.UTC(2026, 10, 9, 3);
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const CLOCK = `(() => { const N = ${NOW}, D = Date; window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [N])); } static now() { return N; } }; })();`;
// Outermost wrapper of fetch and EventSource (installed after the demo transport): records "METHOD path?query" per run, and counts the
// requests whose body is not read yet, so settle() can tell when the page has stopped asking.
const CAPTURE = `(() => {
	const runs = []; let run = null, open = 0, seq = 0;
	const rec = s => { seq++; if (!run) { run = []; runs.push(run); queueMicrotask(() => { run = null; }); } run.push(s); };
	const path = raw => { const u = new URL(raw, location.href); return u.origin === location.origin ? u.pathname + u.search : u.href; };
	const f = window.fetch;
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		rec(String((init && init.method) || (typeof input === "object" && !(input instanceof URL) && input.method) || "GET").toUpperCase() + " " + path(raw));
		open++;
		const done = () => { open--; };
		const p = f.apply(this, arguments);
		p.then(r => { r.clone().arrayBuffer().then(done, done); }, done);
		return p;
	};
	// Page timeouts under 1 s (debounces, a read mark after a pause) still pending: their requests belong to the step that armed them. Slow ones are virtual (slowTimers).
	const timers = new Set(), st = window.setTimeout, ct = window.clearTimeout;
	window.setTimeout = function (fn, ms = 0, ...a) { if (ms >= 1000) return st.apply(this, arguments); const id = st(() => { timers.delete(id); fn(...a); }, ms); timers.add(id); return id; };
	window.clearTimeout = id => { timers.delete(id); ct(id); };
	const ES = window.EventSource;
	window.EventSource = Object.assign(function (url, o) { rec("SSE " + path(String(url))); return new ES(url, o); }, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
	// Settled: no request open, no short timeout pending, and no new request for two animation frames in a row.
	const settle = () => new Promise((res, rej) => { const t0 = performance.now(); let last = -1, quiet = 0;
		const tick = () => { if (open === 0 && timers.size === 0 && seq === last) quiet++; else { quiet = 0; last = seq; }
			if (quiet >= 2) return res(0); if (performance.now() - t0 > 8000) return rej(new Error("page not settled after 8 s (" + open + " open, " + timers.size + " short timeouts)")); requestAnimationFrame(tick); };
		requestAnimationFrame(tick); });
	// The view's elements as "tag#id.class" lines indented by depth (no text, no style); a run of identical sibling subtrees is one entry with "*n".
	const sk = (el, d) => { const head = " ".repeat(d) + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + [...el.classList].map(c => "." + c).join("");
		if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return [head];
		const kids = []; let prev = null, key = "", n = 0;
		const flush = () => { if (!prev) return; if (n > 1) prev = [prev[0] + " *" + n, ...prev.slice(1)]; kids.push(...prev); };
		for (const c of el.children) { const s = sk(c, d + 1), k = s.join("\\n"); if (prev && k === key) { n++; continue; } flush(); prev = s; key = k; n = 1; }
		flush();
		return [head, ...kids]; };
	window.__golden = {
		take: () => { const r = runs.splice(0).map(x => x.join(" | ")); run = null; return r.sort(); },
		settle,
		views: () => [...document.querySelectorAll("#views > .view:not([hidden])")].flatMap(v => sk(v, 0)),
		nav: () => [...document.querySelectorAll("#nav .ni")].map(b => b.dataset.view),
		where: () => ({ hash: location.hash, c: history.state && history.state.c || null, w: history.state && history.state.w || null }),
	};
})();`;
const hub = fakeHub({
	slowTimers: true,
	headScript: [CLOCK, src("site/demo/fixtures.js"), src("site/demo/demo-api.js"), src("hub/layout-measure-kakao-fixture.js"), CAPTURE].join("\n;\n"),
});
afterAll(() => hub.stop());

type Where = { hash: string; c: string[] | null; w: string[] | null };
type Trace = { requests: string[]; hash: string; historyDelta: number; c: string[] | null; w: string[] | null; nav: string[]; views: string[]; back: Where | null };
type Golden = Record<string, Trace>;
type Surface = { id: string; kind: string; open: string; ready: string };

const SURFACES = (JSON.parse(src("hub/ui-surfaces.json")) as Surface[]).filter(s => s.kind === "screen" || s.kind === "subscreen");
// Screens whose `ready` the demo data cannot satisfy: they wait for the general settle (no request open, two quiet frames) instead.
//   sub-replies  the queue stays empty on the demo data (`.rq-empty`), so `#v-monitoring .rq-r` never appears
const SETTLE_ONLY = new Set<string>(["sub-replies"]);
const BOOT = `typeof S !== "undefined" && S && typeof target === "string" && CV.loaded && NT.loaded`;

const settle = (v: View) => v.evaluate(`__golden.settle()`);
async function trace(width: number, s: Surface): Promise<Trace> {
	// A view of its own (a console handler keeps it out of the pool), so history.length starts from a fresh session every time.
	const v = await hub.view({ width, height: width < 600 ? 844 : 800, console: () => {} }, `/?golden=${s.id}-${width}#home`);
	try {
		await waitFor(v, BOOT);
		await settle(v);
		await ev(v, `__golden.take()`);
		const len0 = await ev<number>(v, `history.length`);
		await v.evaluate(`void (${s.open})`);
		if (!SETTLE_ONLY.has(s.id)) await waitFor(v, s.ready);
		await settle(v);
		const t = await ev<Omit<Trace, "back">>(v, `({ requests: __golden.take(), ...__golden.where(), historyDelta: history.length - ${len0}, nav: __golden.nav(), views: __golden.views() })`);
		let back: Where | null = null;
		// Back is pressed only where the app has an entry below this one: from the bottom entry the browser would leave the page.
		if (t.c && t.c.length > 1) {
			await v.evaluate(`new Promise((res, rej) => { const t = __rt(() => rej(new Error("no popstate")), 8000); addEventListener("popstate", () => { clearTimeout(t); res(0); }, { once: true }); history.back(); })`);
			await settle(v);
			back = await ev<Where>(v, `__golden.where()`);
		}
		return { requests: t.requests, hash: t.hash, historyDelta: t.historyDelta, c: t.c, w: t.w, nav: t.nav, views: t.views, back };
	} finally { v.close(); }
}

// Every field of every screen that differs, named by screen key and field.
function goldenDiff(want: Golden, got: Golden): { screen: string; field: string; want: unknown; got: unknown }[] {
	const out: { screen: string; field: string; want: unknown; got: unknown }[] = [];
	for (const screen of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
		const a = want[screen], b = got[screen];
		if (!a || !b) { out.push({ screen, field: "*", want: a ? "present" : "absent", got: b ? "present" : "absent" }); continue; }
		for (const field of Object.keys({ ...a, ...b }) as (keyof Trace)[]) {
			if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) out.push({ screen, field, want: a[field], got: b[field] });
		}
	}
	return out;
}

// Each trace has a page of its own and mostly waits on page timers, so eight run side by side.
const got: Golden = {};
test(`every screen of hub/ui-surfaces.json traced at ${WIDTHS.join(" and ")} px`, async () => {
	const jobs = WIDTHS.flatMap(width => SURFACES.map(s => ({ width, s })));
	const lane = async () => { for (let j = jobs.shift(); j; j = jobs.shift()) got[`${j.s.id}@${j.width}`] = await trace(j.width, j.s); };
	try { await Promise.all(Array.from({ length: 8 }, lane)); } finally { hub.release(); }
}, 60_000);

test("the trace equals hub/web-golden.json (DOTZ_GOLDEN_WRITE=1 rewrites it)", () => {
	expect(Object.keys(got).length).toBe(SURFACES.length * WIDTHS.length);
	const sorted: Golden = Object.fromEntries(Object.keys(got).sort().map(k => [k, got[k]!]));
	if (WRITE) { writeFileSync(FIXTURE, JSON.stringify(sorted, null, "\t") + "\n"); return; }
	expect(goldenDiff(JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden, sorted)).toEqual([]);
});

test("planted: one changed request path fails the compare, naming its screen", () => {
	const key = Object.keys(got).sort().find(k => got[k]!.requests.length > 0)!;
	const bad: Golden = structuredClone(got);
	bad[key]!.requests[0] = bad[key]!.requests[0]!.replace(/ \//, " /zz-");
	expect(goldenDiff(got, bad).map(d => `${d.screen} ${d.field}`)).toEqual([`${key} requests`]);
});
