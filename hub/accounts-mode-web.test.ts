import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The 계정 card (web/js/25-settings-accounts.js accountSection), run on the real source text with a small element stub:
// the 자동 전환 switch row leads (off = 고정, the account is fixed by tapping its row), the 전환 규칙 rows show only in 자동 전환, the switch writes
// PUT /api/accounts/mode and the move buttons write PUT /api/accounts/order.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "25-settings-accounts.js"), "utf8");
const rowToggleSrc = /^function rowToggle[\s\S]*?\n}\n/m.exec(readFileSync(join(import.meta.dir, "..", "web", "js", "01-core.js"), "utf8"))![0];

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
	accounts: [account("default", { current: true }), account("teammate-shared")],
	chosen: { name: "default", label: "default", source: mode === "pinned" ? "manual" : "auto", blocked: null, text: "" },
	rules_text: [{ index: 0, text: "평일 09:00-18:00 · 회사 계정" }],
	script: { path: "/tmp/pick.sh", timeout_ms: 5000, every_minutes: 5, last: { account: "default", at: "2026-10-23T05:00:00Z" } },
	...over,
});

function card(acc: object, providers: object[] = []) {
	const calls: Array<[string, string, unknown]> = [];
	const dialogs: string[] = [];
	const logins: unknown[] = [];
	const acts: string[][] = [];
	const outs: string[] = [];
	const env: Record<string, unknown> = {
		el,
		liEnd: (...kids: any[]) => el("span", { class: "li-end" }, ...kids),
		icon: () => null,
		api: async (path: string, method: string, b: unknown) => { calls.push([path, method, b]); return acc; },
		busy: async (_b: unknown, fn: () => Promise<void>) => fn(),
		usErr: () => el("p", {}),
		usRun: async (_b: unknown, _e: unknown, fn: () => Promise<void>) => fn(),
		usDirty: () => {},
		toast: () => {},
		renderSettings: () => {},
		kstStamp: () => "05:00",
		shortPath: (p: string) => String(p).split("/").pop(),
		clear: () => {},
		dialog: (o: { title: string; actions: { label: string; onclick: (close: () => void) => void }[] }) => { dialogs.push(o.title); acts.push(o.actions.map(a => a.label)); for (const a of o.actions) if (a.label === "로그아웃") a.onclick(() => {}); return {}; },
		logoutProvider: (p: { id: string }) => { outs.push(p.id); },
		current: "settings",
		P: { providers },
		startLogin: (p: unknown) => { logins.push(p); },
		loadQuota: () => {},
		provLimits: () => [],
		limitShort: (l: any) => l.label,
		bar: () => null,
		pctText: () => "",
	};
	const mod = new Function(...Object.keys(env), `${rowToggleSrc}\n${src}\nACC = arguments[arguments.length - 1];\nreturn () => accountSection({ id: "anthropic", name: "Claude 구독" });`);
	const section = mod(...Object.values(env), acc) as () => Node[];
	return { nodes: section(), calls, dialogs, logins, acts, outs };
}

const switchOf = (nodes: any) => find(nodes, n => n.attrs.role === "switch")[0]!;
const mainOf = (row: any) => find(row, n => n.attrs.class === "acc-main")[0]!;
const gripOf = (row: any) => find(row, n => n.attrs.class === "acc-grip")[0]!;
const rowsOf = (nodes: any) => find(nodes, n => String(n.attrs.class ?? "").split(" ").includes("acc"));
const supOf = (row: any) => find(row, n => n.attrs.class === "sup");

test("자동 전환: the card is the accounts, then the 한도에 걸리면 section (switch, ask, rules, script, one note line); the switch row has no help text", () => {
	const { nodes } = card(body("auto"));
	const all = text(nodes);
	const cells = nodes[1]!.kids as Node[];
	const labels = cells.map((k, i) => (k.attrs.class === "li acc-lbl" ? i : -1)).filter(i => i >= 0);
	expect(labels).toHaveLength(2);
	expect(labels[0]).toBe(0);
	expect(cells.slice(1, labels[1]).every(k => String(k.attrs.class).split(" ").includes("acc"))).toBe(true);
	const lead = cells[labels[1]! + 1]!;
	expect(supOf(lead)).toHaveLength(0);
	expect(pillOf(cells[labels[1]! + 2])).toHaveLength(1);
	expect(text(cells[labels[1]! + 3]).replace(/\s+/g, " ")).toContain("평일 09:00-18:00");
	expect(find(cells[cells.length - 1], n => n.attrs.class === "sup")).toHaveLength(1);
	expect(find(nodes, n => String(n.attrs.class ?? "").includes("prow-lim"))).toHaveLength(0);
	const sw = switchOf(lead);
	expect(sw.attrs.class).toBe("hs-sw");
	expect(sw.attrs["aria-checked"]).toBe("true");
	expect(find(nodes, n => n.attrs.role === "radiogroup")).toHaveLength(0);
	expect(find(nodes, n => n.tag === "select")).toHaveLength(0);
	expect(all).toContain("전환 규칙");
	expect(all).toContain("평일 09:00-18:00");
	expect(all).toContain("스크립트");
	// the script's path is short on screen (shortPath) and the row keeps the full path in its title
	const scriptRow = find(nodes, n => String(n.attrs.class ?? "") === "li tap")[0]!;
	expect(text(scriptRow)).toContain("pick.sh");
	expect(text(scriptRow)).not.toContain("/tmp/");
	expect(scriptRow.attrs.title).toBe("/tmp/pick.sh");
	expect(all).not.toContain("고정 풀기");
	expect(all).not.toContain("고른 계정");
	expect(all).not.toContain("고정");
});

test("고정: the switch is off, the help becomes the 고정 text, no 전환 규칙 row, the chosen account row has the 사용 중 · 고정 badge, no select", () => {
	const { nodes } = card(body("pinned"));
	const all = text(nodes);
	expect(switchOf(nodes).attrs["aria-checked"]).toBe("false");
	expect(supOf(find(nodes, n => n.attrs.class === "li" && find(n, m => m.attrs.role === "switch").length > 0)[0])).toHaveLength(1);
	expect(all).not.toContain("default");
	expect(all).not.toContain("전환 규칙");
	expect(all).not.toContain("스크립트");
	expect(find(nodes, n => n.tag === "select")).toHaveLength(0);
	const [first, second] = rowsOf(nodes);
	expect(text(first)).toContain("사용 중 · 고정");
	expect(first!.attrs.class).toContain(" on");
	expect(text(second)).not.toContain("고정");
	expect(find(second, n => String(n.attrs.class ?? "").startsWith("tag"))).toHaveLength(0);
});

test("고정: a blocked fixed account says it waits and keeps its badge and limit tag", () => {
	const blocked = body("pinned", { accounts: [account("default", { current: true, blocked: "rate_limit", blocked_tag: "한도 걸림 · 01:00까지" }), account("teammate-shared")], chosen: { name: "default", label: "default", source: "manual", blocked: "rate_limit", text: "한도에 걸려서 01:00까지 멈춰 있어요. 고정했으니 다른 계정으로 넘어가지 않아요" } });
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
	const [fixed, other] = rowsOf(pinned.nodes).map(mainOf);
	fixed.attrs.onclick({ currentTarget: {} });
	expect(pinned.calls).toEqual([]);
	other.attrs.onclick({ currentTarget: {} });
	expect(pinned.calls).toEqual([["/api/accounts/mode", "PUT", { mode: "pinned", account: "teammate-shared" }]]);

	const auto = card(body("auto"));
	mainOf(rowsOf(auto.nodes)[1]!).attrs.onclick({ currentTarget: {} });
	expect(auto.calls).toEqual([]);
	expect(auto.dialogs).toEqual(["teammate-shared"]);
});

test("every account row has its number and a grip; no arrow buttons; ArrowUp/ArrowDown on a grip write PUT /api/accounts/order, the ends do nothing", () => {
	const three = [account("default", { order: 1, current: true }), account("teammate-shared", { order: 2 }), account("third", { order: 3 })];
	for (const mode of ["auto", "pinned"] as const) {
		const c = card(body(mode, { accounts: three }));
		const rows = rowsOf(c.nodes);
		expect(rows.map(r => text(find(r, n => String(n.attrs.class).includes("acc-no"))).trim())).toEqual(["1", "2", "3"]);
		expect(rows.map(r => gripOf(r).attrs["data-acc"])).toEqual(["default", "teammate-shared", "third"]);
		expect(find(c.nodes, n => String(n.attrs.class).includes("acc-mvs"))).toHaveLength(0);
		expect(text(c.nodes)).not.toMatch(/[↑↓]/);
	}
	const auto = card(body("auto", { accounts: three }));
	const keys = (i: number, key: string) => gripOf(rowsOf(auto.nodes)[i]!).attrs.onkeydown({ key, currentTarget: {}, preventDefault() {} });
	keys(0, "ArrowUp");
	keys(2, "ArrowDown");
	keys(1, "Enter");
	expect(auto.calls).toEqual([]);
	keys(1, "ArrowUp");
	expect(auto.calls).toEqual([["/api/accounts/order", "PUT", { order: ["teammate-shared", "default", "third"] }]]);
	keys(1, "ArrowDown");
	expect(auto.calls.at(-1)).toEqual(["/api/accounts/order", "PUT", { order: ["default", "third", "teammate-shared"] }]);
});

const pillOf = (row: any) => find(row, n => String(n.attrs.class ?? "").includes("tgl"));
test("only an account whose login ran out gets 다시 로그인, on its own row beside the tap area; the other rows and the card have none", () => {
	const lost = body("auto", { accounts: [account("default", { current: true }), account("teammate-shared", { blocked: "auth_error", blocked_tag: "로그인 풀림" })] });
	const c = card(lost);
	const [ok, out] = rowsOf(c.nodes);
	expect(find(ok, n => n.attrs["data-acc-relogin"] != null)).toHaveLength(0);
	const btn = find(out, n => n.attrs["data-acc-relogin"] != null);
	expect(btn).toHaveLength(1);
	expect(find(mainOf(out), n => n.attrs["data-acc-relogin"] != null)).toHaveLength(0);
	expect(find(out, n => String(n.attrs.class ?? "").startsWith("tag warn"))).toHaveLength(0);
	btn[0]!.attrs.onclick({});
	expect(c.logins).toEqual([{ id: "anthropic", name: "Claude 구독" }]);
	expect(find(c.nodes, n => n.attrs["data-acc-relogin"] != null)).toHaveLength(1);
});

test("a limit that only time fixes keeps its warn tag and gets no 다시 로그인; no card row has a trash can or a 쓸 수 있음 tag", () => {
	const c = card(body("auto", { accounts: [account("default", { current: true, blocked: "rate_limit", blocked_tag: "한도 걸림 · 01:00까지" }), account("teammate-shared")] }));
	expect(find(rowsOf(c.nodes)[0], n => String(n.attrs.class ?? "").startsWith("tag warn"))).toHaveLength(1);
	expect(find(c.nodes, n => n.attrs["data-acc-relogin"] != null)).toHaveLength(0);
	expect(find(c.nodes, n => n.attrs.class === "ib")).toHaveLength(0);
	expect(find(c.nodes, n => String(n.attrs.class ?? "").startsWith("tag ok"))).toHaveLength(0);
});

test("the stored name default reads as 기본 on the rows and in the 계정 window title, and the stored name is still what the writes use", () => {
	const c = card(body("auto"));
	expect(text(c.nodes)).not.toContain("default");
	mainOf(rowsOf(c.nodes)[0]!).attrs.onclick({ currentTarget: {} });
	expect(c.dialogs).toEqual(["기본"]);
	expect(rowsOf(c.nodes).map(r => gripOf(r).attrs["data-acc"])).toEqual(["default", "teammate-shared"]);
});

test("the only account leaves through 로그아웃 in its window (the card has no trash can); with two accounts the window deletes one instead", () => {
	const anthropic = { id: "anthropic", name: "Claude 구독", auth: "oauth", can_logout: true };
	const one = card(body("auto", { accounts: [account("default", { current: true })] }), [anthropic]);
	mainOf(rowsOf(one.nodes)[0]!).attrs.onclick({ currentTarget: {} });
	expect(one.acts[0]).toContain("로그아웃");
	expect(one.acts[0]).not.toContain("계정 삭제");
	expect(one.outs).toEqual(["anthropic"]);
	const two = card(body("auto"), [anthropic]);
	mainOf(rowsOf(two.nodes)[0]!).attrs.onclick({ currentTarget: {} });
	expect(two.acts[0]).toContain("계정 삭제");
	expect(two.acts[0]).not.toContain("로그아웃");
	expect(two.outs).toEqual([]);
});
