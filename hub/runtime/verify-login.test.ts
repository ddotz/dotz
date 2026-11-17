import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, CONFIG_FILE, DATA_DIR, setRuntime } from "../config.ts";
import { routeSettings } from "../routes-settings.ts";
import { adapters } from "./index.ts";
import { checklistFor, CHECKLIST, detectAll, lastReport, LOGIN_REFUSAL, runtimesView, UseRefused, useRuntime, verifyRuntime, verifyState, type Detected, type Probe } from "./verify.ts";
import type { RuntimeAdapter } from "./types.ts";

const SIGNED_OUT = '{"status":"not_ready","accounts":[],"credentials":[],"loggedIn":false}';
const SIGNED_IN = '{"status":"ready","accounts":[{"name":"a"}],"credentials":[{"provider":"p"}],"loggedIn":true}';
const stub = { id: "omp", caps: {}, start() { throw new Error("not used"); }, classifyError: () => undefined, recentExchanges: () => undefined } as unknown as RuntimeAdapter;
const pass: Probe = async () => ({ result: "ok", note: "ok" });
const allOk = Object.fromEntries(CHECKLIST.map(c => [c.id, pass]));

let tmp: string;
let fake: string;
let config: string;
const detect = { omp: adapters.omp!.detect, omo: adapters.omo!.detect };

const SCRIPT = `#!/bin/sh\nif [ -f "$0.in" ]; then echo '${SIGNED_IN}'; else echo '${SIGNED_OUT}'; fi\n`;
const signIn = () => writeFileSync(`${fake}.in`, "");

beforeEach(async () => {
	tmp = mkdtempSync(join(tmpdir(), "dotz-verify-login-"));
	fake = join(tmp, "fake-cli");
	writeFileSync(fake, SCRIPT);
	chmodSync(fake, 0o755);
	config = readFileSync(CONFIG_FILE, "utf8");
	for (const id of ["omp", "omo"] as const) adapters[id]!.detect = async () => ({ installed: true, version: "1.0.0", path: fake });
	await detectAll(true);
});

afterEach(async () => {
	for (const id of ["omp", "omo"] as const) adapters[id]!.detect = detect[id];
	await detectAll(true);
	writeFileSync(CONFIG_FILE, config);
	rmSync(join(DATA_DIR, "runtime-checks"), { recursive: true, force: true });
	rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
	const url = new URL(`http://x${path}`);
	const res = (await routeSettings(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }), url, url.pathname.split("/").slice(1)))!;
	return { status: res.status, body: (await res.json()) as Record<string, any> };
};

test("GET /api/runtimes/:id/login asks the CLI every time and carries the command that signs in", async () => {
	expect((await call("GET", "/api/runtimes/omp/login")).body).toEqual({ id: "omp", checked: true, ready: false, accounts: 0, command: "omp login" });
	signIn();
	expect((await call("GET", "/api/runtimes/omp/login")).body).toMatchObject({ checked: true, ready: true, accounts: 1 });
	expect((await call("GET", "/api/runtimes/omo/login")).body.command).toBe("omo");
});

test("a check is refused with login_required before any paid session starts", async () => {
	const out = await call("POST", "/api/runtimes/omp/verify", { real: true });
	expect(out.status).toBe(409);
	expect(out.body).toMatchObject({ login_required: true, error: LOGIN_REFUSAL, command: "omp login" });
	expect(verifyState("omp")).toBeUndefined();
});

test("the switch is refused while signed out even with a passing report, then applies to the config file only", async () => {
	await verifyRuntime("omp", { adapter: stub, probes: allOk, version: "1.0.0" });
	expect(lastReport("omp")?.verdict).toBe("ok");
	const refused = await call("POST", "/api/runtimes/omp/use", { roles: ["orchestrator", "lanes"] });
	expect(refused.status).toBe(409);
	expect(refused.body.error).toBe(LOGIN_REFUSAL);
	expect(readFileSync(CONFIG_FILE, "utf8")).toBe(config);
	signIn();
	const done = await call("POST", "/api/runtimes/omp/use", { roles: ["orchestrator", "lanes"] });
	expect(done.status).toBe(200);
	expect(done.body.applies).toContain("게이트웨이를 다시 시작하면");
	expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).orchestrator.runtime).toBe("omp");
	expect(cfg.orchestrator?.runtime).toBeUndefined();
});

test("the default runtime stays switchable signed out: OmO is accepted as it was before the login gate", async () => {
	const view = await runtimesView(true);
	const omo = view.runtimes.find(r => r.id === "omo")!;
	expect(omo.login).toEqual({ checked: true, ready: false, accounts: 0, command: "omo" });
	expect(omo.switchable).toBe(true);
	expect(omo.refusal).toBeNull();
	expect(await useRuntime("omo", ["lanes"])).toEqual(["lanes"]);
	expect(view.runtimes.find(r => r.id === "omp")!.refusal).toBe(LOGIN_REFUSAL);
});

test("the view separates what runs now from what the next start applies", async () => {
	setRuntime(["orchestrator", "lanes"], "omo");
	const ready = async () => ({ checked: true, ready: true, accounts: 1 });
	await verifyRuntime("omp", { adapter: stub, probes: allOk, version: "1.0.0" });
	const detected = [{ id: "omp", label: "omp", installed: true, version: "1.0.0", hasAdapter: true, usable: true }] as Detected[];
	await useRuntime("omp", ["orchestrator"], detected, await ready());
	const view = await runtimesView(true, ready);
	expect(view.current).toEqual({ orchestrator: "omo", lanes: "omo" });
	expect(view.pending).toEqual({ orchestrator: "omp", lanes: "omo" });
	expect(view.restart_needed).toBe(true);
	expect(view.runtimes.find(r => r.id === "omp")).toMatchObject({ roles: [], pending_roles: ["orchestrator"] });
	expect(view.runtimes.find(r => r.id === "omo")).toMatchObject({ roles: ["orchestrator", "lanes"], pending_roles: ["lanes"] });
	setRuntime(["orchestrator"], "omo");
	expect((await runtimesView(true, ready)).restart_needed).toBe(false);
});

test("the view states the bounds of a check from the constants the check itself runs with", async () => {
	const saved = process.env.DOTZ_VERIFY_TIMEOUT_MS;
	process.env.DOTZ_VERIFY_TIMEOUT_MS = "30000";
	try {
		const ids = checklistFor("omp").map(c => c.id);
		const workers = ids.filter(id => id.startsWith("workers_")).length;
		const view = await runtimesView(true, async () => ({ checked: true, ready: true, accounts: 1 }));
		expect(view.runtimes.find(r => r.id === "omp")!.limits).toEqual({ items: ids.length, item_s: 30, worker_s: 360, max_min: Math.ceil(((ids.length - workers) * 30 + workers * 360) / 60) });
	} finally {
		if (saved === undefined) delete process.env.DOTZ_VERIFY_TIMEOUT_MS;
		else process.env.DOTZ_VERIFY_TIMEOUT_MS = saved;
	}
});
