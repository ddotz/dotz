// A web login on an OmO install goes through OmO's RPC (hub/runtime/omo-login.ts), driven here by a fake `omo --mode rpc` that speaks
// the same frames (login_start -> auth_login_url + an input prompt -> extension_ui_response -> auth_login_end) and, like OmO, adds the
// login to auth.json as a new `login-N` account. Every auth.json is a throwaway one; nothing real is spawned.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { cancelLogin, completeLogin, listProviders, loginStatus, pendingLogin, startLogin } from "./providers.ts";
import { omoRpcCommand } from "./runtime/omo-login.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-omo-login-"));
const fake = join(dir, "fake-omo.ts");
const spawned = join(dir, "spawned.log");
writeFileSync(spawned, "");
writeFileSync(
	fake,
	`import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(spawned)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const auth = process.env.OMO_CODING_AGENT_DIR + "/auth.json";
const mode = process.env.FAKE_OMO_MODE || "ok";
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "extension_ui_request", id: "n1", method: "notify", message: "startup noise" });
let provider = "";
for await (const line of console) {
	const c = JSON.parse(line);
	if (c.type === "get_auth_providers") out({ id: c.id, type: "response", command: c.type, success: true, data: { providers: [
		{ id: "anthropic-subscription", name: "Anthropic Subscription (Claude Pro/Max)", authType: "oauth" },
		{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth" },
		{ id: "openai", name: "OpenAI", authType: "api_key" }] } });
	else if (c.type === "login_start") {
		provider = c.provider;
		out({ id: c.id, type: "response", command: c.type, success: true });
		if (mode === "claude") out({ type: "extension_ui_request", id: "ask-name", method: "input", title: "Name for this account (existing: default, work; press Enter to add account-3, or type an existing name to refresh it)", placeholder: "account-3" });
		else {
			out({ type: "auth_login_url", provider, url: "https://claude.ai/oauth/authorize?state=fake" });
			out({ type: "extension_ui_request", id: "ask-1", method: "input", title: "Complete login in your browser, or paste the authorization code / redirect URL here:" });
		}
	} else if (c.type === "extension_ui_response" && c.id === "ask-name") out({ type: "extension_ui_request", id: "ask-method", method: "select", title: "Select Anthropic login method:", options: ["Browser login (default)", "Copy code login (headless)"] });
	else if (c.type === "extension_ui_response" && c.id === "ask-method") {
		out({ type: "auth_login_url", provider, url: "https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fake" });
		out({ type: "extension_ui_request", id: "ask-1", method: "input", title: "Paste the code Anthropic shows after you sign in:", placeholder: "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fake" });
	} else if (c.type === "extension_ui_response" && c.id === "ask-1") {
		if (mode === "error") { out({ type: "auth_login_end", provider, success: false, error: "Invalid authorization code" }); continue; }
		const a = JSON.parse(readFileSync(auth, "utf8"));
		const s = a[provider];
		const taken = new Set(s.accounts.map(x => x.name));
		let n = 2;
		while (taken.has("login-" + n)) n++;
		// a Claude login OmO stores under a fresh name; FAKE_OMO_EMAIL is the mail on its profile. "relogin" names a stored slot.
		const email = process.env.FAKE_OMO_EMAIL;
		if (mode === "relogin") s.accounts[0].access = "new-" + c.value;
		else s.accounts.push({ name: "login-" + n, source: "login", access: "new-" + c.value, refresh: "r", expires: 1, ...(email ? { dirId: "fresh", profile: { email } } : {}) });
		if (mode === "clobber") s.pinned = "login-" + n;
		writeFileSync(auth, JSON.stringify(a, null, 2));
		out({ type: "auth_login_end", provider, success: true });
	} else if (c.type === "login_cancel") out({ type: "auth_login_end", provider: c.provider, success: false, error: "Login cancelled" });
}
`,
);

const realArgv = omoRpcCommand.argv;
const agentDir = process.env.OMO_CODING_AGENT_DIR;
const runtime = cfg.runtime;
let auth = "";
const sub = () => JSON.parse(readFileSync(auth, "utf8"))["anthropic-subscription"];
const spawns = () => readFileSync(spawned, "utf8").trim().split("\n").filter(Boolean).length;

beforeEach(() => {
	omoRpcCommand.argv = () => [process.execPath, fake];
	process.env.OMO_CODING_AGENT_DIR = mkdtempSync(join(dir, "agent-"));
	auth = join(process.env.OMO_CODING_AGENT_DIR, "auth.json");
	writeFileSync(auth, JSON.stringify({ "anthropic-subscription": { type: "oauth", access: "a", refresh: "r", expires: 1, accounts: [{ name: "default", access: "a", refresh: "r", expires: 1 }, { name: "work", access: "b", refresh: "r", expires: 1 }], pinned: "work" } }, null, 2));
	delete process.env.FAKE_OMO_MODE;
	delete process.env.FAKE_OMO_EMAIL;
});
afterEach(async () => {
	const p = pendingLogin();
	if (p) await cancelLogin(p.provider);
	omoRpcCommand.argv = realArgv;
	process.env.OMO_CODING_AGENT_DIR = agentDir;
	cfg.runtime = runtime;
});
afterAll(() => {
	omoRpcCommand.argv = realArgv;
});

test("on OmO, 추가 lists OmO's OAuth logins and the signed-in Claude row offers 계정 추가", async () => {
	const { providers, addable } = await listProviders(new Set());
	expect(addable.filter(a => a.kind === "oauth").map(a => a.id)).toContain("github-copilot");
	expect(addable.map(a => a.id)).not.toContain("anthropic-subscription");
	const a = providers.find(p => p.id === "anthropic")!;
	expect(a).toMatchObject({ auth: "oauth", account: "work", accounts: 2, can_login: true, can_add_account: true });
});

test("start -> URL -> pasted code adds a second, then a third account; the old accounts and the pin stay", async () => {
	const r = await startLogin("anthropic");
	expect(r.url).toBe("https://claude.ai/oauth/authorize?state=fake");
	expect(r.needs_code).toBe(true);
	expect(r.prompt).toContain("authorization code");
	expect(await completeLogin("anthropic", r.login_id, "code-1")).toEqual({ provider: "anthropic", status: "done", outcome: "added", account: "login-2" });
	expect(loginStatus("anthropic", r.login_id).status).toBe("done");
	expect(sub().accounts.map((x: { name: string }) => x.name)).toEqual(["default", "work", "login-2"]);
	expect(sub().pinned).toBe("work");
	const again = await startLogin("anthropic");
	await completeLogin("anthropic", again.login_id, "code-2");
	expect(sub().accounts.map((x: { name: string }) => x.name)).toEqual(["default", "work", "login-2", "login-3"]);
	expect(sub().accounts[0].access).toBe("a");
	expect(sub().pinned).toBe("work");
	expect((await listProviders(new Set())).providers.find(p => p.id === "anthropic")).toMatchObject({ accounts: 4, account: "work" });
});

test("Claude's name and method questions come first; the page to open is the code page from its paste prompt", async () => {
	process.env.FAKE_OMO_MODE = "claude";
	const r = await startLogin("anthropic");
	expect(r).toMatchObject({ url: "", needs_code: true });
	expect(r.prompt).toContain("Name for this account");
	const method = await completeLogin("anthropic", r.login_id, "account-3");
	expect(method).toMatchObject({ status: "waiting", url: "", options: ["Browser login (default)", "Copy code login (headless)"] });
	const paste = await completeLogin("anthropic", r.login_id, "Browser login (default)");
	expect(paste).toMatchObject({ status: "waiting", needs_code: true, url: "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fake" });
	expect(await completeLogin("anthropic", r.login_id, "code-1")).toMatchObject({ provider: "anthropic", status: "done" });
	expect(sub().accounts.map((x: { name: string }) => x.name)).toEqual(["default", "work", "login-2"]);
});

const loginWith = async (code: string) => {
	const { login_id } = await startLogin("anthropic");
	return { login_id, done: await completeLogin("anthropic", login_id, code) };
};

test("a login of a new account says it was added", async () => {
	process.env.FAKE_OMO_EMAIL = "new@example.test";
	const { login_id, done } = await loginWith("code-new");
	expect(done).toMatchObject({ status: "done", outcome: "added", account: "login-2" });
	expect(loginStatus("anthropic", login_id)).toMatchObject({ status: "done", outcome: "added", account: "login-2" });
	expect(sub().accounts.map((a: { name: string }) => a.name)).toEqual(["default", "work", "login-2"]);
});

test("a login of the same account under a fresh name refreshes the stored slot and leaves no copy", async () => {
	const stored = JSON.parse(readFileSync(auth, "utf8"));
	stored["anthropic-subscription"].accounts[1] = { ...stored["anthropic-subscription"].accounts[1], displayName: "회사", dirId: "old", profile: { email: "same@example.test" } };
	writeFileSync(auth, JSON.stringify(stored));
	process.env.FAKE_OMO_EMAIL = "same@example.test";
	const { done } = await loginWith("code-same");
	expect(done).toMatchObject({ status: "done", outcome: "refreshed", account: "work" });
	const accounts = sub().accounts;
	expect(accounts.map((a: { name: string }) => a.name)).toEqual(["default", "work"]);
	expect(accounts[1]).toMatchObject({ name: "work", displayName: "회사", dirId: "fresh", access: "new-code-same" });
	expect(sub().pinned).toBe("work");
});

test("a login that rewrites a stored slot says it was refreshed", async () => {
	process.env.FAKE_OMO_MODE = "relogin";
	const { done } = await loginWith("code-again");
	expect(done).toMatchObject({ status: "done", outcome: "refreshed" });
	expect(sub().accounts).toHaveLength(2);
});

test("a login that moves the Claude pin gets the pin put back", async () => {
	process.env.FAKE_OMO_MODE = "clobber";
	const r = await startLogin("anthropic");
	await completeLogin("anthropic", r.login_id, "code-1");
	expect(sub().accounts.map((x: { name: string }) => x.name)).toEqual(["default", "work", "login-2"]);
	expect(sub().pinned).toBe("work");
});

test("cancel ends the login and changes nothing", async () => {
	const before = readFileSync(auth, "utf8");
	const r = await startLogin("anthropic");
	await cancelLogin("anthropic");
	expect(loginStatus("anthropic", r.login_id)).toEqual({ status: "failed", error: "로그인이 취소됐어요" });
	expect(pendingLogin()).toBeUndefined();
	expect(readFileSync(auth, "utf8")).toBe(before);
	await expect(completeLogin("anthropic", r.login_id, "late")).rejects.toThrow("취소");
});

test("a code OmO refuses fails with its reason and changes nothing", async () => {
	process.env.FAKE_OMO_MODE = "error";
	const before = readFileSync(auth, "utf8");
	const r = await startLogin("anthropic");
	await expect(completeLogin("anthropic", r.login_id, "bad")).rejects.toThrow("Invalid authorization code");
	expect(loginStatus("anthropic", r.login_id).status).toBe("failed");
	expect(readFileSync(auth, "utf8")).toBe(before);
	expect(pendingLogin()).toBeUndefined();
});

test("an omp install keeps the omp login path and never starts OmO", async () => {
	cfg.runtime = "omp";
	const n = spawns();
	await expect(startLogin("anthropic")).rejects.toThrow("로그인할 수 없는 공급자");
	expect(spawns()).toBe(n);
});
