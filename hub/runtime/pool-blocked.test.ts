// OmO's "All Claude accounts ... currently blocked" error (2026-10-20, orchestrator session 01a15495: 13 such turns and three
// near-identical 429 alerts for one reset): a usage limit whose reset is the time OmO names. The orchestrator pauses until
// then, says so once, and a gateway restart inside the pause holds messages instead of replaying them into the limit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Orchestrator from "../orchestrator.ts";
import { cfg } from "../config.ts";
import { poolRetryAt, resumeDelay } from "../providers.ts";
import { limitAlertsFile } from "../limit-alert.ts";
import { adapters } from "./index.ts";
import { omo } from "./omo.ts";
import { advance, clock, flush } from "./test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./types.ts";

const DATA = process.env.DOTZ_DIR!;
const blocked = (retryAt: number) =>
	`All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: ${new Date(retryAt).toISOString()}.\n  /claude-account list  - inspect account states\n`;

class FakeAgent implements AgentProcess {
	pid = 7200;
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
		this.calls.push(`send:${mode}:${text.slice(0, 60)}`);
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

const started: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		started.push({ opts, agent });
		return agent;
	},
	classifyError: omo.classifyError,
	recentExchanges: () => undefined,
};
const failedTurn = (text: string): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "", stop: "error", error: { text, kind: fake.classifyError(text), compaction: false } }, { type: "turn_end" }];
const savedCfg = { orchestrator: cfg.orchestrator, models: cfg.models };
const alerts: string[] = [];

beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: { model: "anthropic/test-orch", thinking: "low", fallback: [] } };
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	writeFileSync(join(DATA, "pool-session.jsonl"), "");
	rmSync(limitAlertsFile(), { force: true });
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	rmSync(limitAlertsFile(), { force: true });
});

test("the blocked-pool message is a rate limit whose reset is OmO's soonest retry", () => {
	const retryAt = Date.parse("2026-10-20T14:00:00.000Z");
	const msg = blocked(retryAt);
	expect(omo.classifyError(msg)).toBe("rate");
	expect(omo.classifyError("No credential slots available")).toBe("rate");
	expect(poolRetryAt(msg)).toBe(retryAt);
	// a usage report naming a later window does not override the time OmO names
	const later = { resets_at: retryAt + 5 * 3600_000, remaining: 0, used: 100, limit: 100, status: "exhausted" } as never;
	expect(resumeDelay(msg, [later], retryAt - 47 * 60_000)).toEqual({ ms: 47 * 60_000 + 60_000, reset: true });
});

test("orchestrator: pauses until the named retry with one alert; a gateway restart inside the pause holds and stays quiet", async () => {
	const o: typeof Orchestrator = await import("../orchestrator.ts?pool-blocked");
	o.setAlertHandler(t => alerts.push(t));
	o.setAnswerHandlers(() => {}, () => {});
	o.start();
	await advance(4000);
	await started.at(-1)!.agent.push({ type: "session", ref: join(DATA, "pool-session.jsonl") });
	expect(o.orch.status).toBe("idle");

	const retryAt = clock.now + 47 * 60_000;
	o.deliver("hello");
	await started.at(-1)!.agent.push(...failedTurn(blocked(retryAt)));
	await advance(500);
	expect(o.orch.status).toBe("rate-limited");
	expect(o.orch.pauseKind).toBe("rate");
	expect(Date.parse(o.orch.rateLimitedUntil)).toBe(retryAt + 60_000);
	expect(alerts).toHaveLength(1);

	// the gateway restarts 10 minutes later: a fresh module copy is a fresh process
	o.stop();
	await advance(300);
	await advance(10 * 60_000);
	const again: typeof Orchestrator = await import("../orchestrator.ts?pool-blocked-restart");
	again.setAlertHandler(t => alerts.push(t));
	again.setAnswerHandlers(() => {}, () => {});
	again.start();
	expect(again.orch.status).toBe("rate-limited");
	expect(Date.parse(again.orch.rateLimitedUntil)).toBe(retryAt + 60_000);
	again.deliver("replayed from before the restart");
	await advance(4000);
	await started.at(-1)!.agent.push({ type: "session", ref: join(DATA, "pool-session.jsonl") });
	expect(again.orch.status).toBe("rate-limited");
	expect(started.at(-1)!.agent.calls.filter(c => c.startsWith("send:"))).toEqual([]);

	// the pause ends right after the named time: one probe; it hits the same block again and stays quiet
	await advance(retryAt + 60_000 - clock.now + 10);
	const probe = started.at(-1)!.agent;
	expect(probe.calls.filter(c => c.startsWith("send:followUp:"))).toHaveLength(1);
	const nextRetry = clock.now + 2 * 3600_000;
	await probe.push(...failedTurn(blocked(nextRetry)));
	await advance(500);
	expect(again.orch.status).toBe("rate-limited");
	expect(Date.parse(again.orch.rateLimitedUntil)).toBe(nextRetry + 60_000);
	expect(alerts).toHaveLength(1);
	again.stop();
	await advance(300);
}, 30_000);
