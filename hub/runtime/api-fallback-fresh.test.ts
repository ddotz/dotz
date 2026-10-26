// The owner's API fallback (2026-10-21) run against a simulated 429 with the owner's chain: the orchestrator moves to
// anthropic/claude-sonnet-5-5:high on the API key in a fresh session with a handover (never the same session), lanes stay on
// the subscription without a key, the subscription's usage report holds the return while it is still out and brings the
// orchestrator back to Opus medium in a fresh session as soon as it is usable, the alert channel hears the API episode once
// at its start and once at its end, and while miseol-shared is pinned no API key is used at all.
// API_FALLBACK_SIM_LOG=<file> also writes each step as one line (the evidence log).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endSubagents } from "../activity.ts";
import type * as Lanes from "../lanes.ts";
import type * as Orchestrator from "../orchestrator.ts";
import { cfg, DATA_DIR } from "../config.ts";
import { resetFallbackState } from "../fallback.ts";
import { adapters } from "./index.ts";
import { omp } from "./omp.ts";
import { advance, flush } from "./test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./types.ts";

const DATA = process.env.DOTZ_DIR!;
const o: typeof Orchestrator = await import("../orchestrator.ts?api-fallback-fresh");
const l: typeof Lanes = await import("../lanes.ts?api-fallback-fresh");

class FakeAgent implements AgentProcess {
	pid = 7300;
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
	send(text: string, _mode: SendMode): void {
		this.texts.push(text);
	}
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const started: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		started.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "owner: 오늘 일정 알려줘\nyou: (no answer yet)",
};
const current = () => started.at(-1)!;
const orchestrators = () => started.filter(s => s.opts.role === "orchestrator");

const KEY = "sk-ant-sim-secret";
const quota: AgentEvent = { type: "assistant", text: "", stop: "error", error: { text: "429 rate_limit_error: usage limit reached", kind: "rate", compaction: false } };
const answer = (text: string): AgentEvent[] => [{ type: "alive" }, { type: "turn_start" }, { type: "assistant", text, stop: "stop" }, { type: "turn_end" }];
const OWNER_CHAIN = { model: "anthropic/claude-opus-5-5", thinking: "medium", fallback: [{ model: "anthropic/claude-sonnet-5-5:high", key_file: "anthropic-api-key", when: "quota" as const }] };
const authFile = join(process.env.OMO_CODING_AGENT_DIR!, "auth.json");
const session = join(DATA, "api-sim-session.jsonl");
const log = (line: string) => {
	if (process.env.API_FALLBACK_SIM_LOG) appendFileSync(process.env.API_FALLBACK_SIM_LOG, `${line}\n`);
};

const patchable = Bun as unknown as { spawn: unknown };
const realSpawn = Bun.spawn;
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes, models: cfg.models };
const alerts: string[] = [];
const notices: string[] = [];
const realUsable = o.subscriptionCheck.usable;
let usable: boolean | undefined;

beforeAll(() => {
	// Another file's replay can leave orchestrator subagents marked running, which holds every chain switch.
	endSubagents("orchestrator");
	adapters.fake = fake;
	mkdirSync(join(DATA, "secrets"), { recursive: true });
	writeFileSync(join(DATA, "secrets", "anthropic-api-key"), KEY);
	for (const f of [session, join(DATA, "api-sim-session-2.jsonl"), join(DATA, "api-sim-session-3.jsonl")]) writeFileSync(f, "");
	patchable.spawn = (args: string[]) => {
		if (args[1] === "usage") return { stdout: new Response('{"reports":[]}').body, exited: Promise.resolve(0), kill() {} };
		throw new Error(`unexpected spawn in a test: ${args.join(" ")}`);
	};
	o.subscriptionCheck.usable = async () => usable;
	o.setNoticeHandler(t => notices.push(t));
	o.setAlertHandler(t => alerts.push(t));
	o.setAnswerHandlers(() => {}, () => {});
	l.setNoticeHandler(() => {});
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
	o.subscriptionCheck.usable = realUsable;
	patchable.spawn = realSpawn;
	rmSync(authFile, { force: true });
});

async function startOnSubscription(): Promise<FakeAgent> {
	resetFallbackState();
	writeFileSync(join(DATA, "orchestrator.json"), "{}");
	cfg.orchestrator = { runtime: "fake" };
	cfg.lanes = { ...savedCfg.lanes!, runtime: "fake" };
	cfg.models = { ...savedCfg.models, orchestrator: OWNER_CHAIN, lanes: { model: "anthropic/claude-opus-5-5", thinking: "medium", fallback: [] } };
	o.start();
	await advance(4000);
	await current().agent.push({ type: "session", ref: session });
	expect(o.orch.status).toBe("idle");
	return current().agent;
}

test("simulated 429: API key for the orchestrator only, fresh sessions both ways, return when the limit lifts, one notice each", async () => {
	rmSync(authFile, { force: true });
	alerts.length = 0;
	usable = undefined;
	const sub = await startOnSubscription();
	expect(current().opts).toMatchObject({ model: "anthropic/claude-opus-5-5:medium", hubSwitches: true });
	expect(current().opts.env.DOTZ_KEY_VALUE).toBeUndefined();
	log(`step 0  orchestrator on ${current().opts.model}, no key`);

	// The subscription's 429: a fresh API-key session, handed the recent exchanges, told about the API rules.
	o.deliver("오늘 일정 알려줘", true);
	await sub.push({ type: "alive" }, { type: "turn_start" }, quota, { type: "turn_end" });
	await advance(500);
	const api = current();
	expect(api.opts).toMatchObject({ role: "orchestrator", model: "anthropic-apikey/claude-sonnet-5-5:high" });
	expect(api.opts.resume).toBeUndefined();
	expect(api.opts.env.DOTZ_KEY_VALUE).toBe(KEY);
	expect(api.agent.texts[0]).not.toContain("[handover]");
	expect(api.agent.texts[1]).toContain("[handover]");
	expect(api.agent.texts[1]).toContain("오늘 일정 알려줘");
	expect(api.agent.texts[0]).toContain("This is the API-key fallback");
	expect(api.agent.texts[0]).toContain("answer it now");
	expect(alerts.filter(a => a.includes("API key in use"))).toHaveLength(1);
	log(`step 1  simulated 429 -> ${api.opts.model}, resume=${api.opts.resume ?? "none (fresh session + handover)"}\n        alert: ${alerts.at(-1)}`);
	await api.agent.push({ type: "session", ref: join(DATA, "api-sim-session-2.jsonl") }, ...answer("일정은 ..."));

	// A session started meanwhile runs on the subscription, never on the key.
	const cwd = join(DATA, "api-sim-lane");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "apisim"), { recursive: true, force: true });
	l.launch("apisim", cwd, "Build it.\nDone when: tests pass");
	const lane = current();
	expect(lane.opts.role).toBe("lane");
	expect(lane.opts.model).toBe("anthropic/claude-opus-5-5:medium");
	expect(lane.opts.env.DOTZ_KEY_VALUE).toBeUndefined();
	expect(JSON.stringify(lane.opts.env)).not.toContain(KEY);
	log(`step 2  lane started while on the key -> ${lane.opts.model}, no key in its environment`);
	l.shutdownLanes();
	l.lanes.delete("apisim");

	// The usage report still says the subscription is out: no return, however long it waits (no blind probe restarts).
	usable = false;
	const before = orchestrators().length;
	await advance(30 * 60_000);
	expect(orchestrators()).toHaveLength(before);
	expect(o.orch.activeModel).toBe("anthropic-apikey/claude-sonnet-5-5:high");
	log("step 3  usage report: still limited, 30 min -> stays on the key, no restart");

	// The limit lifts: back to Opus medium at once, in a fresh session with a handover.
	usable = true;
	await advance(60_000);
	const back = orchestrators().at(-1)!;
	expect(back).not.toBe(api);
	expect(back.opts.model).toBe("anthropic/claude-opus-5-5:medium");
	expect(back.opts.resume).toBeUndefined();
	expect(back.opts.env.DOTZ_KEY_VALUE).toBeUndefined();
	expect(back.agent.texts[0]).not.toContain("[handover]");
	expect(back.agent.texts[1]).toContain("[handover]");
	expect(back.agent.texts[0]).toContain("The subscription is usable again");
	log(`step 4  usage report: usable -> ${back.opts.model}, resume=${back.opts.resume ?? "none (fresh session + handover)"}`);

	// The first good turn on the subscription ends the episode: one end notice, and the start was not repeated.
	await back.agent.push({ type: "session", ref: join(DATA, "api-sim-session-3.jsonl") }, ...answer("돌아왔어요"));
	await back.agent.push(...answer("또 답"));
	expect(alerts.filter(a => a.includes("API key in use"))).toHaveLength(1);
	expect(alerts.filter(a => a.includes("API key no longer in use"))).toHaveLength(1);
	expect(JSON.stringify(alerts)).not.toContain(KEY);
	log(`step 5  first good turn on the subscription\n        alert: ${alerts.at(-1)}`);
	o.stop();
	await advance(300);
}, 60_000);

test("failed probe before the reset time: no restart before it, one fall-back notice with the reset, a silent failed probe, no retry within the back-off", async () => {
	rmSync(authFile, { force: true });
	alerts.length = 0;
	notices.length = 0;
	usable = undefined;
	const sub = await startOnSubscription();
	const limit = (text: string): AgentEvent => ({ type: "assistant", text: "", stop: "error", error: { text, kind: "rate", compaction: false } });
	o.deliver("오늘 일정 알려줘", true);
	await sub.push({ type: "alive" }, { type: "turn_start" }, limit("429 usage limit reached retry-after-ms: 7200000"), { type: "turn_end" });
	await advance(500);
	const api = current();
	expect(api.opts.model).toBe("anthropic-apikey/claude-sonnet-5-5:high");
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("KST");
	await api.agent.push({ type: "session", ref: join(DATA, "api-sim-session-2.jsonl") }, ...answer("일정은 ..."));

	// The reset is two hours away (plus the one-minute margin): nothing is tried before it.
	const n = orchestrators().length;
	await advance(110 * 60_000);
	expect(orchestrators()).toHaveLength(n);
	// At the reset the subscription is tried; the limit is still there, so it falls back again without a word.
	await advance(12 * 60_000);
	const probe = current();
	expect(orchestrators()).toHaveLength(n + 1);
	expect(probe.opts.model).toBe("anthropic/claude-opus-5-5:medium");
	await probe.agent.push({ type: "session", ref: join(DATA, "api-sim-session-3.jsonl") }, { type: "alive" }, { type: "turn_start" }, limit("429 usage limit reached"), { type: "turn_end" });
	await advance(500);
	expect(orchestrators()).toHaveLength(n + 2);
	expect(current().opts.model).toBe("anthropic-apikey/claude-sonnet-5-5:high");
	expect(notices).toHaveLength(1);
	expect(alerts.filter(a => a.includes("API key in use"))).toHaveLength(1);
	// No reset is named now: one hour, not ten minutes.
	await current().agent.push({ type: "session", ref: join(DATA, "api-sim-session-2.jsonl") }, ...answer("일정은 ..."));
	await advance(50 * 60_000);
	expect(orchestrators()).toHaveLength(n + 2);
	await advance(12 * 60_000);
	expect(orchestrators()).toHaveLength(n + 3);
	o.stop();
	await advance(300);
}, 60_000);

test("simulated 429 while miseol-shared is pinned: no API key, the orchestrator pauses on the subscription", async () => {
	// the install names the account in config guard.no_api_key_accounts (hub/apikey-policy.ts); the code bans none by itself
	const conf = join(DATA_DIR, "config.json"), had = existsSync(conf) ? readFileSync(conf, "utf8") : undefined;
	const c = had ? JSON.parse(had) : {};
	writeFileSync(conf, JSON.stringify({ ...c, guard: { ...(c.guard ?? {}), no_api_key_accounts: ["miseol-shared"] } }));
	writeFileSync(authFile, JSON.stringify({ "anthropic-subscription": { pinned: "miseol-shared" } }));
	alerts.length = 0;
	const sub = await startOnSubscription();
	o.deliver("hello", true);
	await sub.push({ type: "alive" }, { type: "turn_start" }, quota, { type: "turn_end" });
	await advance(500);
	expect(current().agent).toBe(sub);
	expect(current().opts.env.DOTZ_KEY_VALUE).toBeUndefined();
	expect(o.orch.status).toBe("rate-limited");
	expect(alerts.some(a => a.includes("API key in use"))).toBe(false);
	log(`pinned  miseol-shared pinned, simulated 429 -> status ${o.orch.status}, still ${o.orch.activeModel}, no key`);
	o.stop();
	await advance(300);
	rmSync(authFile, { force: true });
	if (had === undefined) rmSync(conf, { force: true });
	else writeFileSync(conf, had);
}, 60_000);
