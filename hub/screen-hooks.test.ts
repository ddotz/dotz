import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nPrelude } from "./web-i18n.ts";

// The screen hooks of web/js/03-screens.js and the 모니터링 back hook of web/js/30-monitoring-route.js, evaluated from their source with
// stub closers: 뒤로 on 모니터링 asks the closers in a fixed order and stops at the first that closed something.
const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const ORDER = ["asBack", "rqBack", "kkBack", "cmBack", "mxsBack"];

function load(open: Set<string>) {
	const asked: string[] = [];
	const stubs = ORDER.map(n => `const ${n} = () => (asked.push("${n}"), open.has("${n}"));`).join("\n");
	const src = `${i18nPrelude()}${web("03-screens.js")}\n${stubs}\n${web("30-monitoring-route.js")}\nreturn { SCREEN_HOOKS, screenHooks };`;
	const env = new Function("asked", "open", src)(asked, open) as { SCREEN_HOOKS: Record<string, { back?: () => boolean }>; screenHooks: (id: string, h: object) => void };
	return { ...env, asked };
}

test("모니터링's back hook asks the closers in order and stops at the first one that closed something", () => {
	for (let i = 0; i < ORDER.length; i++) {
		const m = load(new Set(ORDER.slice(i)));
		expect(m.SCREEN_HOOKS.monitoring!.back!()).toBe(true);
		expect(m.asked).toEqual(ORDER.slice(0, i + 1));
	}
	const none = load(new Set());
	expect(none.SCREEN_HOOKS.monitoring!.back!()).toBe(false);
	expect(none.asked).toEqual(ORDER);
});

test("screenHooks refuses an unknown screen and a second hook of the same kind", () => {
	const { screenHooks, SCREEN_HOOKS } = load(new Set());
	expect(() => screenHooks("nowhere", { back: () => false })).toThrow("unknown screen nowhere");
	expect(() => screenHooks("monitoring", { back: () => false })).toThrow("monitoring.back is registered twice");
	screenHooks("home", { back: () => false });
	expect(Object.keys(SCREEN_HOOKS).sort()).toEqual(["home", "monitoring"]);
});
