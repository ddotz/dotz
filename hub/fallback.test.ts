// The hub-driven chain's decisions on their own (no process): where a spent cap goes, when every entry is out, and which
// failures move the chain at all.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { cfg, DATA_DIR } from "./config.ts";
import { atTime, Chain, failsOver, failureReason, keyHostOk, keyProviderOk, resetFallbackState } from "./fallback.ts";

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
