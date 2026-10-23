import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The 계정 card (web/js/25-settings-accounts.js accountSection), run on the real source text with a small element stub:
// the 자동 전환 switch row leads (off = 고정, the account is fixed by tapping its row), the 전환 규칙 rows show only in 자동 전환, the switch writes
// PUT /api/accounts/mode and the move buttons write PUT /api/accounts/order.
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
	const dialogs: string[] = [];
	const env: Record<string, unknown> = {
		el,
		icon: () => null,
		api: async (path: string, method: string, b: unknown) => { calls.push([path, method, b]); return acc; },
		busy: async (_b: unknown, fn: () => Promise<void>) => fn(),
		toast: () => {},
		renderSettings: () => {},
		kstStamp: () => "05:00",
		clear: () => {},
		dialog: (o: { title: string }) => { dialogs.push(o.title); return {}; },
		current: "settings",
		loadQuota: () => {},
	};
	const mod = new Function(...Object.keys(env), `${src}\nACC = arguments[arguments.length - 1];\nreturn accountSection;`);
	const section = mod(...Object.values(env), acc) as () => Node[];
	return { nodes: section(), calls, dialogs };
}

const switchOf = (nodes: any) => find(nodes, n => n.attrs.role === "switch")[0]!;
const rowsOf = (nodes: any) => find(nodes, n => String(n.attrs.class ?? "").startsWith("li acc"));
const AUTO_HELP = "규칙과 한도에 따라 계정을 골라요. 쓰던 계정이 막히면 다른 계정으로 넘어가요.";

test("자동 전환: one settings row leads with the title, its help and an on switch; the rules and script rows show, no select or segmented control", () => {
	const { nodes } = card(body("auto"));
	const all = text(nodes);
	const lead = nodes[1]!.kids[0];
	expect(text(lead).replace(/\s+/g, " ").trim()).toBe(`자동 전환 ${AUTO_HELP}`);
	const sw = switchOf(lead);
	expect(sw.attrs.class).toBe("hs-sw");
	expect(sw.attrs["aria-checked"]).toBe("true");
	expect(find(nodes, n => n.attrs.role === "radiogroup")).toHaveLength(0);
	expect(find(nodes, n => n.tag === "select")).toHaveLength(0);
	expect(all).toContain("전환 규칙");
	expect(all).toContain("평일 09:00-18:00");
	expect(all).toContain("스크립트");
	expect(all).not.toContain("고정 풀기");
	expect(all).not.toContain("고른 계정");
	expect(all).not.toContain("고정");
});

test("고정: the switch is off, the help becomes the 고정 text, no 전환 규칙 row, the chosen account row has the 사용 중 · 고정 badge, no select", () => {
	const { nodes } = card(body("pinned"));
	const all = text(nodes);
	expect(switchOf(nodes).attrs["aria-checked"]).toBe("false");
	expect(all).toContain("default만 써요. 한도에 걸리면 풀릴 때까지 멈추고, 다른 계정으로 넘어가지 않아요.");
	expect(all).not.toContain(AUTO_HELP);
	expect(all).not.toContain("전환 규칙");
	expect(all).not.toContain("스크립트");
	expect(find(nodes, n => n.tag === "select")).toHaveLength(0);
	const [first, second] = rowsOf(nodes);
	expect(text(first)).toContain("사용 중 · 고정");
	expect(first!.attrs.class).toContain(" on");
	expect(text(second)).not.toContain("고정");
	expect(text(second)).toContain("쓸 수 있음");
});

test("고정: a blocked fixed account says it waits and keeps its badge and limit tag", () => {
	const blocked = body("pinned", { accounts: [account("default", { current: true, blocked: "rate_limit", blocked_tag: "한도 걸림 · 01:00까지" }), account("miseol-shared")], chosen: { name: "default", label: "default", source: "manual", blocked: "rate_limit", text: "한도에 걸려서 01:00까지 멈춰 있어요. 고정했으니 다른 계정으로 넘어가지 않아요" } });
	const { nodes } = card(blocked);
	const all = text(nodes);
	expect(all).toContain("멈춰 있어요");
	expect(text(rowsOf(nodes)[0])).toContain("사용 중 · 고정");
	expect(all).toContain("한도 걸림 · 01:00까지");
});

test("the switch writes PUT /api/accounts/mode: on -> 고정, off -> 자동 전환", () => {
	const auto = card(body("auto"));
	switchOf(auto.nodes).attrs.onclick({ currentTarget: {} });
	expect(auto.calls).toEqual([["/api/accounts/mode", "PUT", { mode: "pinned" }]]);

	const pinned = card(body("pinned"));
	switchOf(pinned.nodes).attrs.onclick({ currentTarget: {} });
	expect(pinned.calls).toEqual([["/api/accounts/mode", "PUT", { mode: "auto" }]]);
});

test("고정: tapping another account row fixes it, tapping the fixed one does nothing; 자동 전환 rows open the details instead", () => {
	const pinned = card(body("pinned"));
	const [fixed, other] = rowsOf(pinned.nodes).map(r => r.kids[0]);
	fixed.attrs.onclick({ currentTarget: {} });
	expect(pinned.calls).toEqual([]);
	other.attrs.onclick({ currentTarget: {} });
	expect(pinned.calls).toEqual([["/api/accounts/mode", "PUT", { mode: "pinned", account: "miseol-shared" }]]);

	const auto = card(body("auto"));
	rowsOf(auto.nodes)[1]!.kids[0].attrs.onclick({ currentTarget: {} });
	expect(auto.calls).toEqual([]);
	expect(auto.dialogs).toEqual(["miseol-shared"]);
});

test("자동 전환: every account row has its number and up/down buttons; the end ones are disabled and a move writes PUT /api/accounts/order", () => {
	const auto = card(body("auto", { accounts: [account("default", { order: 1, current: true }), account("miseol-shared", { order: 2 }), account("third", { order: 3 })] }));
	const rows = rowsOf(auto.nodes);
	expect(rows.map(r => text(find(r, n => String(n.attrs.class).includes("acc-no"))).trim())).toEqual(["1", "2", "3"]);
	const mv = rows.map(r => find(r, n => n.attrs.class === "acc-mv"));
	expect(mv.map(b => b.map(x => !!x.attrs.disabled))).toEqual([[true, false], [false, false], [false, true]]);
	mv[1]![0]!.attrs.onclick({ currentTarget: {} });
	expect(auto.calls).toEqual([["/api/accounts/order", "PUT", { order: ["miseol-shared", "default", "third"] }]]);
	mv[1]![1]!.attrs.onclick({ currentTarget: {} });
	expect(auto.calls.at(-1)).toEqual(["/api/accounts/order", "PUT", { order: ["default", "third", "miseol-shared"] }]);
	expect(find(card(body("pinned")).nodes, n => String(n.attrs.class) === "acc-mvs")).toHaveLength(0);
});
