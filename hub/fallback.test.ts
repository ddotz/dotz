// The hub-driven chain's decisions on their own (no process): where a spent cap goes, when every entry is out, and which
// failures move the chain at all.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { cfg, chainAfter, DATA_DIR, entryOf } from "./config.ts";
import { atTime, Chain, failsOver, failureReason, hubChain, keyedWorker, keyHostOk, keyProviderOk, resetFallbackState, spendOnKey, workerKeyEnv } from "./fallback.ts";
import { writeWorkerProfile } from "./runtime/omo.ts";
import { classifyProviderError, poolRetryAt } from "./providers.ts";

mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });

const HOUR = 3600e3;

test("a capped entry hands back to an earlier entry whose limit has passed, instead of pausing", () => {
	resetFallbackState();
	const at = Date.UTC(2026, 9, 10, 3);
	const c = new Chain("anthropic/sub:low", [{ model: "openai/x", cap: { period: "month", usd: 10 } }], "low");
	c.active = 0;
	expect(c.fail("quota", at + 5 * HOUR, at)).toEqual({ from: 0, to: 1, why: "quota" });
	c.active = 1;
	// Six hours later the subscription's 5h block is over and the second entry spends past its cap.
	expect(c.spend(1000, 11, at + 6 * HOUR)).toEqual({ capped: true, move: { from: 1, to: 0, why: "cap" } });
});

test("exhaustedUntil: every entry out and one of them capped -> the earliest block end; one usable entry -> none", () => {
	resetFallbackState();
	const at = Date.UTC(2026, 9, 10, 3);
	const c = new Chain("anthropic/sub:low", [{ model: "openai/x", cap: { period: "day", usd: 1 } }], "low");
	c.active = 0;
	c.fail("quota", at + 2 * HOUR, at);
	c.active = 1;
	c.spend(10, 2, at);
	expect(c.exhaustedUntil(at)).toBe(at + 2 * HOUR);
	expect(c.exhaustedUntil(at + 3 * HOUR)).toBeUndefined();
});

test("only provider-side failures move the chain; a too-long context is not a quota", () => {
	expect(failsOver("rate")).toBe(true);
	expect(failsOver("transient")).toBe(true);
	expect(failsOver(undefined)).toBe(false);
	expect(failureReason({ text: "prompt is too long: context length exceeded" })).toBe("error");
	expect(failureReason({ text: "credit balance is too low" })).toBe("quota");
});

// Error texts as they appear in real OmO session records (~/.omo/agent/sessions); before this list several fell through
// to "no kind", so the chain never moved on from them.
test("real provider errors get the kind that decides failover", () => {
	const cases: [string, string | undefined][] = [
		["WebSocket error", "transient"],
		["WebSocket closed 1006 Connection ended", "transient"],
		["JSON error injected into SSE stream", "transient"],
		["Provider stream start timed out after 90000ms", "transient"],
		["OAuth refresh failed for anthropic: Anthropic token refresh request failed.", "owner"],
		['400: {"message":"Provider is disabled: openrouter","type":"invalid_request_error"}', "owner"],
		['402: {"message":"Provider error 402: This request requires more credits, or fewer max_tokens."}', "owner"],
		["Codex error: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.", "owner"],
		['401: {"message":"Not logged in to anthropic. Run: ocx login anthropic","type":"authentication_error"}', "owner"],
		["Codex error: The usage limit has been reached", "rate"],
		["You've hit your session limit · resets 12:30am (Asia/Seoul)", "rate"],
		["The provider rejected this turn because its input exceeds the provider size or context limit.", undefined],
		// a pinned OmO account on its limit (MacBook 2026-10-26): a usage limit with its end time, not a model error
		["Claude account 'default' for anthropic-subscription is blocked (rate limit) until 2026-10-26T11:20:00.000Z, and account fallback is off, so no other account is tried.", "rate"],
	];
	for (const [text, kind] of cases) expect([text, classifyProviderError(text)]).toEqual([text, kind]);
});

test("an API key goes only over https to a provider's own host or a configured one; another base_url is refused", () => {
	expect(keyHostOk("https://api.anthropic.com")).toBe(true);
	expect(keyHostOk("https://openrouter.ai/api/v1")).toBe(true);
	expect(keyHostOk("http://api.anthropic.com")).toBe(false);
	expect(keyHostOk("https://evil.example/v1")).toBe(false);
	expect(keyHostOk("https://api.anthropic.com.evil.example")).toBe(false);
	expect(keyHostOk("https://user:pw@api.anthropic.com")).toBe(false);
	expect(keyHostOk("not a url")).toBe(false);
	const entry = { model: "anthropic/m", key_file: "x-api-key", base_url: "https://gw.example/v1", api: "openai-completions" };
	expect(keyProviderOk(entry)).toBe(false);
	const saved = cfg.key_hosts;
	cfg.key_hosts = ["gw.example"];
	try {
		expect(keyHostOk("https://gw.example/v1")).toBe(true);
		expect(keyProviderOk(entry)).toBe(true);
	} finally {
		cfg.key_hosts = saved;
	}
	// A stored entry whose host is not allowed is never started, even with its key file present.
	writeFileSync(join(DATA_DIR, "secrets", "x-api-key"), "sk-test");
	resetFallbackState();
	const c = new Chain("anthropic/sub:low", [entry], "low");
	expect(c.down(1)?.why).toBe("error");
	expect(() => c.env(1)).toThrow("not allowed");
});

test("atTime re-arms past setTimeout's 24.8-day limit instead of firing at once", () => {
	const real = globalThis.setTimeout;
	const armed: number[] = [];
	let fired = false;
	globalThis.setTimeout = ((_fn: () => void, ms: number) => (armed.push(ms), 0)) as unknown as typeof setTimeout;
	try {
		atTime(Date.now() + 40 * 24 * HOUR, () => {}, () => (fired = true));
	} finally {
		globalThis.setTimeout = real;
	}
	expect(armed).toEqual([2 ** 31 - 1]);
	expect(fired).toBe(false);
});

test("hubChain: OmO gets every chain driven by the hub (bare entries revert), omp only conditional ones, others none", () => {
	expect(hubChain("omo", [])).toBeUndefined();
	expect(hubChain("omo", [{ model: "openai/x" }, { model: "openai/y", when: "quota" }])).toEqual([{ model: "openai/x", revert: true }, { model: "openai/y", when: "quota" }]);
	expect(hubChain("omp", [{ model: "openai/x" }])).toBeUndefined();
	expect(hubChain("omp", [{ model: "openai/x", when: "quota" }])).toEqual([{ model: "openai/x", when: "quota" }]);
	expect(hubChain("claude", [{ model: "openai/x", when: "quota" }])).toBeUndefined();
});

test("a switched-off entry is registered but skipped: by the chain, by chainAfter, and by the start entry", () => {
	resetFallbackState();
	const at = Date.UTC(2026, 9, 10, 3);
	const c = new Chain("anthropic/sub:low", [{ model: "openai/x", enabled: false }, { model: "openai/y" }], "low");
	expect(c.down(1)?.why).toBe("off");
	expect(c.next(0, "quota", at)).toBe(2);
	expect(c.next(0, "error", at)).toBe(2);
	expect(c.fail("quota", at + HOUR, at)).toEqual({ from: 0, to: 2, why: "quota" });
	const only = new Chain("anthropic/sub:low", [{ model: "openai/x", enabled: false }], "low");
	expect(only.fail("quota", at + HOUR, at)).toBeUndefined();
	expect(only.exhaustedUntil(at)).toBeUndefined();
	expect(chainAfter("anthropic/sub", [{ model: "openai/x", enabled: false }, { model: "openai/y" }, { model: "anthropic/k", key_file: "anthropic-api-key", enabled: false }])).toEqual([{ model: "openai/y" }]);
	expect(entryOf({ model: "openai/x", enabled: false })).toEqual({ model: "openai/x", enabled: false });
	expect(entryOf({ model: "openai/x", workers: true })).toEqual({ model: "openai/x" });
	expect(entryOf({ model: "anthropic/k", key_file: "anthropic-api-key", workers: true })).toEqual({ model: "anthropic/k", key_file: "anthropic-api-key", workers: true });
});

test("workers on a keyed entry: workers get the key provider and worker model, never the key; workers off or absent: none", () => {
	resetFallbackState();
	writeFileSync(join(DATA_DIR, "secrets", "anthropic-api-key"), "sk-ant-test-key");
	const agentDir = mkdtempSync(join(tmpdir(), "dotz-nopin-"));
	const was = process.env.OMO_CODING_AGENT_DIR;
	process.env.OMO_CODING_AGENT_DIR = agentDir;
	try {
		const keyed = { model: "anthropic/claude-opus-5-5", key_file: "anthropic-api-key", workers: true };
		const worker = "anthropic/claude-sonnet-5-5:high";
		const on = new Chain("anthropic/claude-opus-5-5:medium", [keyed], "medium").env(1, worker);
		expect(on.DOTZ_KEY_WORKERS).toBe("1");
		expect(on.DOTZ_KEY_FILE).toBe("anthropic-api-key");
		expect(on.DOTZ_KEY_VALUE).toBe("sk-ant-test-key");
		expect(on.DOTZ_KEY_PROVIDER).not.toContain("sk-ant-test-key");
		expect(JSON.parse(on.DOTZ_KEY_PROVIDER).models.map((m: { id: string }) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
		expect(keyedWorker(on)).toBe("anthropic-apikey/claude-sonnet-5-5:high");
		for (const entry of [{ ...keyed, workers: false }, { model: keyed.model, key_file: keyed.key_file }]) {
			const off = new Chain("anthropic/claude-opus-5-5:medium", [entry], "medium").env(1, worker);
			expect(off.DOTZ_KEY_WORKERS).toBeUndefined();
			expect(off.DOTZ_KEY_FILE).toBeUndefined();
			expect(keyedWorker(off)).toBeUndefined();
		}
		// A worker model of another provider falls back to the entry's own model on the key.
		expect(keyedWorker(new Chain("anthropic/claude-opus-5-5:medium", [keyed], "medium").env(1, "openai/gpt-x:high"))).toBe("anthropic-apikey/claude-opus-5-5");
		// The worker profile of a keyed lane points every category at the key provider's model.
		const file = join(agentDir, "omo.json");
		const name = writeWorkerProfile({ workerModel: keyedWorker(on)!, workerFallback: [] }, file)!;
		const cats = JSON.parse(readFileSync(file, "utf8")).profiles[name].categories;
		expect(cats.quick.models).toEqual([{ model: "anthropic-apikey/claude-sonnet-5-5", reasoning: "high" }]);
	} finally {
		if (was === undefined) delete process.env.OMO_CODING_AGENT_DIR;
		else process.env.OMO_CODING_AGENT_DIR = was;
		rmSync(join(DATA_DIR, "secrets", "anthropic-api-key"), { force: true });
	}
});

test("the workers' own chain ends in an API key: the key reaches the spawned workers only while the subscription is out", () => {
	resetFallbackState();
	writeFileSync(join(DATA_DIR, "secrets", "anthropic-api-key"), "sk-ant-test-key");
	const agentDir = mkdtempSync(join(tmpdir(), "dotz-nopin-"));
	const was = process.env.OMO_CODING_AGENT_DIR;
	process.env.OMO_CODING_AGENT_DIR = agentDir;
	try {
		const worker = "anthropic/claude-sonnet-5-5:high";
		const keyed = { model: "anthropic/claude-sonnet-5-5", key_file: "anthropic-api-key", when: "quota" as const };
		// The subscription model is usable: the workers keep it and the process gets no key variable.
		expect(workerKeyEnv(worker, [keyed])).toEqual({});
		expect(workerKeyEnv(worker, [{ model: "openai/x" }])).toEqual({});
		// Its usage limit is recorded: the spawn config carries the key provider, the key file name and the worker model, never the key.
		const now = Date.now();
		new Chain(worker, [keyed], "high").fail("quota", now + HOUR, now);
		const env = workerKeyEnv(worker, [keyed]);
		expect(env.DOTZ_KEY_VALUE).toBeUndefined();
		expect(JSON.stringify(env)).not.toContain("sk-ant-test-key");
		expect(env.DOTZ_KEY_WORKERS).toBe("1");
		expect(env.DOTZ_KEY_FILE).toBe("anthropic-api-key");
		const spec = JSON.parse(env.DOTZ_KEY_PROVIDER);
		expect(spec.id).toBe("anthropic-apikey");
		expect(spec.models.map((m: { id: string }) => m.id)).toEqual(["claude-sonnet-5-5"]);
		expect(keyedWorker(env)).toBe("anthropic-apikey/claude-sonnet-5-5:high");
		// The worker profile of the process points every category at the key provider's model.
		const file = join(agentDir, "omo.json");
		const name = writeWorkerProfile({ workerModel: keyedWorker(env)!, workerFallback: [] }, file)!;
		expect(JSON.parse(readFileSync(file, "utf8")).profiles[name].categories.quick.models).toEqual([{ model: "anthropic-apikey/claude-sonnet-5-5", reasoning: "high" }]);
		// Switched off, or past its spend cap (the workers' spend counts on the shared key pool): no key.
		expect(workerKeyEnv(worker, [{ ...keyed, enabled: false }])).toEqual({});
		spendOnKey("anthropic-api-key", 1000, 6);
		expect(workerKeyEnv(worker, [{ ...keyed, cap: { period: "month", usd: 5 } }])).toEqual({});
		// A condition that does not fit a usage limit (error only) keeps the key off while the subscription is merely rate-limited.
		expect(workerKeyEnv(worker, [{ ...keyed, when: "error" }])).toEqual({});
	} finally {
		if (was === undefined) delete process.env.OMO_CODING_AGENT_DIR;
		else process.env.OMO_CODING_AGENT_DIR = was;
		rmSync(join(DATA_DIR, "secrets", "anthropic-api-key"), { force: true });
	}
});

test("a worker's spend on the key counts against the entry's cap, shared with the orchestrator's and the lanes'", () => {
	resetFallbackState();
	writeFileSync(join(DATA_DIR, "secrets", "anthropic-api-key"), "sk-ant-test-key");
	const at = Date.UTC(2026, 9, 10, 3);
	const entry = { model: "anthropic/claude-opus-5-5", key_file: "anthropic-api-key", workers: true, cap: { period: "month" as const, usd: 5 } };
	const c = new Chain("anthropic/claude-opus-5-5:medium", [entry], "medium");
	c.active = 1;
	try {
		expect(c.spend(10, 2, at)).toBeUndefined();
		spendOnKey("anthropic-api-key", 100, 3.5, at);
		expect(c.down(1, at)?.why).toBe("cap");
		expect(c.spend(1, 0, at)).toMatchObject({ capped: true });
	} finally {
		rmSync(join(DATA_DIR, "secrets", "anthropic-api-key"), { force: true });
	}
});

test("a pinned account's limit names when it ends, and the pause waits for exactly that", () => {
	expect(poolRetryAt("Claude account 'default' for anthropic-subscription is blocked (rate limit) until 2026-10-26T11:20:00.000Z, and account fallback is off, so no other account is tried.")).toBe(Date.parse("2026-10-26T11:20:00.000Z"));
	expect(poolRetryAt("All Claude accounts for anthropic-subscription are currently blocked (rate limit). Soonest automatic retry: 2026-10-26T11:20:00.000Z.")).toBe(Date.parse("2026-10-26T11:20:00.000Z"));
});

