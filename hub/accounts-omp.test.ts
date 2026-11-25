import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { accountsRoute } from "./accounts-api.ts";
import { authFile } from "./apikey-policy.ts";
import { cfg, OMP } from "./config.ts";
import { forgetProviderReads } from "./providers.ts";

const spawned = `${OMP}.log`;
const runtime = cfg.runtime;
const STORE = { version: 1, credentials: [{ provider: "anthropic", credential: { type: "oauth", email: "owner@example.test", access: "secret-access" } }] };

beforeEach(() => {
	writeFileSync(OMP, `#!/bin/sh\necho "$@" >> "${spawned}"\nif [ "$1 $2" = "auth export" ]; then echo '${JSON.stringify(STORE)}'; else echo '[{"id":"anthropic","name":"Anthropic (Claude Pro/Max)"}]'; fi\n`, { mode: 0o755 });
	writeFileSync(spawned, "");
	writeFileSync(authFile(), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-stale-000000" }, opengateway: { type: "api_key", key: "og-test-000000" } }));
	forgetProviderReads();
});
afterEach(() => {
	cfg.runtime = runtime;
	for (const f of [OMP, spawned, authFile()]) rmSync(f, { force: true });
	forgetProviderReads();
});

const groups = async () => {
	const res = await accountsRoute(new Request("http://x/api/accounts"), new URL("http://x/api/accounts"));
	return ((await res!.json()) as { providers: { id: string; name: string; auth: string; accounts: { label: string }[] }[] }).providers;
};

test("on an omp install the Claude group is omp's subscription login with its email, not OmO's stale API key", async () => {
	cfg.runtime = "omp";
	const list = await groups();
	expect(list.map(g => [g.id, g.name, g.auth])).toEqual([["anthropic", "Claude 구독", "oauth"]]);
	expect(list[0]!.accounts.map(a => a.label)).toEqual(["owner@example.test"]);
	expect(JSON.stringify(list)).not.toContain("secret-access");
});

test("on an OmO install the groups stay OmO's own store and omp is never asked", async () => {
	cfg.runtime = "omo";
	const list = await groups();
	expect(list.map(g => [g.id, g.name, g.auth])).toEqual([["anthropic", "Claude API 키", "api_key"], ["opengateway", "OpenGateway", "api_key"]]);
	expect(readFileSync(spawned, "utf8")).toBe("");
});
