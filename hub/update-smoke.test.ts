// The update gate is the smoke start (hub/update-gate.json -> hub/update-smoke-run.ts -> hub/update-smoke.ts): it passes on this tree,
// and fails for a tree whose gateway cannot start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateIn } from "./selfupdate-parse.ts";
import { DEFAULT_MODEL, selectorOf } from "./config.ts";
import { pageAssets, smoke, smokeOmpModel, smokeRuntime } from "./update-smoke.ts";

const repo = join(import.meta.dir, "..");
let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "dotz-smoke-test-"))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("the shipped gate is the smoke run, at most 5 minutes", () => {
	expect(gateIn(repo)).toEqual({ cmd: ["bun", "test", "./hub/update-smoke-run.ts"], ms: 5 * 60_000 });
});

test("the gateway of this tree starts, serves the page with its scripts and styles and answers the read-only API", async () => {
	const r = await smoke(repo);
	expect(r.ok ? "" : `${r.why}\n${r.out}`).toBe("");
	if (r.ok) expect(r.checked).toEqual(expect.arrayContaining(["/api/health", "/", "/app.js", "/app.css", "/api/state", "/api/notices"]));
}, 60_000);

test("a tree whose hub module does not parse fails the smoke check with the gateway's output", async () => {
	mkdirSync(join(tmp, "hub"));
	writeFileSync(join(tmp, "hub", "main.ts"), 'import "./broken.ts";\n');
	writeFileSync(join(tmp, "hub", "broken.ts"), "export const = ;\n");
	const r = await smoke(tmp);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.why).toContain("exited before it answered");
		expect(r.out).toContain("broken.ts");
	}
});

test("pageAssets lists local scripts and stylesheets only", () => {
	const html = '<link rel="manifest" href="/m.json"><link rel="stylesheet" href="/app.css"><script>inline()</script><script src="/app.js"></script><script src="https://x.test/a.js"></script>';
	expect(pageAssets(html)).toEqual(["/app.js", "/app.css"]);
});

const STATE = '{"id":"state","type":"response","command":"get_state","success":true,"data":{"systemPrompt":["- harness_doctor — guard"],"dumpTools":[{"name":"harness_doctor"}]}}';
const COMMANDS = '{"id":"commands","type":"response","command":"get_available_commands","success":true,"data":{"commands":[]}}';
const fakeOmp = (body: string): string => {
	const file = join(tmp, "fake-omp");
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
};

test("smokeRuntime: omp for either role or the top-level key, nothing for another runtime or an unreadable config", () => {
	const at = (config: unknown) => {
		const dir = mkdtempSync(join(tmp, "data-"));
		writeFileSync(join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
		return smokeRuntime(dir);
	};
	expect(at({ orchestrator: { runtime: "omp" } })).toBe("omp");
	expect(at({ lanes: { runtime: "omp" } })).toBe("omp");
	expect(at({ runtime: "omp" })).toBe("omp");
	expect(at({ runtime: "omp", orchestrator: { runtime: "claude" }, lanes: { runtime: "claude" } })).toBeUndefined();
	expect(at({ orchestrator: { runtime: "omo" } })).toBeUndefined();
	expect(at("{not json")).toBeUndefined();
	expect(smokeRuntime(join(tmp, "missing"))).toBeUndefined();
});

// The gate runs under the test preload, whose config names models omp does not know: the omp smoke must take the owner's model from disk.
test("smokeOmpModel: the owner's orchestrator model from the data dir, never the test config's; the shipped default without one", async () => {
	const at = (config: unknown) => {
		const dir = mkdtempSync(join(tmp, "data-"));
		writeFileSync(join(dir, "config.json"), JSON.stringify(config));
		return smokeOmpModel(dir);
	};
	expect(await at({ models: { orchestrator: { model: "anthropic/claude-opus-5-5", thinking: "high" } } })).toBe("anthropic/claude-opus-5-5:high");
	expect(await at({ runtime: "omp" })).toBe(selectorOf(DEFAULT_MODEL));
	expect(await smokeOmpModel(join(tmp, "missing"))).toBe(selectorOf(DEFAULT_MODEL));
	expect(await at({ models: { orchestrator: { model: "anthropic/claude-sonnet-5-5" } } })).toMatch(/^anthropic\/claude-sonnet-5-5:\w+$/);
	expect(await at({})).not.toContain("test-orch");
});

test("with omp as the runtime the smoke also starts omp from this tree and passes when the dotz extension loads", async () => {
	const r = await smoke(repo, { runtime: "omp", omp: fakeOmp(`cat >/dev/null\necho '${STATE}'\necho '${COMMANDS}'`) });
	expect(r.ok ? "" : `${r.why}\n${r.out}`).toBe("");
	if (r.ok) expect(r.checked).toContain("omp:guard_extension");
}, 60_000);

test("with omp as the runtime the smoke fails for an omp that cannot start, one that never answers and one without the guard tool", async () => {
	const dead = await smoke(repo, { runtime: "omp", omp: join(tmp, "no-such-omp") });
	expect(dead.ok).toBe(false);
	if (!dead.ok) expect(dead.why).toContain("did not answer get_state (exit 127)");
	const silent = await smoke(repo, { runtime: "omp", omp: fakeOmp("exec sleep 60"), ompMs: 500 });
	expect(silent.ok).toBe(false);
	if (!silent.ok) expect(silent.why).toContain("did not answer get_state within");
	const bare = await smoke(repo, { runtime: "omp", omp: fakeOmp(`cat >/dev/null\necho '${STATE.replaceAll("harness_doctor", "read")}'\necho '${COMMANDS}'`) });
	expect(bare.ok).toBe(false);
	if (!bare.ok) expect(bare.why).toContain("harness_doctor is not registered");
	const missing = await smoke(repo, { runtime: "omp" });
	expect(missing.ok).toBe(false);
	if (!missing.ok) expect(missing.why).toContain("omp is not on PATH");
}, 120_000);
