// Keys typed into the settings: format and one provider check before anything is written, mode 600 with a .bak of the
// previous key, and no key value in what the API returns. Fake keys only; fetch is replaced, nothing leaves the machine.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { authFile } from "./apikey-policy.ts";
import { deleteKey, importOmoKey, keysView, saveKey } from "./apikey-store.ts";
import { keyFileOk, keyPath } from "./fallback.ts";

const FAKE_A = `sk-ant-api03-${"a".repeat(40)}WXYZ`;
const FAKE_B = `sk-ant-api03-${"b".repeat(40)}LAST`;
const calls: Array<{ url: string; headers: Record<string, string> }> = [];
const fakeFetch = (status: number) =>
	(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
		return new Response("{}", { status });
	}) as unknown as typeof fetch;

test("a malformed key is refused before any request; a 401 key is refused and nothing is written", async () => {
	calls.length = 0;
	await expect(saveKey("anthropic", "anthropic-api-key", fakeFetch(200))).rejects.toThrow("형식");
	expect(calls.length).toBe(0);
	await expect(saveKey("anthropic", FAKE_A, fakeFetch(401))).rejects.toThrow("401");
	expect(calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=1");
	expect(calls[0].headers["x-api-key"]).toBe(FAKE_A);
	expect(existsSync(keyPath("anthropic-api-key"))).toBe(false);
	await expect(saveKey("google", FAKE_A, fakeFetch(200))).rejects.toThrow();
});

test("a good key is stored where the fallback reads it (600), the old one kept as .bak, and only a mask comes back", async () => {
	const first = await saveKey("anthropic", ` ${FAKE_A}\n`, fakeFetch(200));
	expect(first).toEqual({ provider: "anthropic", file: "anthropic-api-key", masked: "sk-ant-…WXYZ" });
	const file = keyPath("anthropic-api-key");
	expect(readFileSync(file, "utf8").trim()).toBe(FAKE_A);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(keyFileOk(first.file)).toBe(true);
	await saveKey("anthropic", FAKE_B, fakeFetch(200));
	expect(readFileSync(`${file}.bak`, "utf8").trim()).toBe(FAKE_A);
	expect(statSync(`${file}.bak`).mode & 0o777).toBe(0o600);
	const view = JSON.stringify(keysView());
	expect(view).not.toContain(FAKE_B);
	expect(keysView().providers.find(p => p.provider === "anthropic")).toEqual({ provider: "anthropic", file: "anthropic-api-key", present: true, masked: "sk-ant-…LAST" });
	expect(deleteKey("anthropic")).toEqual({ provider: "anthropic", deleted: true });
	expect(existsSync(file)).toBe(false);
	expect(readFileSync(`${file}.bak`, "utf8").trim()).toBe(FAKE_B);
	expect(keysView().providers.find(p => p.provider === "anthropic")?.present).toBe(false);
});

test("OmO's stored Anthropic key can be taken over after the same check", async () => {
	writeFileSync(authFile(), JSON.stringify({ anthropic: { type: "api_key", key: FAKE_A } }));
	expect(keysView().omo_anthropic).toBe(true);
	expect((await importOmoKey(fakeFetch(200))).masked).toBe("sk-ant-…WXYZ");
	expect(readFileSync(keyPath("anthropic-api-key"), "utf8").trim()).toBe(FAKE_A);
	deleteKey("anthropic");
	writeFileSync(authFile(), "{}");
	await expect(importOmoKey(fakeFetch(200))).rejects.toThrow("OmO");
});
