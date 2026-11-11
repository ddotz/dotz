// The gateway pushes its background usage read as a "quota" event (hub/main.ts onQuota); the page hands it to quotaLive
// (web/js/09-needs-you.js), which repaints the top bar and the 사용량 / 홈 view without fetching /api/quota again.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");

// Runs the page scripts in a scope that answers every unknown name with a no-op, as hub/web-hidden-polls.test.ts does.
function page(src: string, known: Record<string, unknown>, tail = "") {
	const any: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : any), apply: () => Promise.resolve(any), set: () => true });
	const scope = new Proxy(known, { has: () => true, get: (t, k) => (typeof k === "string" && k in t ? t[k] : k === Symbol.unscopables ? undefined : any), set: (t, k, v) => ((t[k as string] = v), true) });
	return new Function("scope", `with (scope) { ${src}\n${tail} }`)(scope);
}

test("a pushed quota event reaches quotaLive with its numbers", async () => {
	const streams: { onmessage?: (m: { data: string }) => void }[] = [];
	const got: unknown[] = [];
	page(js("99-boot.js"), {
		document: { hidden: false, visibilityState: "visible", addEventListener() {} },
		addEventListener() {},
		setInterval() {},
		setTimeout: () => 0,
		EventSource: class { readyState = 1; constructor() { streams.push(this); } addEventListener() {} close() {} },
		quotaLive: (q: unknown) => got.push(q),
		Date, Object, JSON, Promise, location: { hash: "" }, pushOpenTs: "", LIVE_TOK: "t",
	});
	await new Promise(r => setImmediate(r));
	const q = { fetched_at: 1, providers: [{ provider: "anthropic", limits: [{ id: "anthropic:5h", remaining: 42 }] }] };
	const es = streams.find(s => s.onmessage);
	es?.onmessage?.({ data: JSON.stringify({ kind: "quota", quota: q }) });
	expect(got).toEqual([q]);
});

test("quotaLive repaints the strip and the open usage view from the pushed read", () => {
	const calls: string[] = [];
	const node: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : node), apply: () => node, set: () => true });
	const scope = { current: "usage", HQ: null as unknown };
	const live = page(js("09-needs-you.js"), Object.assign(scope, {
		$: () => node,
		clear: () => node,
		el: () => node,
		document: node,
		loadQuota: () => calls.push("loadQuota"),
		renderHome: () => calls.push("renderHome"),
		limitFrac: (l: { remaining: number }) => l.remaining / 100,
		Date, Object, JSON, Promise, Math, String, Number,
	}), "return { quotaLive, strip: () => SQ };");
	const q = { providers: [{ provider: "anthropic", limits: [{ id: "anthropic:5h", label: "Claude 5 Hour", remaining: 42 }] }] };
	live.quotaLive(q);
	expect(live.strip()).toBe(q);
	expect(scope.HQ).toBe(q);
	expect(calls).toEqual(["loadQuota"]);
	scope.current = "home";
	live.quotaLive(q);
	expect(calls).toEqual(["loadQuota", "renderHome"]);
});
