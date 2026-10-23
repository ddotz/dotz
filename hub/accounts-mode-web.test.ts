import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The 계정 card (web/js/25-settings-accounts.js accountSection), run on the real source text with a small element stub:
// the mode control (자동 전환 / 고정) leads, the 전환 규칙 rows show only in 자동 전환, and a mode button writes PUT /api/accounts/mode.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "25-settings-accounts.js"), "utf8");

type Node = { tag: string; attrs: Record<string, any>; kids: any[]; addEventListener: () => void };
const el = (tag: string, attrs: Record<string, any> | null, ...kids: any[]): Node => ({ tag, attrs: attrs ?? {}, kids: kids.flat().filter(k => k != null), addEventListener: () => {} });
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
const body = (mode: "auto" | "pinned", over: object = {}) => ({
	mode,
	accounts: [account("default", { current: true }), account("miseol-shared")],
	chosen: { name: "default", label: "default", source: mode === "pinned" ? "manual" : "auto", blocked: null, text: "" },
	rules_text: [{ index: 0, text: "평일 09:00-18:00 · 회사 계정" }],
	script: { path: "/tmp/pick.sh", timeout_ms: 5000, every_minutes: 5, last: { account: "default", at: "2026-10-23T05:00:00Z" } },
	...over,
});

function card(acc: object) {
	const calls: Array<[string, string, unknown]> = [];
	const env: Record<string, unknown> = {
		el,
		icon: () => null,
		api: async (path: string, method: string, b: unknown) => { calls.push([path, method, b]); return acc; },
		busy: async (_b: unknown, fn: () => Promise<void>) => fn(),
		toast: () => {},
		renderSettings: () => {},
		kstStamp: () => "05:00",
		clear: () => {},
		dialog: () => ({}),
		current: "settings",
		loadQuota: () => {},
	};
	const mod = new Function(...Object.keys(env), `${src}\nACC = arguments[arguments.length - 1];\nreturn accountSection;`);
	const section = mod(...Object.values(env), acc) as () => Node[];
	return { nodes: section(), calls };
}

test("자동 전환: the mode control leads, 전환 규칙 and the script rows show, and no 고정 풀기 or 고른 계정 row remains", () => {
	const { nodes } = card(body("auto"));
	const all = text(nodes);
	const seg = find(nodes, n => n.attrs.role === "radiogroup")[0]!;
	expect(seg.kids.map(text).map(s => s.trim())).toEqual(["자동 전환", "고정"]);
	expect(seg.kids.map(k => k.attrs["aria-checked"])).toEqual(["true", "false"]);
	expect(all).toContain("전환 규칙");
	expect(all).toContain("평일 09:00-18:00");
	expect(all).toContain("스크립트");
	expect(all).not.toContain("고정 풀기");
	expect(all).not.toContain("고른 계정");
	expect(find(nodes, n => n.tag === "select")).toHaveLength(0);
});

test("고정: no 전환 규칙 row, the pinned account is chosen in a select, a blocked pin says it waits", () => {
	const blocked = body("pinned", { accounts: [account("default", { current: true, blocked: "rate_limit", blocked_tag: "한도 걸림 · 01:00까지" }), account("miseol-shared")], chosen: { name: "default", label: "default", source: "manual", blocked: "rate_limit", text: "한도에 걸려서 01:00까지 멈춰 있어요. 고정했으니 다른 계정으로 넘어가지 않아요" } });
	const { nodes } = card(blocked);
	const all = text(nodes);
	const seg = find(nodes, n => n.attrs.role === "radiogroup")[0]!;
	expect(seg.kids.map(k => k.attrs["aria-checked"])).toEqual(["false", "true"]);
	expect(all).not.toContain("전환 규칙");
	expect(all).not.toContain("평일 09:00");
	expect(all).not.toContain("스크립트");
	expect(all).not.toContain("고정 풀기");
	expect(all).toContain("멈춰 있어요");
	expect(all).toContain("사용 중");
	expect(all).toContain("한도 걸림 · 01:00까지");
	expect(all).toContain("쓸 수 있음");
	const select = find(nodes, n => n.tag === "select")[0]!;
	expect(select.kids.map(k => k.attrs.value)).toEqual(["default", "miseol-shared"]);
	expect(select.kids.find(k => k.attrs.selected)?.attrs.value).toBe("default");
});

test("the mode buttons write PUT /api/accounts/mode; the active one does nothing", async () => {
	const auto = card(body("auto"));
	const [autoBtn, pinBtn] = find(auto.nodes, n => n.attrs.role === "radio");
	autoBtn!.attrs.onclick({ currentTarget: {} });
	expect(auto.calls).toEqual([]);
	pinBtn!.attrs.onclick({ currentTarget: {} });
	expect(auto.calls).toEqual([["/api/accounts/mode", "PUT", { mode: "pinned" }]]);

	const pinned = card(body("pinned"));
	find(pinned.nodes, n => n.attrs.role === "radio")[0]!.attrs.onclick({ currentTarget: {} });
	expect(pinned.calls).toEqual([["/api/accounts/mode", "PUT", { mode: "auto" }]]);
});
