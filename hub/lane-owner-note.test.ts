// An owner message to a session shows its delivery state and is answered at the session's next tool boundary, not only in the
// final report (2026-10-21, owner: "내가 직접 레인에 보내는건 피드백이 안와서 잘 모르겠음"). The session is a fake process whose
// events the test pushes, so "during a running turn" is real: the note arrives before any turn_end.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
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
