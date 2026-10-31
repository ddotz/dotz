// An install's rule (config guard.no_api_key_accounts): while one of those subscription accounts is pinned in OmO, no API key may be used.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { API_KEY_OFF, allowFile, apiKeyBan, withoutApiKeys } from "./apikey-policy.ts";
import { DATA_DIR } from "./config.ts";
import { Chain, entryView, resetFallbackState } from "./fallback.ts";

const pin = (account: string) =>
	writeFileSync(join(process.env.OMO_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ "anthropic-subscription": { type: "oauth", pinned: account, accounts: {} }, anthropic: { type: "api_key", key: "sk-test" } }));

const CONFIG = join(DATA_DIR, "config.json");
const setBan = (names: string[] | undefined) => {
	const c = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
	c.guard = { ...(c.guard ?? {}), no_api_key_accounts: names };
	if (!names) delete c.guard.no_api_key_accounts;
	writeFileSync(CONFIG, JSON.stringify(c));
};

test("no account is banned unless the install's config names it: the shipped code carries no owner's account", () => {
	setBan(undefined);
	pin("miseol-shared");
	expect(apiKeyBan()).toBeUndefined();
	expect(withoutApiKeys({ ANTHROPIC_API_KEY: "sk" })).toEqual({ ANTHROPIC_API_KEY: "sk" });
	pin("default");
});

mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
writeFileSync(join(DATA_DIR, "secrets", "anthropic-api-key"), "sk-ant-test\n");

test("API keys are off unless guard.allow_api_key is true: no entry moves onto a key, no key reaches a process", () => {
	const setAllow = (v: unknown) => {
		const c = JSON.parse(readFileSync(CONFIG, "utf8"));
		c.guard = { ...c.guard, allow_api_key: v };
		if (v === undefined) delete c.guard.allow_api_key;
		writeFileSync(CONFIG, JSON.stringify(c));
	};
	const entries = [{ model: "anthropic/claude-sonnet-5-5:high", when: "quota" as const, key_file: "anthropic-api-key", workers: true }];
	for (const v of [undefined, false, "true"]) {
		resetFallbackState();
		setAllow(v);
		expect(apiKeyBan()).toBe(API_KEY_OFF);
		const c = new Chain("anthropic/claude-opus-5-5:medium", entries, "medium");
		expect(c.down(1)?.why).toBe("error");
		expect(c.fail("quota", Date.now() + 3600e3)).toBeUndefined();
		expect(() => c.env(1)).toThrow(/allow_api_key/);
		expect(withoutApiKeys({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", DOTZ_KEY_VALUE: "k" })).toEqual({ PATH: "/bin" });
		expect(entryView(entries[0]).down_reason).toBe("api_key_off");
	}
	resetFallbackState();
	setAllow(true);
	expect(apiKeyBan()).toBeUndefined();
	expect(new Chain("anthropic/claude-opus-5-5:medium", entries, "medium").fail("quota", Date.now() + 3600e3)?.to).toBe(1);
});

test("the config list is the ban: naming an account bans it", () => {
	setBan(["miseol-shared"]);
	pin("miseol-shared");
	expect(apiKeyBan()).toBe("miseol-shared");
	pin("default");
});

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

test("the owner's lift file allows API keys under the pin until its expiry, then the ban is back by itself", () => {
	pin("miseol-shared");
	writeFileSync(allowFile(), `${Math.floor(Date.now() / 1000) + 3600}\n`);
	expect(apiKeyBan()).toBeUndefined();
	expect(withoutApiKeys({ ANTHROPIC_API_KEY: "sk" })).toEqual({ ANTHROPIC_API_KEY: "sk" });
	writeFileSync(allowFile(), `${Math.floor(Date.now() / 1000) - 1}\n`);
	expect(apiKeyBan()).toBe("miseol-shared");
	rmSync(allowFile());
	expect(apiKeyBan()).toBe("miseol-shared");
	pin("default");
});

test("the settings view says an API-key entry is down because of the pin, and not otherwise", () => {
	resetFallbackState();
	const entry = { model: "anthropic/claude-opus-5-5", key_file: "anthropic-api-key" };
	pin("miseol-shared");
	expect(entryView(entry)).toMatchObject({ down: "error", down_reason: "api_key_ban", down_account: "miseol-shared" });
	pin("default");
	expect(entryView(entry).down_reason).toBeUndefined();
});
