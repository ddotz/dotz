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
	expect(auth).toEqual([{ provider: "anthropic", type: "oauth", label: "imported-anthropic", masked: undefined, accounts: 2 }]);
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

// OmO installs log in through OmO's RPC now (hub/providers-omo-login.test.ts), so the web offers the login there too: login-only
// providers under 추가, and 계정 추가 on a signed-in Claude subscription (it adds an account; the count shows on the row).
test("an OmO install offers web logins: login-only providers under 추가, and 계정 추가 on the Claude subscription row", () => {
	const catalog = [{ id: "anthropic", name: "Anthropic (Claude Pro/Max)" }, { id: "openai", name: "OpenAI" }, { id: "github-copilot", name: "GitHub Copilot" }];
	const auth = omoAuthInfos(mini);
	const omo = buildProviders({ auth, env: {}, models: [], catalog, inUse: new Set(["anthropic"]) });
	const a = omo.providers.find(p => p.id === "anthropic")!;
	expect(a).toMatchObject({ can_login: true, can_add_account: true, accounts: 2, account: "imported-anthropic" });
	expect(omo.addable.find(p => p.id === "github-copilot")?.kind).toBe("oauth");
	expect(omo.addable.find(p => p.id === "openai")?.kind).toBe("api_key");
	const noLogin = buildProviders({ auth, env: {}, models: [], catalog: [], inUse: new Set() });
	expect(noLogin.providers[0]).toMatchObject({ can_login: false });
	expect(noLogin.providers[0].can_add_account).toBeUndefined();
});

