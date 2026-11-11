import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { removeOmoLogin, saveOmoKey } from "./providers.ts";

// 로그아웃 on an OmO install: the login lives in OmO's auth.json, so the row's entry leaves that file (a copy stays beside it).
const put = (v: unknown) => { mkdirSync(dirname(authFile()), { recursive: true }); writeFileSync(authFile(), JSON.stringify(v)); };

test("anthropic signs out of the subscription login and keeps OmO's API-key entry; a copy of the file is kept 0600", () => {
	put({ "anthropic-subscription": { type: "oauth", pinned: "a", accounts: [{ name: "a" }] }, anthropic: { type: "api_key", key: "sk-x" }, openai: { type: "api_key", key: "sk-o" } });
	expect(removeOmoLogin("anthropic", 1)).toBe(true);
	const left = JSON.parse(readFileSync(authFile(), "utf8"));
	expect(Object.keys(left).sort()).toEqual(["anthropic", "openai"]);
	expect(existsSync(`${authFile()}.bak-1`)).toBe(true);
	expect(statSync(authFile()).mode & 0o777).toBe(0o600);
	expect(removeOmoLogin("openai", 2)).toBe(true);
	expect(Object.keys(JSON.parse(readFileSync(authFile(), "utf8")))).toEqual(["anthropic"]);
	expect(removeOmoLogin("google", 3)).toBe(false);   // nothing stored for it: nothing changes
	expect(readdirSync(dirname(authFile())).filter(f => f.startsWith("auth.json.bak-")).length).toBe(2);
});

test("an API key saved on an OmO install goes into OmO's auth.json beside the subscription login, 0600, with a copy of the old file", () => {
	put({ "anthropic-subscription": { type: "oauth", accounts: [] } });
	saveOmoKey("openai", "sk-test-1234567890", 10);
	const now = JSON.parse(readFileSync(authFile(), "utf8"));
	expect(now.openai).toEqual({ type: "api_key", key: "sk-test-1234567890" });
	expect(now["anthropic-subscription"]).toBeDefined();
	expect(statSync(authFile()).mode & 0o777).toBe(0o600);
	expect(existsSync(`${authFile()}.bak-10`)).toBe(true);
});
