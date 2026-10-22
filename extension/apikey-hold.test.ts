// A process given an API key (the orchestrator's fallback entry) registers it and then starts no task workers and no sessions.
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneHeld } from "./apikey-hold.ts";
import { keyProvider } from "./index.ts";

test("on the API key: the provider is registered, the key leaves the environment, task workers and sessions are refused", async () => {
	const handlers: Record<string, ((event: any) => any)[]> = {};
	const providers: string[] = [];
	const pi = { on: (name: string, fn: (event: any) => any) => (handlers[name] ??= []).push(fn), registerProvider: (id: string) => providers.push(id) };
	expect(laneHeld("launch")).toBeUndefined();
	process.env.DOTZ_KEY_PROVIDER = JSON.stringify({ id: "anthropic-apikey", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", models: [{ id: "claude-sonnet-5-5" }] });
	process.env.DOTZ_KEY_VALUE = "sk-ant-test";
	keyProvider(pi);
	expect(providers).toEqual(["anthropic-apikey"]);
	expect(process.env.DOTZ_KEY_VALUE).toBeUndefined();
	expect(handlers.before_subagent_spawn[0]({ agent: "task" })).toMatchObject({ block: true });
	expect(handlers.tool_call[0]({ toolName: "task", input: {} })).toMatchObject({ block: true });
	expect(handlers.tool_call[0]({ toolName: "read", input: {} })).toBeUndefined();
	for (const a of ["launch", "send", "handover", "verify"]) expect(laneHeld(a)).toContain("API-key fallback");
	expect(laneHeld("list")).toBeUndefined();
	expect(laneHeld("stop")).toBeUndefined();
});

const spec = JSON.stringify({ id: "anthropic-apikey", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", models: [{ id: "claude-sonnet-5-5" }], worker: { id: "claude-sonnet-5-5" } });
const host = () => {
	const handlers: Record<string, ((event: any) => any)[]> = {};
	const providers: Array<[string, any]> = [];
	return { handlers, providers, pi: { on: (name: string, fn: (event: any) => any) => (handlers[name] ??= []).push(fn), registerProvider: (id: string, cfg: any) => providers.push([id, cfg]) } };
};

test("on the API key with workers on: task workers and sessions are allowed, the worker environment keeps the provider but never the key", () => {
	const { handlers, providers, pi } = host();
	process.env.DOTZ_KEY_PROVIDER = spec;
	process.env.DOTZ_KEY_VALUE = "sk-ant-test";
	process.env.DOTZ_KEY_WORKERS = "1";
	process.env.DOTZ_KEY_FILE = "anthropic-api-key";
	keyProvider(pi);
	expect(providers.map(p => p[0])).toEqual(["anthropic-apikey"]);
	expect(handlers.before_subagent_spawn).toBeUndefined();
	expect(handlers.tool_call).toBeUndefined();
	for (const a of ["launch", "send", "handover", "verify"]) expect(laneHeld(a)).toBeUndefined();
	expect(process.env.DOTZ_KEY_VALUE).toBeUndefined();
	expect(process.env.DOTZ_KEY_PROVIDER).toBe(spec);
	expect(process.env.DOTZ_KEY_FILE).toBe("anthropic-api-key");
});

test("an OmO task worker registers the key provider with the key read from the secrets folder, and reports its spend", () => {
	mkdirSync(join(process.env.DOTZ_DIR!, "secrets"), { recursive: true });
	writeFileSync(join(process.env.DOTZ_DIR!, "secrets", "anthropic-api-key"), "sk-ant-from-file\n");
	const { handlers, providers, pi } = host();
	process.env.DOTZ_KEY_PROVIDER = spec;
	delete process.env.DOTZ_KEY_VALUE;
	process.env.DOTZ_KEY_WORKERS = "1";
	process.env.DOTZ_KEY_FILE = "anthropic-api-key";
	keyProvider(pi, true);
	expect(providers[0][0]).toBe("anthropic-apikey");
	expect(providers[0][1].apiKey).toBe("sk-ant-from-file");
	expect(handlers.before_subagent_spawn).toBeUndefined();
	expect(handlers.turn_end).toHaveLength(1);
	// A file that is not named like an API key is never read.
	const other = host();
	process.env.DOTZ_KEY_FILE = "hub-token";
	keyProvider(other.pi, true);
	expect(other.providers).toEqual([]);
	rmSync(join(process.env.DOTZ_DIR!, "secrets", "anthropic-api-key"), { force: true });
});

test("workers off: a leftover provider variable does not keep the provider for workers", () => {
	process.env.DOTZ_KEY_PROVIDER = spec;
	process.env.DOTZ_KEY_VALUE = "sk-ant-test";
	delete process.env.DOTZ_KEY_WORKERS;
	delete process.env.DOTZ_KEY_FILE;
	const { handlers, pi } = host();
	keyProvider(pi);
	expect(handlers.before_subagent_spawn).toHaveLength(1);
	expect(laneHeld("launch")).toContain("API-key fallback");
	expect(process.env.DOTZ_KEY_PROVIDER).toBeUndefined();
});
