// Blocked-provider alerts: one per episode (one kind, shared by every agent), kept on disk, one recovery line, a slow silent retry.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Orchestrator from "./orchestrator.ts";
import { cfg } from "./config.ts";
import { authFile } from "./apikey-policy.ts";
import { AUTH_WATCH_MS, blockText, limitAccount, limitAlertsFile, limitKind, markTold, noteBlock, noteRecovered, ownerRetryMs } from "./limit-alert.ts";
import { adapters } from "./runtime/index.ts";
import { omo } from "./runtime/omo.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const T0 = Date.parse("2026-10-23T14:55:00.000Z");
const MIN = 60_000;

// Agent ids of their own: the later orchestrator tests of this file note blocks under "orchestrator"; the file is removed at the end.
test("an episode alerts once for every agent and account name, survives a restart, never repeats while blocked, ends with one recovery; a new cause inside the same stoppage stays quiet", async () => {
	const A = "episode-agent";
	expect(noteBlock(A, "imported-anthropic", "auth", T0)).toEqual({ alert: true, failures: 1, since: T0 });
	expect(noteBlock(A, "imported-anthropic", "auth", T0 + 5 * MIN)).toEqual({ alert: false, failures: 2, since: T0 });
	expect(noteBlock(A, "anthropic", "auth", T0 + 10 * MIN)).toEqual({ alert: false, failures: 3, since: T0 });   // the same login, named differently by another error
	expect(noteBlock("lane:episode", "imported-anthropic", "auth", T0 + 10 * MIN).alert).toBe(false);   // a session blocked by the same cause stays quiet

	const fresh: typeof import("./limit-alert.ts") = await import("./limit-alert.ts?restart");
	expect(fresh.noteBlock(A, "imported-anthropic", "auth", T0 + 20 * MIN).alert).toBe(false);
	for (const h of [12, 24, 36]) expect(noteBlock(A, "imported-anthropic", "auth", T0 + h * 3600_000).alert).toBe(false);   // no reminder every 12 hours

	expect(noteBlock(A, "imported-anthropic", "billing", T0 + 37 * 3600_000).alert).toBe(false);   // still the same stoppage: told once until it recovers
	expect(noteBlock(A, "other-account", "billing", T0 + 37 * 3600_000 + MIN).alert).toBe(false);

	expect(noteRecovered(A)?.kind).toBe("billing");
	expect(noteRecovered(A)).toBeUndefined();
	expect(noteRecovered("lane:episode")?.kind).toBe("auth");   // its own episode, told once when it clears
	expect(noteBlock(A, "other-account", "billing", T0 + 40 * 3600_000).alert).toBe(true);   // after a recovery a new block is news again
	expect(noteRecovered(A)?.kind).toBe("billing");
	rmSync(limitAlertsFile(), { force: true });
});

test("a recovery ends the episode for every agent blocked the same way", () => {
	expect(noteBlock("share-a", "acct", "limit", T0).alert).toBe(true);
	expect(noteBlock("share-b", "acct", "limit", T0 + MIN).alert).toBe(false);
	expect(noteRecovered("share-a")?.kind).toBe("limit");
	expect(noteRecovered("share-b")).toBeUndefined();   // already over: no second recovery line
	rmSync(limitAlertsFile(), { force: true });
});

test("a held alert never sent gets no recovery line; it is offered again until sent, and once sent its end is told", () => {
	expect(noteBlock("held", "", "error", T0, true)).toEqual({ alert: true, failures: 1, since: T0 });
	expect(noteRecovered("held")).toBeUndefined();

	expect(noteBlock("held", "", "error", T0, true).alert).toBe(true);
	expect(noteBlock("held", "", "error", T0 + 5 * MIN, true)).toEqual({ alert: true, failures: 2, since: T0 });   // a gateway restart lost the timer
	markTold("held", T0 + 20 * MIN);
	expect(noteBlock("held", "", "error", T0 + 25 * MIN, true).alert).toBe(false);
	expect(noteRecovered("held")?.kind).toBe("error");
	rmSync(limitAlertsFile(), { force: true });
});

test("kinds, accounts, owner text and the slow backoff", () => {
	const raw = "Claude account 'imported-anthropic' for anthropic-subscription is blocked (authentication error), and account fallback is off";
	expect(limitKind(raw, "owner")).toBe("auth");
	expect(limitKind("Your credit balance is too low", "owner")).toBe("billing");
	expect(limitKind("429 usage limit", "rate")).toBe("limit");
	expect(limitAccount(raw, "anthropic/x")).toBe("imported-anthropic");
	expect(limitAccount("401", "openai/x")).toBe("openai");
	const text = blockText("auth", "imported-anthropic", "anthropic", 30 * MIN);
	expect(text).toContain("imported-anthropic");
	expect(text).toContain("/login anthropic");
	expect(text).not.toMatch(/authentication|fallback is off/);
	expect([1, 2, 3, 4, 5, 9].map(ownerRetryMs)).toEqual([30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 360 * MIN, 360 * MIN]);
	expect(omo.classifyError("authentication_failed")).toBe("owner");
});

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
const AUTH_ERR = "Claude account 'imported-anthropic' for anthropic-subscription is blocked (authentication error), and account fallback is off. authentication_failed";
const failedTurn = (text: string): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "", stop: "error", error: { text, kind: fake.classifyError(text), compaction: false } }, { type: "turn_end" }];
const okTurn: AgentEvent[] = [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text: "ok", stop: "stop" }, { type: "turn_end" }];
const savedCfg = { orchestrator: cfg.orchestrator, models: cfg.models };
const alerts: string[] = [];
const probes = () => started.at(-1)!.calls.filter(c => c.startsWith("send:followUp:") && !c.includes("hello"));
const sends = () => started.at(-1)!.calls.filter(c => c.startsWith("send:"));

beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: { model: "anthropic/test-orch", thinking: "low", fallback: [] } };
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	writeFileSync(join(DATA, "limit-session.jsonl"), "");
	rmSync(limitAlertsFile(), { force: true });
	rmSync(authFile(), { force: true });
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	rmSync(limitAlertsFile(), { force: true });
	rmSync(authFile(), { force: true });
});

test("orchestrator: an auth block alerts once in plain Korean, retries slowly and silently, survives a restart, and says when it clears", async () => {
	rmSync(limitAlertsFile(), { force: true });
	const o: typeof Orchestrator = await import("./orchestrator.ts?limit-alert");
	o.setAlertHandler(t => alerts.push(t));
	o.setAnswerHandlers(() => {}, () => {});
	o.start();
	await advance(4000);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	o.deliver("hello");
	await started.at(-1)!.push(...failedTurn(AUTH_ERR));
	await advance(500);
	expect(o.orch.status).toBe("rate-limited");
	expect(o.orch.pauseKind).toBe("owner");
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toContain("imported-anthropic");
	expect(alerts[0]).toContain("/login anthropic");
	expect(alerts[0]).not.toMatch(/authentication|fallback is off/);

	// the first probe (30 min) fails again: no new alert, and the next probe waits twice as long
	await advance(30 * MIN + 10);
	expect(probes()).toHaveLength(1);
	await started.at(-1)!.push(...failedTurn(AUTH_ERR));
	await advance(500);
	expect(alerts).toHaveLength(1);
	expect(Date.parse(o.orch.rateLimitedUntil) - clock.now).toBeGreaterThan(59 * MIN);

	// a gateway restart inside the episode: held prompts stay held, nothing is posted
	o.stop();
	await advance(300);
	const again: typeof Orchestrator = await import("./orchestrator.ts?limit-alert-restart");
	again.setAlertHandler(t => alerts.push(t));
	again.setAnswerHandlers(() => {}, () => {});
	again.start();
	expect(again.orch.status).toBe("rate-limited");
	expect(again.orch.pauseKind).toBe("owner");
	again.deliver("replayed after the restart");
	await advance(4000);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	expect(sends()).toEqual([]);
	expect(alerts).toHaveLength(1);

	// a changed login retries at once, still silently, in a fresh process (the old one keeps the login and pin it read at start)
	const before = started.length, old = started.at(-1)!;
	writeFileSync(authFile(), "{}");
	await advance(AUTH_WATCH_MS + 10);
	await advance(4000);
	expect(old.calls).toContain("kill");
	expect(started.length).toBe(before + 1);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	await advance(500);
	expect(sends().length).toBeGreaterThan(0);
	await started.at(-1)!.push(...failedTurn(AUTH_ERR));
	await advance(500);
	expect(alerts).toHaveLength(1);

	// the next probe works: one recovery line, then nothing more
	await advance(2 * 60 * MIN + 10);
	await started.at(-1)!.push(...okTurn);
	await advance(500);
	expect(alerts).toHaveLength(2);
	expect(alerts[1]).toContain("다시 연결");
	await started.at(-1)!.push(...okTurn);
	await advance(500);
	expect(alerts).toHaveLength(2);
	again.stop();
	await advance(300);
}, 30_000);

test("orchestrator: switching to another account restarts the process on it and ends the pause of the old one, so held prompts go out at once", async () => {
	rmSync(limitAlertsFile(), { force: true });
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	const o: typeof Orchestrator = await import("./orchestrator.ts?limit-alert-switch");
	o.setAlertHandler(t => alerts.push(t));
	o.setAnswerHandlers(() => {}, () => {});
	o.start();
	await advance(4000);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	o.deliver("held on the dead account");
	await started.at(-1)!.push(...failedTurn(AUTH_ERR));
	await advance(500);
	expect(o.orch.status).toBe("rate-limited");
	const before = started.length, old = started.at(-1)!;
	expect(o.applyAccountPin()).toBe("restarted");
	await advance(4000);
	expect(old.calls).toContain("kill");
	expect(started.length).toBe(before + 1);
	expect(o.orch.status).not.toBe("rate-limited");
	o.stop();
	await advance(300);
}, 30_000);

test("orchestrator: the owner's 재개 ends the pause now, starts again with a probe turn; failing again stays quiet, a success says so once", async () => {
	rmSync(limitAlertsFile(), { force: true });
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	const o: typeof Orchestrator = await import("./orchestrator.ts?limit-alert-resume");
	o.setAlertHandler(t => alerts.push(t));
	o.setAnswerHandlers(() => {}, () => {});
	o.start();
	await advance(4000);
	await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
	o.deliver("blocked request");
	await started.at(-1)!.push(...failedTurn(AUTH_ERR));
	await advance(500);
	expect(o.orch.status).toBe("rate-limited");
	const told = alerts.length;
	const resume = async () => {
		const before = started.length;
		expect(o.resumeNow()).toBe("resumed");
		await advance(4000);
		expect(started.length).toBe(before + 1);
		await started.at(-1)!.push({ type: "session", ref: join(DATA, "limit-session.jsonl") });
		await advance(500);
		expect(o.orch.status).not.toBe("rate-limited");
		expect(started.at(-1)!.calls.some(c => c.includes("연결 확인입니다"))).toBe(true);
	};
	await resume();
	await started.at(-1)!.push(...failedTurn(AUTH_ERR));
	await advance(500);
	expect(o.orch.status).toBe("rate-limited");
	expect(alerts.length).toBe(told);   // the stoppage was already announced
	await resume();
	await started.at(-1)!.push(...okTurn);
	await advance(500);
	expect(alerts.length).toBe(told + 1);
	expect(alerts.at(-1)).toContain("다시 연결");
	o.stop();
	await advance(300);
}, 30_000);

