// A hub-driven fallback chain on the orchestrator, with faked provider events and the fake clock: a usage limit moves it to an
// API-key entry, that entry's limit-free return follows when the subscription resets, its monthly spend cap moves it on to the
// next entry, and when no entry is left it pauses until the cap period ends and then starts on the subscription again.
// FALLBACK_STEP_LOG=<file> also writes each step as one line (the evidence log of the feature).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "../lanes.ts";
import type * as Orchestrator from "../orchestrator.ts";
import { cfg } from "../config.ts";
import { resetFallbackState } from "../fallback.ts";
import { adapters } from "./index.ts";
import { omp } from "./omp.ts";
import { advance, clock, flush } from "./test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./types.ts";

const DATA = process.env.DOTZ_DIR!;
const o: typeof Orchestrator = await import("../orchestrator.ts?fallback-chain");

class FakeAgent implements AgentProcess {
	pid = 7100;
	calls: string[] = [];
	texts: string[] = [];
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
		this.texts.push(text);
	}
	abort = () => void this.calls.push("abort");
	compact = () => void this.calls.push("compact");
	refreshUsage = () => void this.calls.push("refreshUsage");
	refreshSession = () => void this.calls.push("refreshSession");
	watchSubagents = () => void this.calls.push("watchSubagents");
	kill = (force?: boolean) => {
		this.calls.push(force ? "kill:force" : "kill");
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
	classifyError: omp.classifyError,
	recentExchanges: () => undefined,
};

const quota: AgentEvent = { type: "assistant", text: "", stop: "error", error: { text: "429 usage limit reached", kind: "rate", compaction: false } };
const turn = (...mid: AgentEvent[]): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, ...mid, { type: "turn_end" }];
const KEY = "sk-test-secret-value";
const log = (line: string) => {
	if (process.env.FALLBACK_STEP_LOG) appendFileSync(process.env.FALLBACK_STEP_LOG, `${line}\n`);
};

const patchable = Bun as unknown as { spawn: unknown };
const realSpawn = Bun.spawn;
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes, models: cfg.models, key_hosts: cfg.key_hosts };
// The key entries point at a host the test allows; nothing is sent, the runtime is fake.
cfg.key_hosts = ["keys.test.invalid"];
const notices: string[] = [];
const alerts: string[] = [];

beforeAll(() => {
	adapters.fake = fake;
	writeFileSync(join(DATA, "secrets", "test-api-key"), KEY);
	writeFileSync(join(DATA, "fake-session.jsonl"), "");
	// providers.rateLimitDelay asks `omp usage`; an empty report makes the retry delay the plain default (about 11 minutes).
	patchable.spawn = (args: string[]) => {
		if (args[1] === "usage") return { stdout: new Response('{"reports":[]}').body, exited: Promise.resolve(0), kill() {} };
		throw new Error(`unexpected spawn in a test: ${args.join(" ")}`);
	};
	o.setNoticeHandler(t => notices.push(t));
	o.setAlertHandler(t => alerts.push(t));
	o.setAnswerHandlers(() => {}, () => {});
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	patchable.spawn = realSpawn;
});

const current = () => started.at(-1)!;

test("quota -> API-key entry -> reset returns to the subscription -> monthly cap -> next entry -> exhausted pause -> reset", async () => {
	resetFallbackState();
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	cfg.orchestrator = { runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: {
		model: "anthropic/test-orch",
		thinking: "low",
		fallback: [{ model: "anthropic/test-orch", key_file: "test-api-key", when: "quota", cap: { period: "month", usd: 50 }, revert: true, base_url: "https://keys.test.invalid/v1", api: "openai-completions" }, "openai/test-third"],
	} };

	// Step 0: the subscription model runs; the hub drives the chain itself, so omp is told not to walk one.
	o.start();
	expect(current().opts).toMatchObject({ model: "anthropic/test-orch:low", hubSwitches: true, fallback: [] });
	expect(current().opts.env.DOTZ_KEY_VALUE).toBeUndefined();
	await advance(4000);
	await current().agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	expect(o.orch.status).toBe("idle");
	log(`step 0  start on ${current().opts.model}; the chain is hub-driven`);

	// Step 1: the subscription hits its usage limit -> the API-key entry in a fresh session (never the same session on another
	// model), told to answer the request that failed.
	const first = current();
	o.deliver("hello");
	await first.agent.push(...turn(quota));
	await advance(500);
	expect(started).toHaveLength(2);
	expect(current().opts.model).toBe("anthropic-apikey/test-orch:low");
	expect(current().opts.env.DOTZ_KEY_VALUE).toBe(KEY);
	const spec = JSON.parse(current().opts.env.DOTZ_KEY_PROVIDER);
	expect(spec).toMatchObject({ id: "anthropic-apikey", baseUrl: "https://keys.test.invalid/v1", api: "openai-completions" });
	expect(JSON.stringify(spec)).not.toContain(KEY);
	expect(current().opts.resume).toBeUndefined();
	expect(current().agent.texts[0]).toContain("This is the API-key fallback");
	expect(current().agent.texts[0]).toContain("answer it now");
	expect(notices.at(-1)).toBe("Model fallback: anthropic/test-orch → anthropic/test-orch (API key) (usage limit reached)");
	log(`step 1  fake quota exhaustion -> ${current().opts.model} (key from secrets/test-api-key, fresh session)\n        worklog: ${notices.at(-1)}`);
	// The key reaches the process only through its environment: never the overlay, the notices, the alerts or the usage file.
	expect(JSON.stringify([notices, alerts, readFileSync(join(DATA, "fallback-usage.json"), "utf8")])).not.toContain(KEY);

	// Step 2: the subscription's window resets (the recorded pause ends) -> back to it at the next idle moment.
	await current().agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	await current().agent.push(...turn({ type: "assistant", text: "done on the key", stop: "stop" }));
	await advance(12 * 60_000);
	expect(started).toHaveLength(3);
	expect(current().opts.model).toBe("anthropic/test-orch:low");
	expect(notices.at(-1)).toBe("Model back: anthropic/test-orch (API key) → anthropic/test-orch (limit reset)");
	log(`step 2  fake reset (12 min later) -> ${current().opts.model}\n        worklog: ${notices.at(-1)}`);

	// Step 3: the limit again -> API key; then its spend reaches the monthly $50 cap -> next entry, after the running turn.
	await current().agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	o.deliver("again");
	await current().agent.push(...turn(quota));
	await advance(500);
	expect(current().opts.model).toBe("anthropic-apikey/test-orch:low");
	await current().agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	const onKey = current();
	o.deliver("big job");
	await onKey.agent.push({ type: "alive" }, { type: "turn_start" }, { type: "spend", tokens: 900_000, usd: 49 });
	expect(started.at(-1)).toBe(onKey);
	await onKey.agent.push({ type: "spend", tokens: 100_000, usd: 2 }, { type: "assistant", text: "big result", stop: "stop" }, { type: "turn_end" });
	await advance(500);
	expect(current().opts.model).toBe("openai/test-third:low");
	expect(current().opts.env.DOTZ_KEY_VALUE).toBeUndefined();
	expect(notices.at(-1)).toBe("Model fallback: anthropic/test-orch (API key) → openai/test-third (spend cap reached)");
	const usage = JSON.parse(readFileSync(join(DATA, "fallback-usage.json"), "utf8"));
	expect(usage.pools["key:test-api-key"].month.usd).toBe(51);
	expect(JSON.stringify(usage)).not.toContain(KEY);
	log(`step 3  fake monthly cap ($51 of $50) -> ${current().opts.model}\n        worklog: ${notices.at(-1)}`);

	// Step 4: only the capped entry is left (a daily cap here, so the fake clock can reach its end) -> the orchestrator pauses with an alert ...
	const spent = notices.length;
	o.stop();
	await advance(300);
	resetFallbackState();
	cfg.models = { ...cfg.models, orchestrator: { ...cfg.models!.orchestrator, fallback: [{ model: "anthropic/test-orch", key_file: "test-api-key", when: "quota", cap: { period: "day", usd: 5 }, base_url: "https://keys.test.invalid/v1", api: "openai-completions" }] } };
	o.start();
	await advance(4000);
	await current().agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	const sub = current();
	o.deliver("last");
	await sub.agent.push(...turn(quota));
	await advance(500);
	expect(current().opts.model).toBe("anthropic-apikey/test-orch:low");
	await current().agent.push({ type: "session", ref: join(DATA, "fake-session.jsonl") });
	const capped = current();
	o.deliver("spend it");
	await capped.agent.push({ type: "alive" }, { type: "turn_start" }, { type: "spend", tokens: 10, usd: 6 }, { type: "assistant", text: "r", stop: "stop" }, { type: "turn_end" });
	await advance(500);
	expect(o.orch.status).toBe("rate-limited");
	expect(started.at(-1)).toBe(capped);
	expect(alerts.at(-1)).toContain("reached its spend cap and no fallback model is left");
	expect(notices.slice(spent).some(n => n.includes("Paused until"))).toBe(true);
	log(`step 4  fake daily cap with no entry left -> status ${o.orch.status}\n        alert: ${alerts.at(-1)}`);

	// Step 5: the cap period ends -> a fresh start on the subscription (the key entry's cap has reset; the usage window of the subscription passed).
	const beforeReset = started.length;
	clock.now += 8 * 3600e3;
	await advance(60_000);
	await advance(60_000);
	expect(started.length).toBeGreaterThan(beforeReset);
	expect(current().opts.model).toBe("anthropic/test-orch:low");
	log(`step 5  fake reset (cap period ended) -> ${current().opts.model}, status ${o.orch.status}`);
	o.stop();
	await advance(300);
}, 60_000);

// The lane state is one shared module (lanestate.ts): reset it so no lane or handler leaks in from another test file.
const l: typeof Lanes = await import("../lanes.ts");
(await import("../lanestate.ts")).resetLaneStateForTest();

test("lane: a usage limit moves it to its API-key entry on the same session", async () => {
	resetFallbackState();
	cfg.lanes = { ...savedCfg.lanes!, runtime: "fake" };
	cfg.models = { ...cfg.models, lanes: { ...savedCfg.models?.lanes, fallback: [{ model: "anthropic/test-lane", key_file: "test-api-key", when: "quota", base_url: "https://keys.test.invalid/v1", api: "openai-completions" }] } };
	const cwd = join(DATA, "chain-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "ck"), { recursive: true, force: true });
	const laneNotices: string[] = [];
	l.setNoticeHandler((_lane, t) => laneNotices.push(t));
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});

	const lane = l.launch("ck", cwd, "Build it.\nDone when: tests pass");
	const first = current();
	expect(first.opts).toMatchObject({ role: "lane", model: "anthropic/test-lane:medium", hubSwitches: true });
	await advance(3000);
	await first.agent.push({ type: "session", ref: join(DATA, "fake-lane-chain.jsonl") });
	await first.agent.push({ type: "alive" }, { type: "turn_start" });
	await first.agent.push(quota, { type: "turn_end" });
	await advance(500);
	expect(current()).not.toBe(first);
	expect(current().opts).toMatchObject({ role: "lane", model: "anthropic-apikey/test-lane:medium", resume: join(DATA, "fake-lane-chain.jsonl") });
	expect(current().opts.env.DOTZ_KEY_VALUE).toBe(KEY);
	expect(lane.activeModel).toBe("anthropic-apikey/test-lane:medium");
	expect(laneNotices).toEqual(["Model fallback: anthropic/test-lane → anthropic/test-lane (API key) (usage limit reached)"]);
	log(`lane    fake quota exhaustion -> ${current().opts.model} (same session)\n        lane line: ${laneNotices[0]}`);
	l.shutdownLanes();
	l.lanes.delete("ck");
});
