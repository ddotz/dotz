// An owner message to a session shows its delivery state and is answered at the session's next tool boundary, not only in the
// final report (2026-10-21, owner: "내가 직접 레인에 보내는건 피드백이 안와서 잘 모르겠음"). The session is a fake process whose
// events the test pushes, so "during a running turn" is real: the note arrives before any turn_end.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { createLaneRelay } from "./lanerelay.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7400;
	sent: { text: string; mode?: string }[] = [];
	private queue: AgentEvent[] = [];
	private wake?: () => void;
	private closed = false;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events: AsyncIterable<AgentEvent> = {
		[Symbol.asyncIterator]: async function* (this: FakeAgent) {
			for (;;) {
				while (this.queue.length) yield this.queue.shift()!;
				if (this.closed) return;
				await new Promise<void>(r => (this.wake = r));
			}
		}.bind(this),
	};
	push(ev: AgentEvent): void {
		this.queue.push(ev);
		this.wake?.();
	}
	send = (text: string, mode?: string) => void this.sent.push({ text, mode });
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {
		this.closed = true;
		this.wake?.();
		this.exit.resolve(0);
	};
}
const spawns: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		spawns.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
const savedCfg = { lanes: cfg.lanes };
const shown: { lane: string; text: string; refs: string[] }[] = [];
const answered: { lane: string; refs: string[] }[] = [];
const lost: { lane: string; refs: string[] }[] = [];
const reports: { text: string; answering?: boolean }[] = [];
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler((_lane, text, answering) => void reports.push({ text, answering }));
	l.setIdleHandler(() => {});
	l.setOwnerNoteHandlers({
		note: (lane, text, refs) => void shown.push({ lane, text, refs }),
		answered: (lane, refs) => void answered.push({ lane, refs }),
		lost: (lane, refs) => void lost.push({ lane, refs }),
	});
});
afterAll(() => {
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});

beforeEach(() => {
	shown.length = 0;
	answered.length = 0;
	reports.length = 0;
});

async function working(name: string): Promise<{ lane: Lanes.Lane; agent: FakeAgent }> {
	const cwd = join(DATA, "note-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	const agent = spawns.at(-1)!.agent;
	agent.push({ type: "turn_start" });
	await flush();
	expect(lane.status).toBe("working");
	return { lane, agent };
}

test("steered into a running turn: the session's note before its next tool call is shown during the turn, then the message is answered", async () => {
	const { lane, agent } = await working("note-steer");
	expect(l.sendToLane("note-steer", "[owner via web] 언제 끝나요?", "m1")).toBe("steered");
	expect(agent.sent.at(-1)!.mode).toBe("steer");
	expect(agent.sent.at(-1)!.text).toContain(msg().ownerAnswerNudge);
	agent.push({ type: "assistant", text: "10분 안에 테스트 돌리고 알려드릴게요.", stop: "other" });
	await flush();
	expect(shown).toEqual([{ lane: "note-steer", text: "10분 안에 테스트 돌리고 알려드릴게요.", refs: ["m1"] }]);
	expect(answered).toEqual([{ lane: "note-steer", refs: ["m1"] }]);
	expect(lane.status).toBe("working");
	expect(reports).toHaveLength(0);
	l.stopLane("note-steer");
	await advance(300);
});

test("a steer through a real lane spawn ends with the mark its system prompt names; a prompt to an idle lane has none", async () => {
	const { agent } = await working("note-mark");
	const opts = spawns.at(-1)!.opts;
	const mark = /\[dotz-steer:[0-9a-f]+\]/.exec(opts.systemNote ?? "")?.[0];
	expect(mark).toBeDefined();
	expect(agent.sent[0]!.mode).toBe("prompt");
	expect(agent.sent[0]!.text).not.toContain("[dotz-steer:");
	l.sendToLane("note-mark", "[owner via web] 멈춰", "m-mark");
	expect(agent.sent.at(-1)!.mode).toBe("steer");
	expect(agent.sent.at(-1)!.text.endsWith(`\n${mark}`)).toBe(true);
	l.stopLane("note-mark");
	await advance(300);
});

test("a deep owner message steered into a running step still carries its line, read there as a hint; a normal one carries none", async () => {
	const { agent } = await working("note-deep");
	l.sendToLane("note-deep", "[owner via web] 깊게 생각해 줘", "m-deep", false, true);
	expect(agent.sent.at(-1)!.mode).toBe("steer");
	expect(agent.sent.at(-1)!.text).toMatch(/^The owner asked for deeper reasoning on this turn\.|^\[dotz deep turn\] /m);
	l.sendToLane("note-deep", "[owner via web] 고마워", "m-plain");
	expect(agent.sent.at(-1)!.text).not.toContain("deeper reasoning");
	l.stopLane("note-deep");
	await advance(300);
});

test("the final report answers what the note did not, and a [run] final is flagged as an answer to the owner", async () => {
	answered.length = 0;
	shown.length = 0;
	const { agent } = await working("note-final");
	expect(l.sendToLane("note-final", "[owner via Discord] 상태?", "m2")).toBe("steered");
	agent.push({ type: "assistant", text: "[run] 거의 다 됐어요", stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	expect(shown).toEqual([]);
	expect(reports.at(-1)).toEqual({ text: "[run] 거의 다 됐어요", answering: true });
	expect(answered).toEqual([{ lane: "note-final", refs: ["m2"] }]);
	l.stopLane("note-final");
	await advance(300);
});

test("a [wait] final after a mid-turn note is the answer to the owner; the next turn's [wait] with no new owner message stays progress", async () => {
	const { agent } = await working("note-wait");
	expect(l.sendToLane("note-wait", "[owner via Discord] 10메가로 나눠서 보내", "m3")).toBe("steered");
	agent.push({ type: "assistant", text: "나눠서 보낼게요.", stop: "other" });
	await flush();
	expect(shown).toHaveLength(1);
	agent.push({ type: "assistant", text: "[wait] 시험판을 세 통으로 나눠 보냈어요. 받으면 알려 주세요.", stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	expect(reports.at(-1)).toEqual({ text: "[wait] 시험판을 세 통으로 나눠 보냈어요. 받으면 알려 주세요.", answering: true });
	agent.push({ type: "turn_start" });
	agent.push({ type: "assistant", text: "[wait] 회사 PC 시험 결과를 기다려요.", stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	expect(reports.at(-1)).toEqual({ text: "[wait] 회사 PC 시험 결과를 기다려요.", answering: false });
	l.stopLane("note-wait");
	await advance(300);
});

// 2026-11-05 pilot-stage1: owner message -> mid-turn note -> a [run] report ends a turn -> the [wait] result -> a [wait] repeat 2s later.
// The [run] must not consume the note, or the real result stays parked and is replaced by the repeat.
async function reportTurn(agent: FakeAgent, text: string): Promise<boolean | undefined> {
	agent.push({ type: "turn_start" });
	agent.push({ type: "assistant", text, stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	return reports.at(-1)?.text === text ? reports.at(-1)!.answering : undefined;
}

test("owner message -> note -> [run] -> [wait] result -> [wait] repeat: only the [wait] result is the answer", async () => {
	const { agent } = await working("note-run-wait");
	l.sendToLane("note-run-wait", "[owner via Discord] 메일 보내", "m7");
	agent.push({ type: "assistant", text: "보낼게요.", stop: "other" });
	await flush();
	expect(shown).toHaveLength(1);
	expect(await reportTurn(agent, "[run] 메일 세 통을 차례로 보내고 있어요")).toBe(false);
	expect(await reportTurn(agent, "[wait] 시험판을 세 통으로 나눠 보냈어요. 받으면 알려 주세요.")).toBe(true);
	expect(await reportTurn(agent, "[wait] 회사 PC 시험 결과를 기다리고 있어요.")).toBe(false);
	l.stopLane("note-run-wait");
	await advance(300);
});

test("owner message -> [run] -> [wait] result -> [wait] repeat: the [run] answers, the [wait] result still counts, the repeat is progress", async () => {
	const { agent } = await working("note-run-open");
	l.sendToLane("note-run-open", "[owner via Discord] 메일 보내", "m8");
	expect(await reportTurn(agent, "[run] 메일 세 통을 차례로 보내고 있어요")).toBe(true);
	expect(await reportTurn(agent, "[wait] 시험판을 세 통으로 나눠 보냈어요. 받으면 알려 주세요.")).toBe(true);
	expect(await reportTurn(agent, "[wait] 회사 PC 시험 결과를 기다리고 있어요.")).toBe(false);
	l.stopLane("note-run-open");
	await advance(300);
});

test("an idle session receives the message at once; a stopped one is resumed; one with no session refuses and is not waited on", async () => {
	const { lane, agent } = await working("note-idle");
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	expect(lane.status).toBe("idle");
	expect(l.sendToLane("note-idle", "[owner via web] 하나 더", "m3")).toBe("received");
	expect(agent.sent.at(-1)!.mode).toBe("prompt");

	const session = join(DATA, "omo-agent", "sessions", "note-idle.jsonl");
	mkdirSync(join(DATA, "omo-agent", "sessions"), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	l.stopLane("note-idle");
	await advance(300);
	await flush();
	expect(lane.proc).toBeUndefined();
	const before = spawns.length;
	expect(l.sendToLane("note-idle", "[owner via web] 다시", "m4")).toBe("resumed");
	expect(spawns.length).toBe(before + 1);
	expect(spawns.at(-1)!.opts.resume).toBe(session);

	l.stopLane("note-idle");
	await advance(300);
	await flush();
	lane.sessionFile = undefined;
	expect(() => l.sendToLane("note-idle", "[owner via web] 또", "m5")).toThrow(/no session to resume/);
	expect(l.ownerNotes.waiting("note-idle")).toBe(false);
});

test("a session that exits with an owner message open reports it lost", async () => {
	lost.length = 0;
	const { agent } = await working("note-lost");
	l.sendToLane("note-lost", "[owner via web] hi", "m6");
	agent.kill();
	await advance(300);
	await flush();
	expect(lost).toEqual([{ lane: "note-lost", refs: ["m6"] }]);
});

// 2026-11-01: a session waiting hours on a video got a stall nudge every few minutes; each untagged "still waiting" reply to it
// counted as an answer to the orchestrator and woke it. A gateway nudge is not the orchestrator asking.
test("a gateway nudge does not make the session's next untagged reply a report for the orchestrator; an orchestrator message does", async () => {
	const { lane, agent } = await working("note-nudge");
	const sent: string[] = [];
	const relay = createLaneRelay({ busy: () => false, deliver: t => void sent.push(t), lead: n => `[lane reports ${n}]` });
	lane.orchAsked = false;
	l.sendToLane("note-nudge", msg().stallNudge(3, ""), undefined, true);
	expect(agent.sent.at(-1)!.text).toContain(msg().stallNudge(3, ""));
	expect(lane.orchAsked).toBe(false);
	expect(relay.report("note-nudge", "still waiting for the video, nothing to do", "/f", lane.orchAsked === false)).toBe("owner");
	expect(relay.report("note-nudge", "[done] all five courses passed", "/f", lane.orchAsked === false)).toBe("relayed");
	l.sendToLane("note-nudge", "which course is left?");
	expect(lane.orchAsked).toBe(true);
	expect(relay.report("note-nudge", "only the safety course is left", "/f", lane.orchAsked === false)).toBe("relayed");
	expect(sent).toHaveLength(2);
	l.stopLane("note-nudge");
	await advance(300);
});

// 2026-11-05: the session got "[owner via web] 1) 보내기" without the question, while MODE.md tells it to act on "결정 답: ... → 1) 보내기".
test("a button on a session's send approval reaches the session as 결정 답 with the question, 고치기 with the change", async () => {
	const { webAnswer } = await import("./approval-wire.ts");
	const { emit } = await import("./events.ts");
	const { listNotices } = await import("./notices.ts");
	const { deliverAnswer } = await import("./routes.ts");
	const { SHOT_LABELLED } = await import("./owner-text.fixture.ts");
	const { agent } = await working("note-answer");
	const ask = (ts: string) => {
		emit("inbox", { ts, kind: "lane_report", source: "lane:note-answer", lane: "note-answer", text: SHOT_LABELLED });
		return listNotices(100).items.find(n => n.decision?.state === "open" && n.decision.to === "lane:note-answer")!;
	};
	const q = "이 메일을 회사 메일로 보낼까요? (pilot-5d3d419)";
	const tap = async (n: number, label: string, note?: string) => {
		const card = ask(new Date(Date.parse("2050-02-01T00:00:00.000Z") + n * 1000).toISOString());
		expect((await webAnswer(card.id, { n, label, ...(note ? { note } : {}) }, "me", a => deliverAnswer({ ...a, login: "me" }))).status).toBe(200);
		return agent.sent.at(-1)!.text;
	};
	expect(await tap(1, "보내기")).toContain(msg().decisionAnswer([{ q, n: 1, label: "보내기" }]));
	const edit = await tap(2, "고치기", "제목을 줄여 줘");
	expect(edit).toContain(msg().decisionAnswer([{ q, n: 2, label: "고치기" }]));
	expect(edit).toContain("2) 고치기 - 제목을 줄여 줘");
});
