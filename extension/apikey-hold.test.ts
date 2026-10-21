// A process given an API key (the orchestrator's fallback entry) registers it and then starts no task workers and no sessions.
import { expect, test } from "bun:test";
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
