import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nPrelude } from "./web-i18n.ts";

// The 계정 card's 물어보기 row (under the small section name 한도에 걸리면) (web/js/25-settings-accounts.js accountSection): one menu with three answers,
// 한 번 묻기 (unset: the alert asks once), 기다리기 and 자동 전환; a pick writes PUT /api/accounts/on-limit (null for 한 번 묻기) and re-renders.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "25-settings-accounts.js"), "utf8");

type Node = { tag: string; attrs: Record<string, any>; kids: any[]; addEventListener: () => void; focus: () => void };
const el = (tag: string, attrs: Record<string, any> | null, ...kids: any[]): Node => ({ tag, attrs: attrs ?? {}, kids: kids.flat().filter(k => k != null), addEventListener: () => {}, focus: () => {} });
const text = (n: any): string => (typeof n === "string" ? n : n == null ? "" : Array.isArray(n) ? n.map(text).join(" ") : [n.attrs?.text ?? "", ...(n.kids ?? []).map(text)].join(" "));
const find = (n: any, f: (x: Node) => boolean, out: Node[] = []): Node[] => {
	if (Array.isArray(n)) for (const k of n) find(k, f, out);
	else if (n && typeof n === "object") {
		if (f(n)) out.push(n);
		for (const k of n.kids ?? []) find(k, f, out);
	}
	return out;
};

const account = (name: string, over: object = {}) => ({ name, alias: null, label: name, current: false, blocked: null, blocked_until: null, blocked_tag: null, five_hour_left: null, seven_day_left: null, ...over });
const body = (on_limit: string | null, over: object = {}) => ({
	mode: "pinned",
	rules: { on_limit },
	accounts: [account("default", { current: true }), account("teammate-shared")],
	chosen: { name: "default", label: "default", source: "manual", blocked: null, text: "" },
	rules_text: [],
	script: { path: null, timeout_ms: 5000, every_minutes: 5, last: null },
	...over,
});

function card(acc: object) {
	const calls: Array<[string, string, unknown]> = [];
	let renders = 0;
	const env: Record<string, unknown> = {
		el,
		liEnd: (...kids: any[]) => el("span", { class: "li-end" }, ...kids),
		icon: () => null,
		api: async (path: string, method: string, b: unknown) => { calls.push([path, method, b]); return acc; },
		busy: async (_b: unknown, fn: () => Promise<void>) => fn(),
		toast: () => {},
		renderSettings: () => { renders++; },
		kstStamp: () => "05:00",
		shortPath: (p: string) => String(p).split("/").pop(),
		clear: () => {},
		dialog: () => ({}),
		current: "settings",
		P: { providers: [] },
		startLogin: () => {},
		loadQuota: () => {},
		provLimits: () => [],
		limitShort: (l: any) => l.label,
		bar: () => null,
		pctText: () => "",
		selectButton: (o: { label: string; items: { value: string; label: string }[]; value: string; onPick: (v: string) => void }) => el("button", { class: "sel", "aria-label": o.label, "data-v": o.value, items: o.items, pick: o.onPick }),
	};
	const mod = new Function(...Object.keys(env), `${i18nPrelude()}${src}\nACC = arguments[arguments.length - 1];\nreturn () => accountSection({ id: "anthropic", name: "Claude 구독" });`);
	const section = mod(...Object.values(env), acc) as () => Node[];
	return { nodes: section(), calls, renders: () => renders };
}

const menu = (nodes: any) => find(nodes, n => n.attrs.class === "sel" && n.attrs["aria-label"] === "물어보기");

test("물어보기: one menu with 한 번 묻기, 기다리기, 자동 전환 shows the saved value; unset is 한 번 묻기", () => {
	for (const [saved, shown] of [["wait", "wait"], ["switch", "switch"], [null, ""]] as const) {
		const m = menu(card(body(saved)).nodes);
		expect(m).toHaveLength(1);
		expect(m[0]!.attrs["data-v"]).toBe(shown);
		expect(m[0]!.attrs.items.map((i: { value: string; label: string }) => [i.value, i.label])).toEqual([["", "한 번 묻기"], ["wait", "기다리기"], ["switch", "자동 전환"]]);
	}
});

test("물어보기: a pick writes PUT /api/accounts/on-limit and re-renders; 한 번 묻기 sends null so the next limit asks again", async () => {
	const c = card(body("wait"));
	await menu(c.nodes)[0]!.attrs.pick("switch");
	expect(c.calls).toEqual([["/api/accounts/on-limit", "PUT", { on_limit: "switch" }]]);
	expect(c.renders()).toBe(1);
	const back = card(body("switch"));
	await menu(back.nodes)[0]!.attrs.pick("");
	expect(back.calls).toEqual([["/api/accounts/on-limit", "PUT", { on_limit: null }]]);
});
