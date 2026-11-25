import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { cancelLogin, completeLogin, pendingLogin } from "./providers.ts";
import { routeSettings } from "./routes-settings.ts";
import { adapters } from "./runtime/index.ts";
import { omoRpcCommand } from "./runtime/omo-login.ts";
import { detectAll, runtimesView } from "./runtime/verify.ts";

let dir: string;
let marker: string;
let spawned: string;
const realArgv = omoRpcCommand.argv;
const realDetect = adapters.omo!.detect;
const runtime = cfg.runtime;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "dotz-omo-switch-"));
	marker = join(dir, "signed-in");
	spawned = join(dir, "spawned.log");
	writeFileSync(spawned, "");
	const rpc = join(dir, "fake-rpc.ts");
	writeFileSync(
		rpc,
		`import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(spawned)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
for await (const line of console) {
	const c = JSON.parse(line);
	if (c.type === "login_start") {
		out({ id: c.id, type: "response", command: c.type, success: true });
		out({ type: "auth_login_url", provider: c.provider, url: "https://claude.ai/oauth/authorize?state=" + c.provider });
		out({ type: "extension_ui_request", id: "ask-1", method: "input", title: "Paste the code:" });
	} else if (c.type === "extension_ui_response" && c.id === "ask-1") {
		writeFileSync(${JSON.stringify(marker)}, "");
		out({ type: "auth_login_end", provider: "anthropic-subscription", success: true });
	} else if (c.type === "login_cancel") out({ type: "auth_login_end", provider: c.provider, success: false, error: "Login cancelled" });
}
`,
	);
	const check = join(dir, "fake-omo");
	writeFileSync(check, `#!/bin/sh\nif [ -f "${marker}" ]; then echo '{"status":"ready","accounts":[{"name":"default"}]}'; else echo '{"status":"not_ready","accounts":[]}'; fi\n`);
	chmodSync(check, 0o755);
	omoRpcCommand.argv = () => [process.execPath, rpc];
	adapters.omo!.detect = async () => ({ installed: true, version: "1.0.0", path: check });
	cfg.runtime = "omp";
	await detectAll(true);
});

afterEach(async () => {
	const p = pendingLogin();
	if (p) await cancelLogin(p.provider);
	omoRpcCommand.argv = realArgv;
	adapters.omo!.detect = realDetect;
	cfg.runtime = runtime;
	await detectAll(true);
	rmSync(dir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
	const url = new URL(`http://x${path}`);
	const res = (await routeSettings(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, url.pathname.split("/").slice(1)))!;
	return { status: res.status, body: (await res.json()) as Record<string, any> };
};

test("on an omp install, a login started for OmO runs OmO's RPC for its Claude subscription, and the switch screen sees it at once", async () => {
	const omo = async () => (await runtimesView(false)).runtimes.find(r => r.id === "omo")!.login;
	expect(await omo()).toMatchObject({ checked: true, ready: false });
	const start = await post("/api/providers/anthropic/login", { via: "omo" });
	expect(start.status).toBe(200);
	expect(start.body.url).toBe("https://claude.ai/oauth/authorize?state=anthropic-subscription");
	expect(readFileSync(spawned, "utf8").trim().split("\n")).toHaveLength(1);
	expect(await completeLogin("anthropic", start.body.login_id, "code-1")).toMatchObject({ status: "done" });
	expect(existsSync(marker)).toBe(true);
	expect(await omo()).toMatchObject({ checked: true, ready: true });
});

test("on an omp install, a login without `via` stays omp's and never starts OmO", async () => {
	const start = await post("/api/providers/anthropic/login", {});
	expect(start.status).not.toBe(200);
	expect(readFileSync(spawned, "utf8")).toBe("");
});
