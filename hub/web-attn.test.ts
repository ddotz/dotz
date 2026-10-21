import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The "확인 필요" toast (09-needs-you.js toastAttn) driven by the real event intake (13-data.js ingestMsg / onActivity).
const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const cut = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));

function page(opts: { current?: string } = {}) {
	const needs = cut(web("09-needs-you.js"), "const SEEN_KEY", "/* ---------- usage strip");
	const data = web("13-data.js");
	const intake = cut(data, "function ingestMsg", "async function loadTarget") + cut(data, "function onActivity", "/* ---------- switching");
	const MAIN = "web", notes: { title: string; text: string; ts: string }[] = [];
	const store = new Map<string, string>();
	const TS: Record<string, any> = {};
	const env: Record<string, unknown> = {
		localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
		document: { visibilityState: "visible" },
		target: MAIN, current: opts.current ?? "home", MAIN,
		S: { orchestrator: { status: "working" }, lanes: [] as { name: string; status: string }[] },
		convListing: () => false, projTargets: () => [], liveTargets: () => [MAIN],
		isProjT: (t: string) => /^ch:\d+$/.test(t), isLaneT: (t: string) => t.startsWith("lane:"),
		targetName: () => "dotz", notify: (e: any) => notes.push(e), renderHome: () => {}, renderLanes: () => {}, $: () => null,
		ts: (t: string) => TS[t] || (TS[t] = { msgs: [], mk: new Set(), acts: [], ak: new Set(), cap: 600, hLoaded: false, aLoaded: false }),
		TS, msgKey: (e: any) => `${e.ts}|${e.kind}|${e.text}`, actKey: (a: any) => `${a.ts}|${a.type}`,
		eventTarget: () => MAIN, targetOfSource: () => MAIN, isRestart: () => false, paintRestartBanner: () => {}, convNote: () => {},
		CV: { full: false }, chatPush: () => {}, termPush: () => {}, ownerish: () => false, ownerAct: () => ({}), paintDecision: () => {},
		isLaneReport: () => false, LP: {}, laneRefresh: () => {}, scheduleState: () => {}, todoActivity: () => {},
	};
	const S = env.S as { orchestrator: { status: string } };
	(env as any).targetInfo = () => ({ alive: true, status: S.orchestrator.status });
	let api: any;
	// renderBars repaints the badge, and paintAttn's toastAttn runs with it (as in the page).
	env.renderBars = () => api.toastAttn();
	api = new Function(...Object.keys(env), `${needs}\n${intake}\nreturn { noteStatus, toastAttn, onActivity, ingestMsg, chatUnreadCount };`)(...Object.values(env));
	api.noteStatus(); api.toastAttn();   // page load
	return { api, S, notes };
}
const T0 = Date.now();
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const answer = (s: number, extra: Record<string, unknown> = {}) => ({ ts: at(s), kind: "out", source: "orchestrator", target: "web", text: `답 ${s}`, ...extra });

describe("채팅 nav badge", () => {
	test("counts the listed conversations with unread messages; a finished or asking session never holds it", () => {
		const { api } = page();
		const unread: Record<string, number> = { web: 0, "ch:1": 2, "ch:2": 0, "lane:a": 1 };
		expect(api.chatUnreadCount(["web", "ch:1", "ch:2"], (t: string) => unread[t] ?? 0)).toBe(1);
		unread["ch:1"] = 0;
		expect(api.chatUnreadCount(["web", "ch:1", "ch:2"], (t: string) => unread[t] ?? 0)).toBe(0);
	});
});

describe("main chat 확인 필요 toast", () => {
	test("a finished turn without a delivered answer (deferred to a worker, keepalive) pops nothing; the answer landing pops it once", () => {
		const { api, S, notes } = page();
		api.onActivity({ ts: at(1), source: "orchestrator", type: "turn_end" });
		S.orchestrator.status = "idle"; api.noteStatus(); api.toastAttn();
		api.ingestMsg(answer(2, { source: "gateway", update_key: "progress", text: "작업 중" }));   // progress note: not an answer
		expect(notes).toEqual([]);
		api.ingestMsg(answer(3));
		expect(notes.map(n => [n.text, n.ts])).toEqual([["답을 마쳤어요. 확인해 주세요", at(3)]]);
		api.ingestMsg(answer(4));
		api.onActivity({ ts: at(5), source: "orchestrator", type: "turn_end" });
		expect(notes.length).toBe(1);
	});

	test("an answer landing in the chat the owner has open pops nothing", () => {
		const { api, notes } = page({ current: "chat" });
		api.ingestMsg(answer(1));
		expect(notes).toEqual([]);
	});
});
