// A lift that arrives while a session or lane is still entering its usage-limit hold (the usage read or the alert text is still awaited) ends
// that hold: nothing is saved, told or armed for it afterwards, the held work goes in, and the lift counts the session. A billing/auth hold is not lifted.
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as accounts from "./accounts-api.ts";
import { cfg } from "./config.ts";
import { handleError } from "./lanefailover.ts";
import { liftLanePauses, limitPausedLanes, sendToLane } from "./laneops.ts";
import type * as Lanes from "./lanes.ts";
import { limitAlertsFile } from "./limit-alert.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { adapters } from "./runtime/index.ts";
import { omo } from "./runtime/omo.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7600;
	sent: string[] = [];
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	private closed = false;
	readonly exited = this.exit.promise;
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			if (this.closed) return;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	async push(...events: AgentEvent[]): Promise<void> {
		this.queue.push(...events);
		this.wake.resolve();
		await flush();
	}
	send(text: string, mode: SendMode): void {
		this.sent.push(`${mode}:${text.slice(0, 600)}`);
	}
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {
		this.closed = true;
		this.wake.resolve();
		this.exit.resolve(137);
	};
}
const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(_opts: SpawnOpts) {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omo.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};

// The usage read is `omp usage --json`: held here until the test lets it exit, every other command runs as usual.
const realSpawn = Bun.spawn;
let usageRead = Promise.withResolvers<number>();
const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: unknown, ...rest: unknown[]) =>
	Array.isArray(argv) && argv.includes("usage")
		? { pid: 2_147_000_000, stdout: new Response("").body, stderr: new Response("").body, exited: usageRead.promise, kill() {} }
		: (realSpawn as (...a: unknown[]) => unknown)(argv, ...rest)) as unknown as typeof Bun.spawn);
const holdUsage = () => (usageRead = Promise.withResolvers<number>());
let alertText = Promise.withResolvers<string | undefined>();
const alertSpy = spyOn(accounts, "pinnedLimitNotice");
const holdAlertText = () => {
	alertText = Promise.withResolvers<string | undefined>();
	alertSpy.mockImplementation(() => alertText.promise);
};

const RATE_ERR = "429 usage limit reached, resets Nov 16 10am";
const AUTH_ERR = "Claude account 'acct-a' for anthropic-subscription is blocked (authentication error), and account fallback is off. authentication_failed";
const failedTurn = (text: string): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "", stop: "error", error: { text, kind: fake.classifyError(text), compaction: false } }, { type: "turn_end" }];
const okTurn: AgentEvent[] = [{ type: "turn_start" }, { type: "assistant", text: "done", stop: "stop" }, { type: "turn_end" }];
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes, models: cfg.models };
const stateFile = join(DATA, "orchestrator.json");
const savedPause = () => (JSON.parse(readFileSync(stateFile, "utf8")) as { pausedUntil?: string }).pausedUntil;
const resumeNotes = () => started.flatMap(a => a.sent).filter(c => c.includes("The rate limit has passed"));
const reports: string[] = [];
const alerts: string[] = [];

beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { runtime: "fake" };
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: { model: "anthropic/test-orch", thinking: "low", fallback: [] } };
	writeFileSync(join(DATA, "limit-session.jsonl"), "");
	l.setReportHandler((_lane, text) => void reports.push(text));
	l.setNoticeHandler(() => {});
	l.setIdleHandler(() => {});
});
afterEach(() => {
	alertSpy.mockReset();
	holdUsage().resolve(0);
	reports.length = 0;
	alerts.length = 0;
});
afterAll(() => {
	spawnSpy.mockRestore();
	alertSpy.mockRestore();
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	writeFileSync(stateFile, "{}");
	rmSync(limitAlertsFile(), { force: true });
});

// The session takes a limit error; the caller has set what stays pending (usageRead, alertText) before.
const enter = async (tag: string, error: string) => {
	rmSync(limitAlertsFile(), { force: true });
	writeFileSync(stateFile, "{}");
	const o: typeof Orchestrator = await import(`./orchestrator.ts?window-${tag}`);
	o.setAlertHandler(text => void alerts.push(text));
	o.setAnswerHandlers(() => {}, () => {});
	o.start();
	await advance(4000);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	await started.at(-1)!.push(...failedTurn(error));
	await advance(500);
	return o;
};
// After the hold was lifted: nothing is saved or armed, no alert went out, and the message held meanwhile goes in with the next good turn.
const expectLiftedHold = async (o: typeof Orchestrator) => {
	await advance(10);
	expect(savedPause()).toBeUndefined();
	expect(o.orch.status).not.toBe("rate-limited");
	expect(o.main.limitPaused()).toBe(false);
	expect(alerts).toEqual([]);
	const notes = resumeNotes().length;
	await advance(3 * 3_600_000);
	expect(resumeNotes().length).toBe(notes);
	await started.at(-1)!.push(...okTurn);
	await advance(10);
	expect(started.some(a => a.sent.some(c => c.includes("held in the window")))).toBe(true);
	o.stop();
	await advance(300);
};

test("a lift while the usage read is pending ends the hold: counted, nothing saved or armed, no alert, the held message goes in", async () => {
	const read = holdUsage();
	const o = await enter("read", RATE_ERR);
	expect(o.orch.status).toBe("rate-limited");
	expect(o.main.limitPaused()).toBe(true);
	o.deliver("held in the window");
	expect(o.main.liftLimit()).toBe(true);
	read.resolve(0);
	await flush();
	await expectLiftedHold(o);
}, 30_000);

test("a lift while the alert text is pending ends the hold: counted, the saved pause goes, nothing armed, no alert", async () => {
	holdUsage().resolve(0);
	holdAlertText();
	const o = await enter("alert", RATE_ERR);
	expect(savedPause()).toBeDefined();
	o.deliver("held in the window");
	expect(o.main.liftLimit()).toBe(true);
	alertText.resolve(undefined);
	await flush();
	await expectLiftedHold(o);
}, 30_000);

test("a billing/auth hold is not lifted by a usage lift", async () => {
	const o = await enter("owner", AUTH_ERR);
	expect(o.orch.pauseKind).toBe("owner");
	expect(o.main.liftLimit()).toBe(false);
	expect(o.orch.status).toBe("rate-limited");
	expect(savedPause()).toBeDefined();
	o.stop();
	await advance(300);
}, 30_000);

async function working(name: string): Promise<Lanes.Lane> {
	const cwd = join(DATA, "window-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	lane.sessionFile = join(DATA, "limit-session.jsonl");
	await started.at(-1)!.push({ type: "turn_start" });
	return lane;
}
const laneLimit = async (name: string, error: string) => {
	const lane = await working(name);
	handleError(lane, { text: error, kind: fake.classifyError(error), compaction: false });
	await flush();
	return lane;
};
const expectLiftedLane = async (lane: Lanes.Lane, spawned: number) => {
	await advance(300);
	expect(lane.resumeTimer).toBeUndefined();
	expect(lane.status).not.toBe("rate-limited");
	expect(limitPausedLanes()).toEqual([]);
	expect(reports).toEqual([]);
	expect(started.length).toBe(spawned + 1);
	expect(started.at(-1)!.sent.some(c => c.includes("held lane message"))).toBe(true);
	await advance(3 * 3_600_000);
	expect(lane.resumeTimer).toBeUndefined();
	l.stopLane(lane.name);
	await advance(300);
};

test("a lane lifted in its pausing stretch resumes: counted, no timer, no pause report, the held message goes in", async () => {
	const read = holdUsage();
	const lane = await laneLimit("window-read", RATE_ERR);
	expect(lane.status).toBe("rate-limited");
	expect(lane.pausing).toBe(true);
	sendToLane(lane.name, "held lane message");
	const spawned = started.length;
	expect(liftLanePauses()).toBe(1);
	read.resolve(0);
	await flush();
	await expectLiftedLane(lane, spawned);
}, 30_000);

test("a lane lifted while the pause alert text is pending resumes the same way", async () => {
	holdUsage().resolve(0);
	holdAlertText();
	const lane = await laneLimit("window-alert", RATE_ERR);
	await advance(10);
	sendToLane(lane.name, "held lane message");
	const spawned = started.length;
	expect(liftLanePauses()).toBe(1);
	alertText.resolve(undefined);
	await flush();
	await expectLiftedLane(lane, spawned);
}, 30_000);

test("a billing/auth lane hold is not lifted by a usage lift", async () => {
	const lane = await laneLimit("window-owner", AUTH_ERR);
	expect(lane.status).toBe("rate-limited");
	expect(liftLanePauses()).toBe(0);
	expect(lane.resumeTimer).toBeDefined();
	l.stopLane(lane.name);
	await advance(300);
}, 30_000);
