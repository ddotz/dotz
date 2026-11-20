import { afterEach, beforeAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { emit, type HubEvent, onEmit } from "./events.ts";
import { msg } from "./i18n.ts";
import { ko } from "./i18n-ko.ts";
import { inboxText } from "./intake.ts";
import { allNotices, answerDecision, answerReply, decisionsOf, type Notice, onDecision, onNoticeUnread } from "./notices.ts";
import { firstSentence, SENTENCE_MAX } from "./notices-schedule.ts";
import { createPrompts, type Pending } from "./prompts.ts";
import type { Reply } from "./prompts-model.ts";
import { classify, decisionPush, noticePush } from "./push.ts";
import { deliverAnswer } from "./routes.ts";
import { routeLanes } from "./routes-lanes.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import { FAIL_AFTER_MS, fireSchedule, namingDeps, scheduleRan, sweepRuns } from "./schedule-fire.ts";
import { addSchedule, listScheduleRuns, listSchedules, markScheduleRun, removeSchedule, runNow, startSchedules } from "./schedule.ts";

const events: HubEvent[] = [];
const delivered: { text: string; reply: Reply }[] = [];
const pushes: { title: string; body: string; url: string }[] = [];
onEmit(e => {
	const m = classify(e);
	if (m && !decisionsOf(e).length && !answerReply(e)) pushes.push(m);
});
onNoticeUnread(n => {
	const m = noticePush(n);
	if (m) pushes.push(m);
});
onDecision(n => void pushes.push(decisionPush(n)));
beforeAll(() => startSchedules((s, group, runs) => fireSchedule(s, group, runs, { emit: (box, e) => (events.push(e), emit(box, e)), deliver: (text, reply) => void delivered.push({ text, reply }), inboxText, fallback: () => "web" })));
afterEach(() => {
	for (const s of listSchedules()) removeSchedule(s.id);
	for (const r of listScheduleRuns()) if (r.state === "fired" || r.state === "held") markScheduleRun(r.run, "answered");
	events.length = delivered.length = pushes.length = 0;
});

function session() {
	const saved: Pending[][] = [];
	const q = createPrompts({
		deliver: () => {}, steer: () => true, working: () => true, note: (_t, _r, t) => t, isNote: () => false, clearProgress: () => {}, log: () => {}, persist: o => void saved.push(o), ran: scheduleRan,
		post: async (target, text, replyTo, opts) => (emit("outbox", { ts: now(), kind: "out", source: "orchestrator", target, text, reply_to: replyTo ?? null, auto: true, ...opts }), { delivered: true }),
	});
	const answer = async (d: { text: string; reply: Reply }, said: string) => {
		q.deliver(d.text, d.reply);
		q.onPrompt(d.text);
		await advance(1000);
		q.onAnswer(said);
		await flush();
	};
	return { q, saved, answer };
}
const rowOf = (run: string): Notice | undefined => allNotices().find(n => n.key === `schedule:${run}`);
const stateOf = (run: string) => listScheduleRuns().find(r => r.run === run)?.state;

test("a fire's inbox event carries the run, the name and the kind, and its prompt carries the run to the answer", () => {
	const s = addSchedule({ name: "sample-2 일일 보고", kind: "task", text: "sample-2 보고 써 줘", in_minutes: 600, every_minutes: 1440, conv: "ch:123" });
	const run = runNow(s.id);
	expect(events).toEqual([{ ts: expect.any(String), kind: "schedule", source: "schedule", channel: "ch:123", id: s.id, run, name: "sample-2 일일 보고", sk: "task", every: 1440, text: "sample-2 보고 써 줘" }]);
	expect(delivered).toEqual([{ text: inboxText(events[0]!), reply: { target: "ch:123", run: { ids: [run], sk: "task" } } }]);
});

test("checks due together are one quiet turn whose event keeps ids and runs in order", () => {
	const s = addSchedule({ name: "sample-3 점검", kind: "check", text: "sample-3 상태 확인", in_minutes: 600 });
	const run = runNow(s.id);
	expect(events[0]).toMatchObject({ source: "gateway", quiet: true, ids: [s.id], runs: [run], sk: "check", channel: "web" });
	expect(delivered[0]!.reply).toEqual({ target: "web", quiet: true, run: { ids: [run], sk: "check" } });
	expect(allNotices().some(n => n.key === `schedule:${run}`)).toBe(false);
});

test("the one-time naming line goes to the main conversation, not the born-read work log", async () => {
	const posts: [string, string, Record<string, unknown>][] = [];
	const woke: unknown[][] = [];
	const deps = namingDeps({ wake: (...a) => void woke.push(a), out: async (target, text, _r, extra) => void posts.push([target, text, extra]), fallback: () => "chat" });
	deps.wake("이름 붙이기");
	deps.post("예약에 이름과 종류를 붙였어요: sample");
	await flush();
	expect(woke).toEqual([["schedule-naming", "이름 붙이기", true]]);
	expect(posts).toEqual([["chat", "예약에 이름과 종류를 붙였어요: sample", { source: "gateway", nk: "gateway-note" }]]);
});

test("a task run: no start notice or push, one row that becomes its answer's first sentence, and one push for it", async () => {
	const s = addSchedule({ name: "sample-2 피드백 일일 보고", kind: "task", text: "sample-2 피드백 정리해서 보고해", in_minutes: 600 });
	const run = runNow(s.id);
	expect(rowOf(run)).toMatchObject({ title: "sample-2 피드백 일일 보고", text: msg().scheduleRun.running, open: "main", read: true });
	expect(pushes).toEqual([]);
	await session().answer(delivered[0]!, "어제는 불편·재요청이 없었어요. 자세한 표는 아래에 있어요.\n- 0건");
	const row = rowOf(run)!;
	expect(row).toMatchObject({ title: "sample-2 피드백 일일 보고", text: "어제는 불편·재요청이 없었어요", read: false, nk: "schedule" });
	expect(pushes).toEqual([expect.objectContaining({ title: "sample-2 피드백 일일 보고 · 어제는 불편·재요청이 없었어요", body: "" })]);
	expect(pushes[0]!.url).toContain(`m=${encodeURIComponent(row.at)}`);
	expect(allNotices().some(n => n.key === "msg:main" && n.at === row.at)).toBe(false);
	expect(stateOf(run)).toBe("answered");
});

test("a task run with nothing to tell leaves its row saying so, with no push", async () => {
	const s = addSchedule({ name: "sample-2 조용한 보고", kind: "task", text: "sample-2 볼 것 있으면 보고해", in_minutes: 600 });
	const run = runNow(s.id);
	await session().answer(delivered[0]!, "-");
	expect(rowOf(run)).toMatchObject({ text: msg().scheduleRun.nothing, read: true });
	expect(pushes).toEqual([]);
	expect(stateOf(run)).toBe("silent");
});

test("a reminder rings at fire time as before, titled by its name", () => {
	const s = addSchedule({ name: "회의 알림", kind: "owner", text: "3시에 회의 알려줘", in_minutes: 600 });
	const run = runNow(s.id);
	expect(rowOf(run)).toMatchObject({ title: "회의 알림", read: false });
	expect(pushes).toEqual([expect.objectContaining({ title: "회의 알림 · 새 소식" })]);
});

test("held by a usage limit, then 30 minutes after the limit lifts with no result a decision; 다시 실행 is a new run with no model turn for the answer", async () => {
	const s = addSchedule({ name: "sample-4 매일 점검", kind: "task", text: "sample-4 상태 보고해", in_minutes: 600, every_minutes: 1440 });
	const at = s.at;
	const run = runNow(s.id);
	sweepRuns(() => true, "web");
	expect(stateOf(run)).toBe("held");
	expect(rowOf(run)).toMatchObject({ title: "sample-4 매일 점검", text: msg().scheduleRun.held("sample-4 매일 점검") });
	expect(pushes).toEqual([]);
	sweepRuns(() => false, "web");
	await advance(FAIL_AFTER_MS - 1000);
	sweepRuns(() => false, "web");
	expect(stateOf(run)).toBe("held");
	await advance(1000);
	sweepRuns(() => false, "web");
	expect(stateOf(run)).toBe("failed");
	const card = rowOf(run)!;
	expect(card).toMatchObject({ kind: "decision", title: msg().scheduleRun.failed("sample-4 매일 점검"), text: "sample-4 매일 점검", open: "main" });
	expect(card.decision!.options.map(o => o.label)).toEqual([msg().scheduleRun.rerun, msg().scheduleRun.stop]);
	expect(pushes).toEqual([expect.objectContaining({ body: msg().scheduleRun.failed("sample-4 매일 점검"), url: expect.stringMatching(/#chat\/main$/) })]);
	delivered.length = 0;
	const r = await answerDecision(card.id, { n: 1 }, a => deliverAnswer({ ...a, login: "local" }));
	expect(r.status).toBe(200);
	const again = listScheduleRuns().filter(x => x.scheduleId === s.id);
	expect(again.map(x => x.state)).toEqual(["failed", "fired"]);
	expect(delivered).toEqual([{ text: expect.stringContaining("sample-4 상태 보고해"), reply: { target: "web", run: { ids: [again[1]!.run], sk: "task" } } }]);
	expect(listSchedules().find(x => x.id === s.id)!.at).toBe(at);
});

test("an answer that comes after the failure decision closes it and takes the row", async () => {
	const s = addSchedule({ name: "sample-5 보고", kind: "task", text: "sample-5 보고해", in_minutes: 600 });
	const run = runNow(s.id);
	const d = delivered[0]!;
	sweepRuns(() => true, "web");
	sweepRuns(() => false, "web");
	await advance(FAIL_AFTER_MS);
	sweepRuns(() => false, "web");
	const card = rowOf(run)!;
	await session().answer(d, "늦었지만 끝냈어요.");
	expect(card.decision).toMatchObject({ state: "answered", resolved: true });
	expect(rowOf(run)).toMatchObject({ title: "sample-5 보고", text: "늦었지만 끝냈어요", read: false });
});

test("a restart replay keeps the run link: the replayed prompt's answer still lands on its run", async () => {
	const s = addSchedule({ name: "sample-6 보고", kind: "task", text: "sample-6 보고해", in_minutes: 600 });
	const run = runNow(s.id);
	const before = session();
	before.q.deliver(delivered[0]!.text, delivered[0]!.reply);
	const pending = before.saved.at(-1)!;
	expect(pending[0]!.run).toEqual({ ids: [run], sk: "task" });
	const after = session();
	expect(after.q.replay(JSON.parse(JSON.stringify(pending)), t => t)).toBe(1);
	after.q.onPrompt(pending[0]!.text);
	after.q.onAnswer("다시 시작해서 끝냈어요. 표는 대화에 있어요.");
	await flush();
	expect(rowOf(run)).toMatchObject({ text: "다시 시작해서 끝냈어요", read: false });
	expect(stateOf(run)).toBe("answered");
});

test("POST /api/schedules/<id>/run fires a new run without moving `at`; GET lists the items and the runs", async () => {
	const call = async (method: string, path: string) => {
		const url = new URL(`http://hub${path}`);
		const res = (await routeLanes(new Request(url, { method }), url, url.pathname.split("/").filter(Boolean)))!;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};
	const s = addSchedule({ name: "sample-7", kind: "task", text: "sample-7 보고해", in_minutes: 600 });
	const fired = await call("POST", `/api/schedules/${s.id}/run`);
	expect(fired.status).toBe(200);
	expect(listScheduleRuns().findLast(r => r.scheduleId === s.id)!.run).toBe(fired.body.run as string);
	const list = await call("GET", "/api/schedules");
	expect((list.body.items as { id: string; at: string }[]).find(x => x.id === s.id)!.at).toBe(s.at);
	expect((list.body.runs as { run: string }[]).some(r => r.run === fired.body.run)).toBe(true);
	expect((await call("POST", "/api/schedules/nope00/run")).status).toBe(404);
});

test("the Korean words of a run's row are the owner's", () => {
	const t = ko.scheduleRun;
	expect([t.running, t.nothing, t.posted, t.held("Big Bath 매일 점검"), t.failed("주간 보고"), t.rerun, t.stop]).toEqual(["돌아가는 중이에요", "알릴 게 없었어요", "결과를 대화에 올렸어요", "Big Bath 매일 점검: 모델 사용량 한도로 기다리는 중이에요. 풀리면 바로 시작해요.", "주간 보고을(를) 못 했어요. 지금 다시 실행할까요?", "다시 실행", "그만두기"]);
});

test("the first sentence: the first line's first sentence without list marks or a closing period, never longer than SENTENCE_MAX", () => {
	expect(firstSentence("- 어제는 없었어요. 오늘은 2건이에요.")).toBe("어제는 없었어요");
	expect(firstSentence("\n\n## 결과 나왔나요? 네")).toBe("결과 나왔나요?");
	expect(firstSentence("")).toBe("");
	let seed = 7;
	const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
	const parts = ["가", "나 ", "다.", " ", "\n", "!", "?", "'", "\"", "$(rm)", "😀", "a.b", "x".repeat(300), "-", "#"];
	for (let i = 0; i < 500; i++) {
		const text = Array.from({ length: rand(20) }, () => parts[rand(parts.length)]).join("");
		const said = firstSentence(text);
		expect(said.length).toBeLessThanOrEqual(SENTENCE_MAX);
		expect(said.includes("\n")).toBe(false);
	}
});
