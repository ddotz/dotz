// The orchestrator's pause on a usage limit ends the moment the check lifts it (a 리셋권 spent elsewhere), the held prompt goes out,
// and a billing/auth pause is never ended by it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Orchestrator from "./orchestrator.ts";
import { cfg } from "./config.ts";
import { limitAlertsFile } from "./limit-alert.ts";
import { checkUsageLimit, liftEnv, resetLiftMemory, restartChecked } from "./limit-lift.ts";
import { setLimitWatch } from "./limit-watch.ts";
import { adapters } from "./runtime/index.ts";
import { omo } from "./runtime/omo.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
class FakeAgent implements AgentProcess {
	pid = 7300;
	calls: string[] = [];
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
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
		this.calls.push(`send:${mode}:${text.slice(0, 40)}`);
	}
	abort = () => void this.calls.push("abort");
	compact = () => void this.calls.push("compact");
	refreshUsage = () => void this.calls.push("refreshUsage");
	refreshSession = () => void this.calls.push("refreshSession");
	watchSubagents = () => void this.calls.push("watchSubagents");
	kill = () => {
		this.calls.push("kill");
		this.exit.resolve(0);
	};
}
const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(_opts: SpawnOpts) {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omo.classifyError,
	recentExchanges: () => undefined,
};
const AUTH_ERR = "Claude account 'acct-a' for anthropic-subscription is blocked (authentication error), and account fallback is off. authentication_failed";
const RATE_ERR = "429 usage limit reached, resets Nov 16 10am";
const failedTurn = (text: string): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "", stop: "error", error: { text, kind: fake.classifyError(text), compaction: false } }, { type: "turn_end" }];
const savedCfg = { orchestrator: cfg.orchestrator, models: cfg.models };
const sends = () => started.at(-1)!.calls.filter(c => c.startsWith("send:"));


beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: { model: "anthropic/test-orch", thinking: "low", fallback: [] } };
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	writeFileSync(join(DATA, "limit-session.jsonl"), "");
	rmSync(limitAlertsFile(), { force: true });
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	rmSync(limitAlertsFile(), { force: true });
});

const pause = async (text: string, tag: string) => {
	rmSync(limitAlertsFile(), { force: true });
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	const o: typeof Orchestrator = await import(`./orchestrator.ts?lift-${tag}`);
	o.setAlertHandler(() => {});
	o.setAnswerHandlers(() => {}, () => {});
	o.start();
	await advance(4000);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	o.deliver("held on the limit");
	await started.at(-1)!.push(...failedTurn(text));
	await advance(500);
	return o;
};

test("a usage-limit pause ends at once when lifted: the held prompt goes out, the status is back, and a second lift does nothing", async () => {
	const o = await pause(RATE_ERR, "rate");
	expect(o.orch.status).toBe("rate-limited");
	expect(o.main.limitPaused()).toBe(true);
	const before = sends().length;
	expect(o.main.liftLimit()).toBe(true);
	await advance(10);
	expect(o.orch.status).not.toBe("rate-limited");
	expect(o.main.limitPaused()).toBe(false);
	expect(sends().length).toBeGreaterThan(before);
	expect(o.main.liftLimit()).toBe(false);
	o.stop();
	await advance(300);
}, 30_000);

test("a billing/auth pause is not a usage limit: lifting leaves it paused", async () => {
	const o = await pause(AUTH_ERR, "auth");
	expect(o.orch.status).toBe("rate-limited");
	expect(o.orch.pauseKind).toBe("owner");
	expect(o.main.limitPaused()).toBe(false);
	expect(o.main.liftLimit()).toBe(false);
	expect(o.orch.status).toBe("rate-limited");
	o.stop();
	await advance(300);
}, 30_000);

test("the restart button on a usage-limit pause that the check lifts comes back running: not paused, the held prompt goes in; a plain restart would stay paused", async () => {
	const o = await pause(RATE_ERR, "restart");
	expect(o.orch.status).toBe("rate-limited");
	o.deliver("sent while paused");
	const real = { ...liftEnv };
	resetLiftMemory();
	Object.assign(liftEnv, { usage: async () => ({ account: "acct-a", omo: true, usable: true, spentScopes: [] }), unblock: async () => "unblocked", sessions: () => [o.main], lanes: { paused: () => 0, models: () => [], lift: () => 0 }, refresh: () => {} });
	const before = started.length;
	await restartChecked(() => o.restart("test restart"), () => o.resumeNow("test restart"));
	await advance(4000);
	expect(started.length).toBe(before + 1);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	await advance(500);
	expect(o.orch.status).not.toBe("rate-limited");
	expect(sends().some(c => c.includes("sent while paused"))).toBe(true);
	Object.assign(liftEnv, real);
	o.stop();
	await advance(300);
}, 30_000);

const okTurn: AgentEvent[] = [{ type: "turn_start" }, { type: "assistant", text: "done", stop: "stop" }, { type: "turn_end" }];
const savedPause = () => (JSON.parse(readFileSync(join(DATA, "orchestrator.json"), "utf8")) as { pausedUntil?: string }).pausedUntil;

test("a turn that answers on a limit pause (the runtime retried by itself) ends the pause everywhere: no saved record, not limit-paused, and a restart does not hold messages again", async () => {
	const o = await pause(RATE_ERR, "stale");
	expect(o.orch.status).toBe("rate-limited");
	expect(savedPause()).toBeDefined();
	await started.at(-1)!.push(...okTurn);
	await advance(10);
	expect(o.orch.status).toBe("idle");
	expect(o.orch.rateLimitedUntil).toBe("");
	expect(o.main.limitPaused()).toBe(false);
	expect(o.main.liftLimit()).toBe(false);
	expect(savedPause()).toBeUndefined();
	const before = started.length;
	o.restart("test restart");
	await advance(4000);
	expect(started.length).toBe(before + 1);
	expect(o.orch.status).not.toBe("rate-limited");
	o.deliver("after the restart");
	expect(sends().some(c => c.includes("after the restart"))).toBe(true);
	o.stop();
	await advance(300);
}, 30_000);

// A gateway start with a saved usage-limit pause asks the usage report once at once (not after LIMIT_WATCH_MS); the report decides.
const restored = async (tag: string, report: Awaited<ReturnType<typeof liftEnv.usage>>) => {
	rmSync(limitAlertsFile(), { force: true });
	writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ pausedUntil: new Date(Date.now() + 3_600_000).toISOString() }));
	const o: typeof Orchestrator = await import(`./orchestrator.ts?lift-${tag}`);
	o.setAlertHandler(() => {});
	o.setAnswerHandlers(() => {}, () => {});
	const real = { ...liftEnv };
	let asked = 0;
	resetLiftMemory();
	Object.assign(liftEnv, { usage: async () => (asked++, report), unblock: async () => "unblocked", sessions: () => [o.main], lanes: { paused: () => 0, models: () => [], lift: () => 0 }, refresh: () => {} });
	// the same hooks limit-lift.ts sets at its import; another test file in the run may have cleared them
	setLimitWatch({ paused: () => liftEnv.sessions().filter(x => x.limitPaused()).length, tick: async () => void (await checkUsageLimit()) });
	o.start();
	o.deliver("held across the restart");
	await advance(10);
	return { o, asked: () => asked, done: () => (Object.assign(liftEnv, real), setLimitWatch(undefined)) };
};

test("a start with a saved usage-limit pause and a usable usage report asks at once, goes on, and the held prompt goes in", async () => {
	const { o, asked, done } = await restored("restore-usable", { account: "acct-a", omo: true, usable: true, spentScopes: [] });
	expect(asked()).toBe(1);
	expect(o.orch.status).not.toBe("rate-limited");
	expect(o.main.limitPaused()).toBe(false);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") }, ...okTurn);
	await advance(10);
	expect(sends().some(c => c.includes("held across the restart"))).toBe(true);
	done();
	o.stop();
	await advance(300);
}, 30_000);

test("a start with a saved usage-limit pause and an unreadable usage report asks once and stays paused", async () => {
	const { o, asked, done } = await restored("restore-unreadable", undefined);
	expect(asked()).toBe(1);
	expect(o.orch.status).toBe("rate-limited");
	expect(o.main.limitPaused()).toBe(true);
	expect(sends().some(c => c.includes("held across the restart"))).toBe(false);
	done();
	o.stop();
	await advance(300);
}, 30_000);
