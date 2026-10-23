// Bookkeeping of a session must not reach the owner: a recovery restart is no chat message and no orchestrator turn until it gives up,
// a turn that ends with no text of its own does not report the previous answer again, and the "For <bot>:" line stays off the owner's view.
// (mail-reply-drafts 2026-10-23: "[lane recovery] ... Compaction cancelled", and the same answer posted twice 49 ms apart.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	send = () => {};
	abort = () => {};
	compact = () => {};
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

test(`the "For ${NAME}:" and "${NAME} 몫:" lines are dropped from the owner's text, nothing else`, () => {
	expect(dropForLine(`[done] 끝났어요.\n\n${NAME} 몫: 없음`)).toBe("[done] 끝났어요.");
	expect(dropForLine(`[done] 끝났어요.\n근거: 테스트 통과\n- For ${NAME}: 머지 확인\n`)).toBe("[done] 끝났어요.\n근거: 테스트 통과");
	expect(dropForLine("```\n" + `${NAME} 몫: 없음\n` + "```")).toContain(`${NAME} 몫: 없음`);
	expect(dropForLine("그대로 둬요.")).toBe("그대로 둬요.");
	expect(dropForLine(`${NAME} 몫: -`)).toBe(`${NAME} 몫: -`);
});
