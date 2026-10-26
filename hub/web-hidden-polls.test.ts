// A hidden page skips the state (15 s) and model (1 min) polls of web/js/99-boot.js and catches up when it is shown again: a forgotten
// background tab made the gateway start a model-list process every minute (/api/models, hub/providers.ts availableModels).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "web", "js", "99-boot.js"), "utf8");

function boot() {
	const calls = { refreshState: 0, loadModels: 0 };
	const intervals: { fn: () => void; ms: number }[] = [];
	const listeners = new Map<string, (() => void)[]>();
	const on = (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
	const document = { hidden: false, visibilityState: "visible", addEventListener: on };
	const any: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : any), apply: () => Promise.resolve(any), set: () => true });
	const known: Record<string, unknown> = {
		document,
		addEventListener: on,
		setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
		setTimeout: () => 0,
		refreshState: () => (calls.refreshState++, Promise.resolve()),
		loadModels: () => (calls.loadModels++, Promise.resolve()),
		EventSource: class { readyState = 1; addEventListener() {} close() {} },
		Date, Object, JSON, Promise, location: { hash: "" }, pushOpenTs: "",
	};
	const scope = new Proxy(known, { has: () => true, get: (t, k) => (typeof k === "string" && k in t ? t[k] : k === Symbol.unscopables ? undefined : any), set: (t, k, v) => ((t[k as string] = v), true) });
	new Function("scope", `with (scope) { ${src} }`)(scope);
	const tick = (ms: number) => intervals.filter(i => i.ms === ms).forEach(i => i.fn());
	const fire = (type: string) => (listeners.get(type) ?? []).forEach(fn => fn());
	return { calls, document, tick, fire };
}

test("a hidden page does not poll the state or the models, and one return catches up once", async () => {
	const p = boot();
	await new Promise(r => setImmediate(r));
	p.calls.refreshState = p.calls.loadModels = 0;
	p.document.hidden = true;
	p.fire("visibilitychange");
	for (let i = 0; i < 8; i++) p.tick(15000);
	p.tick(60000);
	p.tick(60000);
	expect(p.calls).toEqual({ refreshState: 0, loadModels: 0 });
	p.document.hidden = false;
	p.fire("visibilitychange");
	expect(p.calls).toEqual({ refreshState: 1, loadModels: 1 });
	p.tick(15000);
	p.tick(60000);
	expect(p.calls).toEqual({ refreshState: 2, loadModels: 2 });
});
