// The providers screen under OmO: omp's own store can be empty (the mac mini, 2026-10-22: `omp models --json` -> 0 models,
// `omp auth export` -> no credentials) while OmO runs on its auth.json login, so the list comes from OmO's store.
import { expect, test } from "bun:test";
import { buildProviders, omoAuthInfos, omoModels } from "./providers.ts";

// The mac mini's auth.json shape: only the Claude subscription login (secrets replaced).
const mini = { "anthropic-subscription": { type: "oauth", access: "x", refresh: "x", expires: 1, accounts: [{ name: "imported-anthropic" }, { name: "miseol-shared" }], pinned: "imported-anthropic" } };
const table = [
	"provider                    model                      context  max-out  thinking  images",
	"anthropic                   claude-opus-5-5            1M       128K     yes       yes   ",
	"anthropic-subscription      claude-opus-5-5            1M       128K     yes       yes   ",
	"anthropic-subscription      claude-haiku-4-5           200K     64K      no        yes   ",
	"openrouter                  openai/gpt-5               400K     128K     yes       yes   ",
].join("\n");

test("a machine whose only login is OmO's Claude subscription lists anthropic with its models", () => {
	const auth = omoAuthInfos(mini);
	const models = omoModels(table, mini, {});
	expect(auth).toEqual([{ provider: "anthropic", type: "oauth", label: "imported-anthropic", masked: undefined }]);
	expect(models.map(m => m.selector)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5"]);
	expect(models.map(m => m.reasoning)).toEqual([true, false]);
	const { providers } = buildProviders({ auth, env: {}, models, catalog: [], inUse: new Set(["anthropic"]) });
	expect(providers).toMatchObject([{ id: "anthropic", auth: "oauth", account: "imported-anthropic", models: 2, in_use: true, can_logout: true }]);
});

test("an API key in auth.json or in the environment adds that provider; OmO's own anthropic key stays behind the subscription", () => {
	const auth = { ...mini, anthropic: { type: "api_key", key: "sk-ant-abcdefghijkl" }, openrouter: { type: "api_key", key: "or-abcdefghijkl" } };
	expect(omoAuthInfos(auth).map(a => a.provider)).toEqual(["anthropic", "openrouter"]);
	expect(omoModels(table, auth, {}).map(m => m.selector)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5", "openrouter/openai/gpt-5"]);
	expect(omoModels(table, {}, { OPENROUTER_API_KEY: "or-abcdefghijkl" }).map(m => m.selector)).toEqual(["openrouter/openai/gpt-5"]);
});

test("without a subscription OmO's anthropic key is the anthropic provider; no login lists nothing", () => {
	const keyOnly = { anthropic: { type: "api_key", key: "sk-ant-abcdefghijkl" } };
	expect(omoModels(table, keyOnly, {}).map(m => m.selector)).toEqual(["anthropic/claude-opus-5-5"]);
	expect(omoAuthInfos(keyOnly)).toMatchObject([{ provider: "anthropic", type: "api_key", masked: "sk-…ijkl" }]);
	expect(omoModels(table, undefined, {})).toEqual([]);
	expect(omoAuthInfos(undefined)).toEqual([]);
});

test("an OmO-only install offers no web login: the row says how to log in on this computer, and login-only providers are not offered under 추가", () => {
	const catalog = [{ id: "anthropic", name: "Anthropic (Claude Pro/Max)" }, { id: "openai", name: "OpenAI" }, { id: "github-copilot", name: "GitHub Copilot" }];
	const auth = omoAuthInfos(mini);
	const omo = buildProviders({ auth, env: {}, models: [], catalog, inUse: new Set(["anthropic"]), webLogin: false });
	const a = omo.providers.find(p => p.id === "anthropic")!;
	expect(a.can_login).toBe(false);
	expect(a.login_hint).toBe("/login anthropic");
	expect(omo.addable.map(p => p.id)).not.toContain("github-copilot");
	expect(omo.addable.find(p => p.id === "openai")?.kind).toBe("api_key");
	const omp = buildProviders({ auth, env: {}, models: [], catalog, inUse: new Set(["anthropic"]) });
	expect(omp.providers.find(p => p.id === "anthropic")!.can_login).toBe(true);
	expect(omp.providers.find(p => p.id === "anthropic")!.login_hint).toBeUndefined();
	expect(omp.addable.map(p => p.id)).toContain("github-copilot");
});

