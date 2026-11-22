import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flush } from "./runtime/test-clock.ts";

const read = (name: string) => readFileSync(join(import.meta.dir, "..", "web", "js", name), "utf8");
const src = `${read("09-needs-you.js")}\n${read("30-monitoring.js")}`;

type Screen = { current: string; monCtx: unknown; hidden: boolean };
const settled = () => flush(2);

function boot() {
	const fetched = { monitors: 0 };
	const intervals: { fn: () => void; ms: number }[] = [];
	const page: Screen = { current: "home", monCtx: null, hidden: false };
	const document = { get hidden() { return page.hidden; }, visibilityState: "visible", addEventListener() {} };
	const stub: object = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : typeof k === "symbol" || k === "then" ? undefined : stub), apply: () => stub, construct: () => stub, set: () => true });
	const known: Record<string, unknown> = {
		document,
		get current() { return page.current; },
		get monCtx() { return page.monCtx; },
		setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
		setTimeout: () => 0,
		api: async (path: string) => (path === "/api/monitors" && fetched.monitors++, { items: [] }),
		Date, Object, JSON, Promise, Math, Number, String, Array, Set, Map,
	};
	const scope = new Proxy(known, { has: () => true, get: (t, k) => (typeof k === "string" && k in t ? t[k] : k === Symbol.unscopables ? undefined : stub), set: (t, k, v) => ((t[k as string] = v), true) });
	new Function("scope", `with (scope) { ${src} }`)(scope);
	const minute = intervals.filter(i => i.ms === 60_000);
	const reads = async (timer: { fn: () => void }, state: Partial<Screen>): Promise<boolean> => {
		await settled();
		Object.assign(page, { current: "home", monCtx: null, hidden: false }, state);
		const before = fetched.monitors;
		timer.fn();
		await settled();
		return fetched.monitors > before;
	};
	return { minute, reads };
}

const SCREENS: Partial<Screen>[] = [{ current: "monitoring" }, { current: "files" }, { current: "chat" }, { current: "settings", monCtx: { app: "x" } }, { current: "home", monCtx: { app: "x" } }];

async function readersOn(p: ReturnType<typeof boot>, state: Partial<Screen>) {
	const out: number[] = [];
	for (const [i, timer] of p.minute.entries()) if (await p.reads(timer, state)) out.push(i);
	return out;
}

test("one 60-second timer re-reads the monitor list, on every screen but 홈", async () => {
	const p = boot();
	const everReading = new Set<number>();
	for (const state of SCREENS) {
		const readers = await readersOn(p, state);
		expect(readers).toHaveLength(1);
		for (const i of readers) everReading.add(i);
	}
	expect(everReading.size).toBe(1);
	expect(await readersOn(p, { current: "home" })).toEqual([]);
});

test("a hidden page does not re-read the monitor list", async () => {
	const p = boot();
	for (const state of SCREENS) expect(await readersOn(p, { ...state, hidden: true })).toEqual([]);
});
