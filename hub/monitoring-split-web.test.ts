import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 모니터링 (web/js/30-monitoring.js) run as shipped over a fixed store: which notices it lists, and what a watch row opens.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "30-monitoring.js"), "utf8");
const between = (from: string, to: string) => {
	const a = src.indexOf(from), b = src.indexOf(to, a);
	if (a < 0 || b < 0) throw new Error(`markers not found: ${from} .. ${to}`);
	return src.slice(a, b);
};

type Node = { tag: string; cls: string; text: string; kids: unknown[]; dataset: Record<string, string>; append: (...k: unknown[]) => void; querySelector: (s: string) => Node | null };
const isNode = (x: unknown): x is Node => !!x && typeof x === "object" && "kids" in x;
function el(tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): Node {
	const n: Node = {
		tag, cls: String(attrs.class ?? ""), text: String(attrs.text ?? ""), kids: kids.flat().filter(k => k != null && k !== ""), dataset: {},
		append: (...k) => { n.kids.push(...k.filter(x => x != null)); },
		querySelector: s => find(n, s.slice(1)),
	};
	Object.defineProperty(n, "textContent", { set: (v: string) => { n.text = v; n.kids = []; } });
	return n;
}
function find(n: Node, cls: string): Node | null {
	for (const k of n.kids) if (isNode(k)) { if (k.cls.split(" ").includes(cls)) return k; const f = find(k, cls); if (f) return f; }
	return null;
}
const words = (n: unknown): string => isNode(n) ? [n.text, ...n.kids.map(words)].join("") : String(n);

type N = Record<string, unknown>;
function load(notices: N[], integrations: N[], monitors: N[]) {
	const drawn: N[] = [], went: string[][] = [];
	const env: Record<string, unknown> = {
		// No other computers here (web/js/34-peer-monitoring.js): the local list as is.
		pqMerge: (items: N[]) => items, pqTimeline: () => null, pqLabel: () => null, pqSig: () => 0, pqOpen: () => {},
		intgWatch: () => {}, INTG: { items: integrations }, NT: { items: notices, loaded: true }, CONV: new Map(), MAILS: new Map(),
		ntById: (id: string) => notices.find(n => n.id === id), ntAt: (n: N) => Date.parse(String(n.updated || n.ts)), ntPlain: (s: unknown) => String(s ?? ""),
		KST: {}, kstDay: (t: string) => String(t).slice(0, 10), kstHM: (t: string) => String(t).slice(11, 16), dayLabel: () => "어제", ntTime: (t: string) => String(t).slice(11, 16),
		convPreview: (s: string) => String(s ?? "").split("\n")[0], el, icon: (k: string) => el("i", { class: `ic ${k}` }),
		resultCard: (o: N) => { drawn.push({ text: o.title ?? o.text }); return el("div", { class: "bm alert rc" }, el("span", { class: "rc-src", text: String(o.src) })); },
		cardNode: () => { throw new Error("a fact card is not a conversation message"); },
		ts: () => ({ unread: 0 }), narrowChat: () => false, go: (...a: string[]) => went.push(a), current: "monitoring", enc: encodeURIComponent,
		api: async () => ({}), homeSoon: () => {}, titles: { monitoring: "모니터링" }, ntIsDec: (n: N) => n.kind === "decision" && !!n.decision, ntNeeds: () => false,
		noticeOpen: () => {}, asPinnedRow: () => null, isSettingsT: () => false, settingsApp: () => "", isProjT: (t: string) => /^ch:\d+$/.test(t), S: null, projTargets: () => [], toast: () => {}, openTarget: () => {},
	};
	const body = `${between("const NM =", "async function loadMonitors")}\n${between("// Failed ones first", "// The owner is looking at an open item")}
NM.items = MONS; NM.loaded = true;
return { MON, monRoute, monItems, monSel, monRows, monTimeline, monHead, monKeyOf };`;
	const api = new Function(...Object.keys(env), "MONS", body)(...Object.values(env), monitors);
	return { ...api, drawn, went } as {
		MON: { sel: string; list: boolean }; monRoute: (t?: string) => void; monItems: () => (N & { key: string; notices: N[]; name: string; hint: string })[];
		monSel: (items: unknown[]) => (N & { key: string; notices: N[] }) | null; monRows: (items: unknown[], sel: unknown) => (N & { open?: () => void })[];
		monTimeline: (it: unknown) => Node[]; monHead: (it: unknown) => Node[]; monKeyOf: (n: N) => string; drawn: N[]; went: string[][];
	};
}

const T = "2026-10-22T13:";
// One store holding both sides: the 알림 channel's post, a decision asked there and that conversation's latest-message item (chat), a session
// result (chat), a watch report, a schedule report, a mail and an alert-channel post that only mentions 카톡 (text-matched by the integration).
const store = (): N[] => [
	{ id: "alert", kind: "alert", tone: "", title: "알림", text: "서버가 느려요", open: "alert", src: "alert", ts: `${T}01:00Z`, read: false },
	{ id: "dec", kind: "decision", tone: "ask", title: "보낼까요?", text: "보낼까요?", open: "alert", src: "alert", ts: `${T}02:00Z`, read: false, decision: { options: [], to: "alert", group: 1, state: "open" } },
	{ id: "msg", kind: "message", tone: "", title: "알림", text: "새 글", open: "alert", src: "alert", key: "msg:alert", ts: `${T}03:00Z`, read: false },
	{ id: "res", kind: "result", tone: "done", title: "세션", text: "끝났어요", open: "lane:a", src: "lane:a", ts: `${T}04:00Z`, read: false },
	{ id: "watch", kind: "watch", tone: "", title: "node security updates", text: "node security updates: 결과가 바뀌었어요\n보안 업데이트 3개", open: "alert", ts: `${T}05:00Z`, read: false },
	{ id: "gw", kind: "watch", tone: "fail", title: "node-security-updates", text: "실패했어요", open: "ch:9", ts: `${T}05:30Z`, read: true },
	{ id: "sched", kind: "watch", tone: "", title: "예약", text: "주간 보고 정리", open: "main", ts: `${T}06:00Z`, read: false },
	{ id: "mail", kind: "message", tone: "", title: "메일", text: "새 메일: 김팀장", open: "mail:1", src: "mail:1", ts: `${T}07:00Z`, read: false },
	{ id: "kakao-alert", kind: "alert", tone: "", title: "알림", text: "카톡 답장 보냈어요", open: "alert", src: "alert", ts: `${T}08:00Z`, read: false },
];
const integrations = [{ key: "mail", label: "메일", kind: "app", icon: "mail", conv: ["mail:"], notices: ["mail"] }, { key: "kakao", label: "카카오톡", kind: "app", icon: "chat", conv: [], notices: ["kakao-alert"] }];
const monitors = [{ name: "node security updates", watch: "node-security-updates", kind: "watch", channel: "ch:9", last_run: `${T}05:30Z`, last_result: "fail", next_run: `${T}35:30Z`, every: "30분마다" }];
const CHAT = ["alert", "dec", "msg", "res", "kakao-alert"];

describe("모니터링 lists only what a watch, a schedule or an integration produced", () => {
	test("no 알림 channel post, decision or session result shows in 모니터링, and every monitoring report shows once", () => {
		const m = load(store(), integrations, monitors), items = m.monItems();
		const ids = items.flatMap(i => i.notices.map(n => String(n.id)));
		for (const id of CHAT) expect(ids).not.toContain(id);
		expect(ids.sort()).toEqual(["gw", "mail", "sched", "watch"]);
		expect(new Set(ids).size).toBe(ids.length);
		const byKey = Object.fromEntries(items.map(i => [i.key, i.notices.map(n => n.id)]));
		expect(byKey["m:node security updates"]).toEqual(["watch", "gw"]);
		expect(byKey["notice"]).toEqual(["sched"]);
		expect(byKey["i:mail"]).toEqual(["mail"]);
		expect(byKey["i:kakao"]).toEqual([]);
	});

	test("a notice tap lands on its watch, else on the monitoring feed", () => {
		const m = load(store(), integrations, monitors);
		expect(m.monKeyOf({ kind: "watch", title: "node-security-updates" })).toBe("m:node security updates");
		expect(m.monKeyOf({ kind: "watch", title: "예약" })).toBe("notice");
	});
});

describe("모니터링 list order", () => {
	test("감시 소식 first, then the 앱 group (the integrations), then the 일반 모니터링 group (the monitors)", () => {
		const m = load(store(), integrations, monitors), rows = m.monRows(m.monItems(), null);
		const order = rows.map(r => (r.header ? `#${r.header}` : String(r.k)));
		expect(order).toEqual(["notice", "#앱", "i:mail", "i:kakao", "#일반 모니터링", "m:node security updates"]);
	});

	test("an integration without a kind is an app; no 앱 header when none is enabled", () => {
		const m = load([], [], monitors);
		expect(m.monRows(m.monItems(), null).map(r => (r.header ? `#${r.header}` : String(r.k)))).toEqual(["notice", "#일반 모니터링", "m:node security updates"]);
	});
});

describe("a watch row", () => {
	test("reads as words: a readable title, the newest result without the name in front, no raw name anywhere", () => {
		const m = load(store(), integrations, monitors), row = m.monItems().find(i => i.key === "m:node security updates")!;
		expect(row.name).toBe("node security updates");
		expect(row.hint).not.toContain("node-security-updates");
		expect(row.hint).toBe("실패했어요");
		const head = m.monHead(row).map(words).join("|");
		expect(head).toContain("node security updates");
		expect(head).not.toContain("node-security-updates");
	});

	test("a label-less watch name becomes words", () => {
		const m = load([], [], [{ name: "nas-php-node", kind: "watch", last_run: `${T}36:00Z`, last_result: "ok" }]);
		const row = m.monItems().find(i => i.key.startsWith("m:"))!;
		expect(row.name).toBe("nas php node");
		expect(row.hint).not.toContain("nas-php-node");
	});

	test("opens the conversation view: its reports and its latest run as message cards, no fact card", () => {
		const m = load(store(), integrations, monitors), items = m.monItems();
		const row = m.monRows(items, null).find(r => r.k === "m:node security updates")!;
		row.open!();
		expect(m.went).toEqual([["monitoring", "m:node security updates"]]);
		m.monRoute(m.went[0]![1]);
		const sel = m.monSel(items)!;
		expect(sel.key).toBe("m:node security updates");
		const nodes = m.monTimeline(sel);
		expect(nodes.length).toBe(3);
		for (const n of nodes) {
			expect(n.cls.split(" ")).toContain("bm");
			expect(words(n.querySelector(".rc-src"))).toBe("node security updates");
		}
		expect(m.drawn.map(e => String(e.text).split("\n")[0])).toEqual(["결과가 바뀌었어요", "실패했어요", expect.any(String)]);
	});

	test("a service row opens the same message cards", () => {
		const m = load(store(), integrations, monitors), sel = m.monItems().find(i => i.key === "i:mail")!;
		const nodes = m.monTimeline(sel);
		expect(nodes.length).toBe(1);
		expect(nodes[0]!.cls.split(" ")).toContain("bm");
		expect(m.drawn).toHaveLength(1);
	});
});
