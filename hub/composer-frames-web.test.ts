import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeHub, json, on } from "./test-web.ts";

// The owner types into a project conversation (ch:<id>) on a phone (390px, keyboard up) while the page receives every kind of frame the gateway
// streams. Whatever arrives, the textarea he types in stays the same connected node with its text and caret, no focusout or refocus happens on it
// (a refocus is what drops and raises a phone's keyboard), and when the frame changes nothing in this conversation the composer's box and the
// timeline's scroll do not move.
const CH = "ch:7001", OTHER = "ch:7002";
const at = (s = 0) => new Date(Date.now() + s * 1000).toISOString();
const ST = { status: "idle" as string, lanes: [] as object[], work: [] as object[], unread: 0, error: null as object | null };
const NOTICES: object[] = [];
const SUBS: Record<string, object[]> = {};
const hist = [
	{ ts: at(-300), kind: "message", source: "owner", target: CH, channel: "web", text: "이전 질문이에요." },
	{ ts: at(-290), kind: "out", source: "orchestrator", target: CH, text: "이전 답변이에요." },
];
const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		const p = url.pathname;
		if (p === "/api/state") return json({ name: "dotz", web_build: "same-build", orchestrator: { status: ST.status, ...(ST.error ? { error: ST.error } : {}) }, runs: {}, lanes: ST.lanes, terminals: {}, channels: { work: { "7001": { name: "데모 프로젝트" }, "7002": { name: "다른 프로젝트" } } }, discord: {}, notices_unread: ST.unread, work: ST.work, work_now: Date.now() });
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: url.searchParams.get("target") === CH && !url.searchParams.get("before") ? hist : [] });
		if (p === "/api/conversations") return json({ items: [{ target: "main", unread: 0, read: at(-100), last: { ts: at(-100), text: "마지막 줄", from: "bot" } }, { target: CH, unread: 0, read: at(-290), last: { ts: at(-290), text: "이전 답변이에요.", from: "bot" } }, { target: OTHER, unread: 0, read: at(-290), last: { ts: at(-290), text: "다른 줄", from: "bot" } }] });
		if (p === "/api/notices") return json({ unread: NOTICES.length, items: NOTICES });
		if (p === "/api/subagents") return json({ sources: SUBS });
		if (p === "/api/todo") return json({ phases: [{ name: "한 일", tasks: [{ content: "첫 단계", status: "completed" }, { content: "둘째 단계", status: "in_progress" }] }] });
		if (p === "/api/custom") return json({ dir: "~/.dotz/custom", cards: [], projects: [{ key: CH, name: "데모 프로젝트", pinned: false, lanes: [], newest: 0, channel: { id: "7001", name: "데모 프로젝트" }, recordKey: CH }, { key: OTHER, name: "다른 프로젝트", pinned: false, lanes: [], newest: 0, channel: { id: "7002", name: "다른 프로젝트" }, recordKey: OTHER }], routines: [], links: [] });
		if (p === "/api/context") return json({ note: "", processes: [], conversations: [], conversation_kinds: ["ch", "mail", "quick"], models: [], limits: {} });
		if (p === "/sw.js") return new Response("no", { status: 404 });
		return undefined;
	},
});
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

type Snap = { top: number; bottom: number; height: number; scroll: number; docScroll: number; same: boolean; conn: boolean; focus: boolean; value: string; caret: number; out: number; refocus: number; box: number[] };
const snap = () => ev<Snap>(`(() => { const r = document.querySelector("#send").getBoundingClientRect(), t = document.querySelector("#timeline");
	return { top: r.top, bottom: r.bottom, height: r.height, scroll: t.scrollTop, docScroll: document.scrollingElement.scrollTop, same: document.querySelector("#text") === window.__ta, conn: window.__ta.isConnected, focus: document.activeElement === window.__ta, value: window.__ta.value, caret: window.__ta.selectionStart, out: window.__out.length, refocus: window.__focus.length, box: (window.__box || []).slice() }; })()`);

// The frame has been handled once a later frame of the same ordered stream is: a sentinel to a conversation nobody has open, then the state read the frame would have caused.
let seq = 0;
async function settle() {
	const text = `끝 ${++seq}`;
	hub.push({ kind: "out", target: "lane:sentinel", source: "gateway", text, ts: at() });
	await waitFor(`ts("lane:sentinel").msgs.some(m => m.text === ${JSON.stringify(text)})`);
	await view.evaluate(`(clearTimeout(stateTimer), refreshState().then(() => 0))`);
	await view.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
	await view.evaluate(`new Promise(r => setTimeout(r, 0))`);
}

beforeEach(async () => {
	ST.status = "idle"; ST.lanes = []; ST.work = []; ST.unread = 0; ST.error = null; NOTICES.length = 0; for (const k of Object.keys(SUBS)) delete SUBS[k];
	const opened = hub.nextStream();
	await view.resize(390, 844);
	await view.navigate(`${hub.origin}/#chat/${CH}`);
	await waitFor(`typeof S === "object" && S && typeof CV === "object" && CV.loaded && current === "chat" && target === ${JSON.stringify(CH)}`);
	await opened;
	await waitFor(`ts(${JSON.stringify(CH)}).hLoaded && document.querySelector("#tl").textContent.includes("이전 답변이에요")`);
	await run(`ta.value = ""; saveDraft(); autosize(); window.__ta = document.querySelector("#text"); sessionStorage.clear(); reloadPage = () => {};
		window.__out = []; window.__focus = [];
		for (const t of ["focusout", "blur"]) document.addEventListener(t, e => { if (e.target === window.__ta) window.__out.push(t); }, true);
		document.addEventListener("focusin", e => { if (e.target === window.__ta) window.__focus.push("focusin"); }, true);
		const f = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (...a) { if (this === window.__ta) window.__focus.push("focus()"); return f.apply(this, a); };`);
	await view.click("#text");
	await waitFor(`document.activeElement === window.__ta`);
	await view.type("안녕하세요 배포 확인");
	// the keyboard is up: the page is shrunk to what is left of the screen
	await view.resize(390, 544);
	await run(`visualViewport.dispatchEvent(new Event("resize"))`);
	await waitFor(`window.__ta.value === "안녕하세요 배포 확인" && document.activeElement === window.__ta`);
	await view.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
	// the focus calls the setup itself made are not the frames' doing
	await run(`window.__out.length = 0; window.__focus.length = 0`);
});

type Frame = { name: string; run: () => Promise<void> | void; mine?: boolean };
const push = (e: object) => hub.push(e);
const FRAMES: Frame[] = [
	// live status of another conversation (the main chat's turn)
	{ name: "main turn: turn_start, tool_call, tool_result, text, status, turn_end", run: () => {
		push({ kind: "activity", source: "orchestrator", type: "turn_start", ts: at() });
		push({ kind: "activity", source: "orchestrator", type: "status", text: "도구를 쓰고 있어요", ts: at() });
		push({ kind: "activity", source: "orchestrator", type: "tool_call", tool: "Bash", call_id: "c1", text: "Bash: ls", args: JSON.stringify({ command: "ls", i: "목록 보기" }), ts: at() });
		push({ kind: "activity", source: "orchestrator", type: "tool_result", tool: "Bash", call_id: "c1", text: "a\nb", ts: at() });
		push({ kind: "activity", source: "orchestrator", type: "text", text: "확인 중이에요", ts: at() });
		push({ kind: "activity", source: "orchestrator", type: "turn_end", ts: at() });
	} },
	{ name: "main turn: todo tool call refetches the plan", run: () => {
		push({ kind: "activity", source: "orchestrator", type: "tool_call", tool: "todo", call_id: "t1", text: "todo", ts: at() });
		push({ kind: "activity", source: "orchestrator", type: "tool_result", tool: "todo", call_id: "t1", text: "ok", ts: at() });
	} },
	{ name: "another project's turn (conv: source)", run: () => {
		push({ kind: "activity", source: `conv:${OTHER}`, type: "turn_start", ts: at() });
		push({ kind: "activity", source: `conv:${OTHER}`, type: "tool_call", tool: "Bash", call_id: "o1", text: "Bash: ls", ts: at() });
		push({ kind: "activity", source: `conv:${OTHER}`, type: "turn_end", ts: at() });
	} },
	{ name: "this conversation's own live turn (conv: source)", mine: true, run: () => {
		push({ kind: "activity", source: `conv:${CH}`, type: "turn_start", ts: at() });
		push({ kind: "activity", source: `conv:${CH}`, type: "status", text: "생각하고 있어요", ts: at() });
		push({ kind: "activity", source: `conv:${CH}`, type: "tool_call", tool: "Bash", call_id: "m1", text: "Bash: ls", ts: at() });
		push({ kind: "activity", source: `conv:${CH}`, type: "tool_result", tool: "Bash", call_id: "m1", text: "a", ts: at() });
		push({ kind: "activity", source: `conv:${CH}`, type: "turn_end", ts: at() });
	} },
	{ name: "a session's activity", run: () => {
		push({ kind: "activity", source: "w1", type: "turn_start", ts: at() });
		push({ kind: "activity", source: "w1", type: "tool_call", tool: "Bash", call_id: "w1", text: "Bash: ls", ts: at() });
		push({ kind: "activity", source: "w1", type: "turn_end", ts: at() });
	} },
	// subagents and queue and waitlist
	{ name: "subagents of the main turn start, change, finish", run: async () => {
		push({ kind: "subagents", source: "orchestrator", items: [{ id: "s1", description: "조사", status: "running", started_at: Date.now() }] });
		push({ kind: "subagents", source: "orchestrator", items: [{ id: "s1", description: "조사", status: "running", started_at: Date.now() }, { id: "s2", description: "정리", status: "running", started_at: Date.now() }] });
		push({ kind: "subagents", source: "orchestrator", items: [] });
	} },
	{ name: "subagents of this conversation", mine: true, run: () => {
		push({ kind: "subagents", source: `conv:${CH}`, items: [{ id: "s3", description: "조사", status: "running", started_at: Date.now() }] });
		push({ kind: "subagents", source: `conv:${CH}`, items: [] });
	} },
	{ name: "queue frame", run: () => push({ kind: "queue", items: [{ id: "q1", target: "main", text: "대기 중인 글", ts: at() }] }) },
	{ name: "waitlist frame", run: () => push({ kind: "waitlist", items: [{ id: "w1", text: "할 일", ts: at() }] }) },
	// work rows: a job starts, runs, finishes and leaves the list
	{ name: "work row frames: running, then done, then gone from the list", run: async () => {
		ST.work = [{ id: "st_a", description: "일", status: "running", started_at: Date.now() - 5000 }];
		push({ kind: "work", at: Date.now(), items: [{ id: "st_a", status: "running", at: Date.now() }] });
		await settle();
		ST.work = [{ id: "st_a", description: "일", status: "done", started_at: Date.now() - 9000, ended_at: Date.now() }];
		push({ kind: "work", at: Date.now() + 1, items: [{ id: "st_a", status: "done", at: Date.now() + 1, result_at: at() }] });
		await settle();
		ST.work = [];
		push({ kind: "work", at: Date.now() + 2, items: [{ id: "st_a", status: "gone", at: Date.now() + 2 }] });
	} },
	{ name: "work row of this conversation: system line, running, done", mine: true, run: async () => {
		push({ kind: "out", target: CH, source: "gateway", system: true, worker: "st_b", text: "백그라운드 작업으로 맡겼어요: 정리", ts: at() });
		ST.work = [{ id: "st_b", description: "정리", status: "running", started_at: Date.now() }];
		push({ kind: "work", at: Date.now(), items: [{ id: "st_b", status: "running", at: Date.now() }] });
		await settle();
		ST.work = [{ id: "st_b", description: "정리", status: "done", started_at: Date.now() - 4000, ended_at: Date.now() }];
		push({ kind: "work", at: Date.now() + 1, items: [{ id: "st_b", status: "done", at: Date.now() + 1 }] });
		await settle();
		ST.work = [];
		push({ kind: "work", at: Date.now() + 2, items: [{ id: "st_b", status: "gone", at: Date.now() + 2 }] });
	} },
	// notices
	{ name: "notice added, read, taken back (dismissed)", run: async () => {
		const item = { id: 9001, kind: "message", title: "세션 x", text: "서브 작업이 끝났어요", ts: at() };
		NOTICES.push(item); ST.unread = 1;
		push({ kind: "notice", item });
		await settle();
		push({ kind: "notice_read", id: 9001 });
		await settle();
		NOTICES.length = 0; ST.unread = 0;
		push({ kind: "notice", item: { ...item, dismissed: true } });
		push({ kind: "notice_dismiss", id: 9001 });
	} },
	{ name: "decision notice for the main chat", run: () => push({ kind: "notice", item: { id: 9002, kind: "decision", title: "배포를 확인해 주세요", text: "확인해 주세요", ts: at(), decision: { state: "open", to: "main", options: [{ n: 1, label: "확인됨" }, { n: 2, label: "안 됨" }] } } }) },
	// delivery
	{ name: "delivery states of an owner message in this conversation", mine: true, run: async () => {
		push({ kind: "message", source: "owner", target: CH, channel: "web", text: "보낸 글이에요", ts: "2026-11-13T00:00:00.000Z" });
		await settle();
		for (const state of ["received", "steered", "queued", "answered"]) { push({ kind: "delivery", source: "gateway", target: CH, ref: "2026-11-13T00:00:00.000Z", state, text: "", ts: at() }); await settle(); }
	} },
	{ name: "delivery of another conversation's message", run: () => push({ kind: "delivery", source: "gateway", target: "main", ref: "x", state: "answered", text: "", ts: at() }) },
	// messages
	{ name: "answer arrives in another conversation (unread badge)", run: () => push({ kind: "out", target: OTHER, source: "orchestrator", text: "다른 곳의 답변이에요", ts: at() }) },
	{ name: "answer arrives in the main chat", run: () => push({ kind: "out", target: "main", source: "orchestrator", text: "메인 답변이에요", ts: at() }) },
	{ name: "answer arrives in this conversation", mine: true, run: () => push({ kind: "out", target: CH, source: "orchestrator", text: "이 대화의 답변이에요", ts: at() }) },
	{ name: "progress line (update_key) in this conversation", mine: true, run: () => { push({ kind: "out", target: CH, source: "orchestrator", update_key: "progress", text: "진행 중 1", ts: at() }); push({ kind: "out", target: CH, source: "orchestrator", update_key: "progress", text: "진행 중 2", ts: at(1) }); } },
	{ name: "system line arrives in this conversation", mine: true, run: () => push({ kind: "out", target: CH, source: "gateway", system: true, text: "게이트웨이 알림 줄이에요", ts: at() }) },
	{ name: "lane report", run: () => push({ kind: "lane_report", lane: "x", text: "서브 작업이 끝났어요", ts: at() }) },
	{ name: "alert and worklog posts", run: () => { push({ kind: "out", target: "alert", source: "gateway", text: "경고예요", ts: at() }); push({ kind: "out", target: "worklog", source: "gateway", update_key: "w", text: "작업 기록", ts: at() }); } },
	// read marks, project info, lanes, misc
	{ name: "read marks", run: () => { push({ kind: "read", target: "main", ts: at(10) }); push({ kind: "read", target: OTHER, ts: at(10) }); } },
	{ name: "project_info of this project and another", run: () => { push({ kind: "project_info", key: CH }); push({ kind: "project_info", key: OTHER }); } },
	{ name: "lanes frame: a session ends", run: () => push({ kind: "lanes", name: "x", was_live: true, live: false }) },
	{ name: "quota, update_available, runtime_check, approvals", run: () => { push({ kind: "quota", quota: { ok: true } }); push({ kind: "update_available" }); push({ kind: "runtime_check" }); push({ kind: "approvals" }); } },
	{ name: "peer, comment, kakao, mail frames", run: () => { push({ kind: "peer_counts", counts: {} }); push({ kind: "comment", id: "c1" }); push({ kind: "kakao", id: "k1" }); push({ kind: "mail_unreplied" }); } },
	// state refreshes
	{ name: "state: the main chat starts working, then goes idle", run: async () => { ST.status = "working"; await settle(); ST.status = "idle"; } },
	{ name: "state: a session appears, works and ends", run: async () => {
		ST.lanes = [{ name: "x", title: "세션 x", status: "working", live: true, session: "x", home: CH, kind: "work", startedAt: new Date().toISOString() }]; await settle();
		ST.lanes = [{ name: "x", title: "세션 x", status: "idle", live: true, session: "x", home: CH, kind: "work", startedAt: new Date().toISOString() }]; await settle();
		ST.lanes = [];
	} },
	{ name: "state: unread notice count and an error line", run: async () => { ST.unread = 3; await settle(); ST.error = { text: "모델 오류", ts: new Date().toISOString() }; await settle(); ST.error = null; ST.unread = 0; } },
];

describe("typing in a project conversation while frames arrive", () => {
	for (const f of FRAMES) {
		test(f.name, async () => {
			const first = await snap();
			expect(first).toMatchObject({ same: true, conn: true, focus: true, value: "안녕하세요 배포 확인" });
			await run(`window.__box = []; new ResizeObserver(es => { for (const e of es) window.__box.push(Math.round(e.contentRect.height)); }).observe(document.querySelector("#composer"))`);
			await view.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => { window.__box.length = 0; r(); })))`);
			await f.run();
			await settle();
			const now = await snap();
			expect(now).toMatchObject({ same: true, conn: true, focus: true, value: first.value, caret: first.caret, out: 0, refocus: 0 });
			expect(now.bottom).toBeCloseTo(first.bottom, 1);
			if (!f.mine) {
				expect(now.box).toEqual([]);
				expect(now.top).toBeCloseTo(first.top, 1);
				expect(now.height).toBeCloseTo(first.height, 1);
				expect(now.scroll).toBeCloseTo(first.scroll, 0);
			}
			expect(now.docScroll).toBe(first.docScroll);
		}, 30_000);
	}
});
