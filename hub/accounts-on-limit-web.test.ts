import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The 계정 card's 한도에 걸렸을 때 row (web/js/25-settings-accounts.js accountSection): the stored on_limit is marked, the unset
// state says the alert asks once, and a tap writes PUT /api/accounts/on-limit and re-renders like the other rows.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "25-settings-accounts.js"), "utf8");
// rowToggle, the shared 두 값 설정 pill, comes from 01-core.js.
const core = readFileSync(join(import.meta.dir, "..", "web", "js", "01-core.js"), "utf8");
const rowToggleSrc = /^function rowToggle[\s\S]*?\n}\n/m.exec(core)![0];

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
	accounts: [account("default", { current: true }), account("miseol-shared")],
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
	};
	const mod = new Function(...Object.keys(env), `${rowToggleSrc}\n${src}\nACC = arguments[arguments.length - 1];\nreturn accountSection;`);
	const section = mod(...Object.values(env), acc) as () => Node[];
	return { nodes: section(), calls, renders: () => renders };
}

const pill = (nodes: any) => find(nodes, n => String(n.attrs.class ?? "").includes("tgl"));

test("한도에 걸렸을 때: one pill shows the saved value, and it reads as the second value pressed or not", () => {
	const wait = card(body("wait"));
	expect(text(wait.nodes)).toContain("한도에 걸렸을 때");
	expect(pill(wait.nodes)).toHaveLength(1);
	expect(pill(wait.nodes)[0]!.attrs["data-v"]).toBe("wait");
	expect(pill(wait.nodes)[0]!.attrs["aria-pressed"]).toBe("false");
	const sw = card(body("switch"));
	expect(pill(sw.nodes)[0]!.attrs["data-v"]).toBe("switch");
	expect(pill(sw.nodes)[0]!.attrs["aria-pressed"]).toBe("true");
});

test("한도에 걸렸을 때: unset says it asks once, and the first tap picks 기다리기", async () => {
	const c = card(body(null));
	expect(text(c.nodes)).toContain("아직 안 정했어요 · 한도에 걸리면 한 번 물어봐요");
	expect(pill(c.nodes)[0]!.attrs["data-v"]).toBe("");
	await pill(c.nodes)[0]!.attrs.onclick({ currentTarget: {} });
	expect(c.calls).toEqual([["/api/accounts/on-limit", "PUT", { on_limit: "wait" }]]);
});

test("한도에 걸렸을 때: a tap moves to the other value with PUT /api/accounts/on-limit and re-renders", async () => {
	const c = card(body("wait"));
	await pill(c.nodes)[0]!.attrs.onclick({ currentTarget: {} });
	expect(c.calls).toEqual([["/api/accounts/on-limit", "PUT", { on_limit: "switch" }]]);
	expect(c.renders()).toBe(1);
	const back = card(body("switch"));
	await pill(back.nodes)[0]!.attrs.onclick({ currentTarget: {} });
	expect(back.calls).toEqual([["/api/accounts/on-limit", "PUT", { on_limit: "wait" }]]);
});
