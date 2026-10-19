// The owner's rule: while 미설's subscription account (miseol-shared) is pinned in OmO, no API key may be used.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { apiKeyBan, withoutApiKeys } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";
import { Chain, resetFallbackState } from "./fallback.ts";

const pin = (account: string) =>
	writeFileSync(join(process.env.OMO_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ "anthropic-subscription": { type: "oauth", pinned: account, accounts: {} }, anthropic: { type: "api_key", key: "sk-test" } }));

mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
writeFileSync(join(DATA_DIR, "secrets", "anthropic-api-key"), "sk-ant-test\n");

test("miseol-shared pinned: an API-key entry is never chosen and never gets its key; another pin allows it", () => {
	resetFallbackState();
	const entries = [{ model: "anthropic/claude-opus-5-5", key_file: "anthropic-api-key" }];
	pin("miseol-shared");
	expect(apiKeyBan()).toBe("miseol-shared");
	const c = new Chain("anthropic/claude-opus-5-5:medium", entries, "medium");
	expect(c.down(1)?.why).toBe("error");
	expect(c.fail("quota", Date.now() + 3600e3)).toBeUndefined();
	expect(() => c.env(1)).toThrow(/miseol-shared/);

	resetFallbackState();
	pin("default");
	expect(apiKeyBan()).toBeUndefined();
	const d = new Chain("anthropic/claude-opus-5-5:medium", entries, "medium");
	expect(d.down(1)).toBeUndefined();
	expect(d.env(1).DOTZ_KEY_VALUE).toBe("sk-ant-test");
});

test("miseol-shared pinned: API-key variables are stripped from a spawned process's environment", () => {
	pin("miseol-shared");
	const env = withoutApiKeys({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t", DOTZ_KEY_VALUE: "k" });
	expect(env).toEqual({ PATH: "/bin" });
	pin("default");
	expect(withoutApiKeys({ ANTHROPIC_API_KEY: "sk" })).toEqual({ ANTHROPIC_API_KEY: "sk" });
});
