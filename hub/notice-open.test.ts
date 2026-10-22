import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", f), "utf8");
const notices = web("js/30-notices.js");
const between = (src: string, from: string, to: string) => {
	const a = src.indexOf(from), b = src.indexOf(to, a);
	if (a < 0 || b < 0) throw new Error(`block not found: ${from}`);
	return src.slice(a, b);
};

type N = Record<string, unknown>;
const dec = { options: [], to: "main", reply_to: "t", group: 1, state: "open" };

// The kind -> action mapping (30-notices.js noticeKindAction), run as shipped.
const actionOf = new Function("NM", "ntIsDec", `${between(notices, "function noticeKindAction", "async function noticeOpen(")}; return noticeKindAction;`)(
	{ items: [] }, (n: N) => n.kind === "decision" && !!n.decision,
) as (n: N, mons?: { name: string }[]) => string;

describe("notice kind -> action", () => {
	const mons = [{ name: "디스크 감시" }];
	test.each([
		["open decision", { kind: "decision", decision: dec, tone: "ask" }, "sheet"],
		["answered decision", { kind: "decision", decision: { ...dec, state: "answered" } }, "sheet"],
		["[ask] message", { kind: "alert", tone: "ask", src: "alert" }, "ask"],
		["session [ask]", { kind: "result", tone: "ask", src: "lane:a" }, "ask"],
		["failure alert", { kind: "alert", tone: "fail", src: "alert" }, "detail"],
		["session report", { kind: "result", tone: "done", src: "lane:a", open: "lane:a" }, "session"],
		["failed session report", { kind: "result", tone: "fail", src: "lane:a" }, "session"],
		["worklog item", { kind: "worklog", tone: "", src: "worklog" }, "worklog"],
		["monitor notice", { kind: "watch", tone: "", title: "디스크 감시", src: "alert" }, "monitor"],
		["monitor that is gone", { kind: "watch", tone: "", title: "없는 감시", src: "alert" }, "message"],
		["plain alert", { kind: "alert", tone: "", src: "alert" }, "message"],
		["plain message", { kind: "message", tone: "", src: "main" }, "message"],
	])("%s", (_name, n, want) => {
		expect(actionOf(n as N, mons)).toBe(want as string);
	});
});

describe("noticeOpen dispatch", () => {
	const run = (n: N | null, ask = true) => {
		const calls: unknown[][] = [];
		const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); return undefined; };
		const fn = new Function("noticeKindAction", "ntRead", "noticeSheetOpen", "ntAskSheet", "ntJump", "ntDetailOpen", "ntSession", "monOpen",
			`${between(notices, "async function noticeOpen(", "async function noticeOpenId(")}; return noticeOpen;`)(
			(x: N) => x.act, rec("read"), rec("sheet"), (x: N) => { calls.push(["ask", x.id]); return Promise.resolve(ask); }, rec("jump"), rec("detail"), rec("session"), rec("monitor"));
		return fn(n).then(() => calls);
	};
	test("each action reaches its own opener", async () => {
		expect(await run({ act: "sheet", id: "7" })).toEqual([["sheet", "7"]]);
		expect(await run({ act: "detail", id: "8" })).toEqual([["read", { act: "detail", id: "8" }], ["detail", { act: "detail", id: "8" }]]);
		expect((await run({ act: "session", id: "9" }))[1]![0]).toBe("session");
		expect(await run({ act: "monitor", title: "디스크 감시" })).toEqual([["read", { act: "monitor", title: "디스크 감시" }], ["monitor", "디스크 감시"]]);
		expect(await run({ act: "worklog", id: "1" })).toEqual([["jump", { act: "worklog", id: "1" }]]);
		expect(await run({ act: "message", id: "2" })).toEqual([["jump", { act: "message", id: "2" }]]);
		expect(await run(null)).toEqual([]);
	});
	test("an [ask] whose question is gone falls back to the conversation", async () => {
		expect(await run({ act: "ask", id: "3" }, true)).toEqual([["ask", "3"]]);
		expect(await run({ act: "ask", id: "3" }, false)).toEqual([["ask", "3"], ["jump", { act: "ask", id: "3" }]]);
	});
});

describe("entry points use the shared handler", () => {
	test("the home notice card: each row opens its notice through noticeOpen, without opening the card", () => {
		const opened: N[] = [];
		const stop: string[] = [];
		const el = (_t: string, p: Record<string, unknown>, ...kids: unknown[]) => ({ p, kids });
		const block = between(web("js/08-home.js"), "const hcNotices", "// Gateway restarts");
		const hcNotices = new Function("el", "hcDot", "hcLine", "ntLaneNote", "ntWhen", "noticeOpen", `${block}; return hcNotices;`)(
			el, () => null, (n: N) => n.title, () => "", () => "", (n: N) => opened.push(n)) as (l: N[]) => { kids: { p: { onclick: (ev: unknown) => void; onkeydown: (ev: unknown) => void } }[] };
		const list = [{ id: "a", kind: "decision", title: "결정" }, { id: "b", kind: "alert", title: "경고" }];
		const rows = hcNotices(list).kids;
		const ev = { stopPropagation: () => stop.push("s"), preventDefault: () => {}, key: "Enter" };
		rows[0]!.p.onclick(ev);
		rows[1]!.p.onkeydown(ev);
		expect(opened).toEqual(list);
		expect(stop).toHaveLength(2);
	});

	test("the 알림 / 작업내역 screens: a tapped message opens its notice through noticeOpen, an inline choice row too", () => {
		class Element { constructor(public closest: (sel: string) => unknown) {} }
		const opened: unknown[] = [], msgs = [{ ts: "T1", kind: "out", target: "alert" }];
		let handler: ((ev: unknown) => void) | undefined;
		const timeline = { addEventListener: (_t: string, h: (ev: unknown) => void, cap: boolean) => { if (cap) handler = h; } };
		const bm = { dataset: { ts: "T1" } };
		const make = (state: { current: string; target: string }) => new Function("timeline", "current", "target", "isFixedT", "Element", "tl", "ts", "getSelection", "ntOfEvent", "noticeOpen",
			`${between(notices, "timeline.addEventListener(\"click\"", "}, true);")}}, true);`)(
			timeline, state.current, state.target, (t: string) => t === "alert" || t === "worklog", Element, { contains: () => true }, () => ({ msgs }), () => "", (e: unknown) => ({ e }), (n: unknown) => opened.push(n));
		const tap = (inside: Record<string, boolean>) => {
			const flags: string[] = [];
			handler!({ target: new Element(sel => (sel === ".bm[data-ts]" ? bm : inside[sel] ? {} : null)), stopPropagation: () => flags.push("stop"), preventDefault: () => flags.push("prevent") });
			return flags;
		};
		make({ current: "chat", target: "alert" });
		expect(tap({})).toEqual(["stop", "prevent"]);
		expect(opened).toEqual([{ e: msgs[0] }]);
		const link = "a, summary, details[open] pre, input, textarea, button:not(.dcm-row)";
		expect(tap({ [link]: true })).toEqual([]);   // a link / fold / other button inside keeps its own job
		expect(opened).toHaveLength(1);
		make({ current: "chat", target: "main" });   // the main chat is untouched: its choice rows answer in place
		expect(tap({})).toEqual([]);
		expect(opened).toHaveLength(1);
	});

	test("toast, push, 답변 필요, the service worker message and a cold start all go through the same handler", () => {
		const md = web("js/02-basic-markdown.js"), home = web("js/08-home.js"), sw = web("js/23-installable-app-web.js");
		expect(between(md, "n.addEventListener(\"click\"", "n.addEventListener(\"pointerenter\"")).toContain("noticeOpen(ntOfEvent(e))");
		expect(between(notices, "function pushOpen", "/* ---- one handler")).toContain("noticeOpen(");
		expect(between(notices, "function ntHomeRow", "/* ---- detail sheet")).toContain("noticeOpen(n)");
		expect(notices).toContain("if (d.notice) noticeOpenId(d.notice);");
		expect(notices).toContain("setTimeout(() => noticeOpenId(want), 500);");
		expect(between(notices, "function noticeLive", "async function ntMarkRead")).toContain("noticeOpenId(e.item.id)");
		expect(sw).toContain("pushOpen(h, d.ts)");
		expect(home).toContain("noticeOpen(n)");
	});
});
