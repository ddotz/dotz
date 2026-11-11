// Bookkeeping of a session must not reach the owner: a recovery restart is no chat message and no orchestrator turn until it gives up,
// a turn that ends with no text of its own does not report the previous answer again, and the "For <bot>:" line stays off the owner's view.
// (mail-reply-drafts 2026-10-23: "[lane recovery] ... Compaction cancelled", and the same answer posted twice 49 ms apart.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumeUnfinished } from "./laneresume.ts";
import type * as Lanes from "./lanes.ts";
import { cfg, NAME } from "./config.ts";
import { dropForLine } from "./forline.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7500;
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
	sent: string[] = [];
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compacts = 0;
	compact = () => void this.compacts++;
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {
		this.closed = true;
		this.wake?.();
		this.exit.resolve(137);
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
const reports: string[] = [];
const notices: string[] = [];
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler((_lane, text) => void reports.push(text));
	l.setNoticeHandler((_lane, text) => void notices.push(text));
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});

async function working(name: string): Promise<{ lane: Lanes.Lane; agent: FakeAgent }> {
	const cwd = join(DATA, "recovery-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	const agent = spawns.at(-1)!.agent;
	agent.push({ type: "turn_start" });
	await flush();
	return { lane, agent };
}

test("a failed compaction restarts the session without a chat message or an orchestrator report; only giving up is reported", async () => {
	reports.length = 0;
	const { lane } = await working("recover-quiet");
	const session = join(DATA, "recover-quiet.jsonl");
	writeFileSync(session, "");
	lane.sessionFile = session;
	for (let n = 1; n <= 3; n++) {
		const before = spawns.length;
		spawns.at(-1)!.agent.push({ type: "compaction", state: "error", error: "Compaction cancelled" });
		await flush();
		await advance(300);
		await flush();
		expect(spawns.length).toBe(before + 1);
		expect(spawns.at(-1)!.opts.resume).toBe(session);
		expect(lane.status).toBe("idle");
		expect(reports).toEqual([]);
		expect(notices).toEqual([]);
	}
	spawns.at(-1)!.agent.push({ type: "compaction", state: "error", error: "Compaction cancelled" });
	await flush();
	expect(reports).toHaveLength(1);
	expect(reports[0]).toStartWith("[lane stuck]");
	expect(reports[0]).not.toContain("Compaction cancelled");
	l.stopLane("recover-quiet");
	await advance(300);
});

test("a compaction the engine refused because the session changed is asked again once, without restarting the lane", async () => {
	const { lane, agent } = await working("recover-retry");
	const session = join(DATA, "recover-retry.jsonl");
	writeFileSync(session, "");
	lane.sessionFile = session;
	agent.push({ type: "turn_end" });
	await flush();
	expect(lane.status).toBe("idle");
	const refused = { type: "compaction", state: "error", error: "Compaction rejected: session changed, retry compaction", requested: true } as const;
	const before = spawns.length;
	lane.ctx.compaction = { state: "compacting", at: "t" };
	agent.push(refused);
	await flush();
	expect(spawns.length).toBe(before);
	expect(agent.compacts).toBe(1);
	expect(lane.ctx.compaction.state).toBe("compacting");
	agent.push(refused);
	await flush();
	await advance(300);
	await flush();
	expect(agent.compacts).toBe(1);
	expect(spawns.length).toBe(before + 1);
	l.stopLane("recover-retry");
	await advance(300);
});

test("a turn that ends with no text of its own does not report the previous answer again", async () => {
	reports.length = 0;
	const { agent } = await working("recover-once");
	agent.push({ type: "assistant", text: "[done] 감시를 껐어요.", stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	expect(reports).toEqual(["[done] 감시를 껐어요."]);
	agent.push({ type: "turn_start" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	expect(reports).toHaveLength(1);
	agent.push({ type: "turn_start" });
	agent.push({ type: "assistant", text: "[done] 감시를 껐어요.", stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(1000);
	await flush();
	expect(reports).toHaveLength(2);
	l.stopLane("recover-once");
	await advance(300);
});

test("the same report twice before a new turn starts goes out once; after a turn_start it goes out again", async () => {
	reports.length = 0;
	const { lane, agent } = await working("report-twice");
	const { report } = await import("./lanereport.ts");
	const err = "[lane error] Provider stream start timed out";
	report(lane, err, true);
	report(lane, err, true);
	expect(reports).toEqual([err]);
	report(lane, "[lane error] another failure", true);
	expect(reports).toHaveLength(2);
	agent.push({ type: "turn_start" });
	await flush();
	report(lane, err, true);
	expect(reports).toEqual([err, "[lane error] another failure", err]);
	l.stopLane("report-twice");
	await advance(300);
});

test("a message a busy session refused (its own turn or compaction still ran) is sent again, not lost; refused every time, the orchestrator gets it", async () => {
	reports.length = 0;
	const { REFUSED_RETRY_MS } = await import("./laneevents.ts");
	const { lane, agent } = await working("busy-send");
	agent.push({ type: "turn_end" });
	await flush();
	const err = "Concurrent Anthropic Subscription turn admission for session 01a1a5f3";
	const refused = async () => {
		agent.push({ type: "turn_start" });
		agent.push({ type: "assistant", text: "", stop: "error", error: { text: err, kind: omp.classifyError(err), compaction: false } });
		agent.push({ type: "turn_end" });
		await flush();
	};
	l.sendToLane("busy-send", "양식 시트를 다시 맞춰요");
	await refused();
	const before = agent.sent.length;
	await advance(REFUSED_RETRY_MS);
	await flush();
	expect(agent.sent.length).toBe(before + 1);
	expect(agent.sent.at(-1)).toContain("양식 시트를 다시 맞춰요");
	expect(lane.lastText).not.toContain("[lane error]");
	expect(reports).toEqual([]);
	for (let n = 0; n < 3; n++) {
		await refused();
		await advance(REFUSED_RETRY_MS);
		await flush();
	}
	expect(reports).toHaveLength(1);
	expect(reports[0]).toStartWith("[fail]");
	expect(reports[0]).toContain("양식 시트를 다시 맞춰요");
	l.stopLane("busy-send");
	await advance(300);
});

const refusedErr = "Concurrent Anthropic Subscription turn admission for session 01a1a5f3";
async function refuse(agent: FakeAgent): Promise<void> {
	agent.push({ type: "turn_start" });
	agent.push({ type: "assistant", text: "", stop: "error", error: { text: refusedErr, kind: omp.classifyError(refusedErr), compaction: false } });
	agent.push({ type: "turn_end" });
	await flush();
}

test("a refused message the session answered by itself before the retry is not sent a second time", async () => {
	reports.length = 0;
	const { REFUSED_RETRY_MS } = await import("./laneevents.ts");
	const { agent } = await working("busy-answered");
	agent.push({ type: "turn_end" });
	await flush();
	l.sendToLane("busy-answered", "한 번만 할 일");
	await refuse(agent);
	const before = agent.sent.length;
	agent.push({ type: "turn_start" });
	await flush();
	await advance(REFUSED_RETRY_MS);
	await flush();
	expect(agent.sent.length).toBe(before); // a running turn waits for its own end
	agent.push({ type: "assistant", text: "했어요", stop: "stop" });
	agent.push({ type: "turn_end" });
	await flush();
	await advance(REFUSED_RETRY_MS * 2);
	await flush();
	expect(agent.sent.length).toBe(before);
	l.stopLane("busy-answered");
	await advance(300);
});

test("a second message refused while the first waits goes with it, and a restart before the retry still sends them", async () => {
	reports.length = 0;
	const { lane, agent } = await working("busy-restart");
	const session = join(DATA, "busy-restart.jsonl");
	writeFileSync(session, "");
	lane.sessionFile = session;
	agent.push({ type: "turn_end" });
	await flush();
	l.sendToLane("busy-restart", "첫 메시지");
	await refuse(agent);
	l.sendToLane("busy-restart", "둘째 메시지");
	await refuse(agent);
	expect(lane.refused?.text).toBe("첫 메시지\n\n둘째 메시지");
	const before = spawns.length;
	l.shutdownLanes();
	await advance((await import("./laneevents.ts")).REFUSED_RETRY_MS);
	await flush();
	l.lanes.delete("busy-restart");
	l.restoreLanes();
	await resumeUnfinished();
	const back = spawns.slice(before).at(-1)!.agent;
	expect(back.sent.at(-1)).toContain("첫 메시지\n\n둘째 메시지");
	expect(reports).toEqual([]);
	l.stopLane("busy-restart");
	await advance(300);
});

// OmO ends a turn with these when the Claude stream restarts a message mid-turn (qa-golden, 2026-11-09 under heavy load):
// the session itself is fine, so the lane picks the work up again instead of stopping on a lane error.
test("a turn OmO ended on a broken stream event order is continued, not reported as a lane error", async () => {
	const { transientBackoff } = await import("./providers.ts");
	const { msg } = await import("./i18n.ts");
	for (const err of ["Invalid native tool call event order", "Invalid assistant content event order"]) {
		reports.length = 0;
		const { lane, agent } = await working("event-order");
		agent.push({ type: "assistant", text: "", stop: "error", error: { text: err, kind: fake.classifyError(err), compaction: false } });
		agent.push({ type: "turn_end" });
		await flush();
		await advance(transientBackoff(0));
		await flush();
		expect(agent.sent.at(-1)).toStartWith(msg().laneTransient);
		expect(lane.lastText).not.toContain("[lane error]");
		expect(reports).toEqual([]);
		l.stopLane("event-order");
		await advance(300);
	}
});

test(`the "For ${NAME}:" and "${NAME} 몫:" lines are dropped from the owner's text, nothing else`, () => {
	expect(dropForLine(`[done] 끝났어요.\n\n${NAME} 몫: 없음`)).toBe("[done] 끝났어요.");
	expect(dropForLine(`[done] 끝났어요.\n근거: 테스트 통과\n- For ${NAME}: 머지 확인\n`)).toBe("[done] 끝났어요.\n근거: 테스트 통과");
	expect(dropForLine("```\n" + `${NAME} 몫: 없음\n` + "```")).toContain(`${NAME} 몫: 없음`);
	expect(dropForLine("그대로 둬요.")).toBe("그대로 둬요.");
	expect(dropForLine(`${NAME} 몫: -`)).toBe(`${NAME} 몫: -`);
});
