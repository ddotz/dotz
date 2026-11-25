import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCommand, loginOf, parseClaudeAuth, parseOmoAuth, parseOmpAuth } from "./login.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-login-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fake = (name: string, body: string): string => {
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
};

test("login parsers: an account pool counts as signed in, garbage is unchecked", () => {
	expect(parseOmoAuth('{"status":"not_ready","provider":"anthropic-subscription","reason":"provider_not_found","accounts":[]}')).toEqual({ checked: true, ready: false, accounts: 0 });
	expect(parseOmoAuth('warn: x\n{"status":"not_ready","accounts":[{"name":"a"},{"name":"b"}]}')).toEqual({ checked: true, ready: true, accounts: 2 });
	expect(parseOmoAuth('{"status":"ready","accounts":[]}').ready).toBe(true);
	// OmO could not load its model runtime: no accounts are listed whatever the pool holds
	expect(parseOmoAuth('{"status":"invalid","provider":"anthropic-subscription","reason":"invalid_state","accounts":[]}')).toEqual({ checked: true, ready: false, accounts: 0, broken: true });
	expect(parseOmoAuth("Error: unknown command").checked).toBe(false);
	expect(parseClaudeAuth('{\n  "loggedIn": false,\n  "authMethod": "none"\n}')).toEqual({ checked: true, ready: false, accounts: 0 });
	expect(parseClaudeAuth('{"loggedIn": true}').ready).toBe(true);
});

test("omp auth export: an empty store is checked and not ready, credentials count as accounts, garbage is unchecked", () => {
	expect(parseOmpAuth('{"version":1,"credentials":[]}')).toEqual({ checked: true, ready: false, accounts: 0 });
	expect(parseOmpAuth('{"version":1,"credentials":[{"provider":"anthropic","credential":{"type":"oauth"}},{"provider":"openai","credential":{"type":"api_key"}}]}')).toEqual({ checked: true, ready: true, accounts: 2 });
	expect(parseOmpAuth("error: no such command").checked).toBe(false);
});

test("loginOf runs omp auth export, keeps only the count and never echoes a token", async () => {
	const signedIn = fake("omp-in", `[ "$1 $2" = "auth export" ] && echo '{"version":1,"credentials":[{"provider":"anthropic","credential":{"type":"oauth","access":"sk-secret-token"}}]}'`);
	const state = await loginOf("omp", signedIn);
	expect(state).toEqual({ checked: true, ready: true, accounts: 1 });
	expect(JSON.stringify(state)).not.toContain("secret");
	const empty = fake("omp-out", `[ "$1 $2" = "auth export" ] && echo '{"version":1,"credentials":[]}'`);
	expect(await loginOf("omp", empty)).toEqual({ checked: true, ready: false, accounts: 0 });
});

test("loginOf is unchecked, never throws, for a missing CLI, a runtime without a check and a CLI that fails", async () => {
	expect(await loginOf("omp", undefined)).toEqual({ checked: false, ready: false, accounts: 0 });
	expect(await loginOf("codex", fake("codex", "echo ok"))).toEqual({ checked: false, ready: false, accounts: 0 });
	expect(await loginOf("omp", join(dir, "does-not-exist"))).toEqual({ checked: false, ready: false, accounts: 0 });
	expect((await loginOf("claude", fake("claude-bad", "echo oops; exit 1"))).checked).toBe(false);
});

test("loginCommand names the terminal command of each runtime", () => {
	expect(loginCommand("omp")).toBe("omp login");
	expect(loginCommand("claude")).toBe("claude auth login");
	expect(loginCommand("omo")).toBe("omo");
	expect(loginCommand("codex")).toBe("");
});
