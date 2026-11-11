// The 2026-11-04 15:19 UTC leak: a worker's plain `bun probe.ts` (no test preload, no DOTZ_DIR) called emit("outbox", ...) and a fake draft landed in the
// owner's real web chat. Each process here is a real one with a throwaway HOME, so its default data dir is not the live one even if a guard is gone.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveEmitRefusal, testDataRefusal } from "./live-guard.ts";

const root = mkdtempSync(join(tmpdir(), "dotz-leak-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const hub = import.meta.dir;
const base = { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: tmpdir() };
const run = async (args: string[], env: Record<string, string>, cwd = root) => {
	const p = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code: await p.exited, text: out + err };
};
const probe = join(root, "probe.ts");
writeFileSync(probe, `import { emit } from "${hub}/events.ts";\nemit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: "fixture" });\nprocess.exit(0);\n`);
const outbox = join(root, ".dotz", "outbox.jsonl");
mkdirSync(join(root, ".dotz"));
copyFileSync(join(process.env.DOTZ_DIR!, "config.json"), join(root, ".dotz", "config.json"));

test("a plain script cannot write the default data dir's outbox", async () => {
	const r = await run([probe], base);
	expect(r.text).toContain("refused");
	expect(r.code).not.toBe(0);
	expect(existsSync(outbox)).toBe(false);
});

test("a deliberate run with DOTZ_ALLOW_LIVE=1 still can", async () => {
	expect((await run([probe], { ...base, DOTZ_ALLOW_LIVE: "1" })).code).toBe(0);
	expect(readFileSync(outbox, "utf8")).toContain("fixture");
	rmSync(outbox);
});

test("bun test from a folder without bunfig.toml stops before it reaches a real data dir", async () => {
	const dir = join(root, "elsewhere");
	mkdirSync(dir);
	writeFileSync(join(dir, "x.test.ts"), `import "${hub}/config.ts";\nimport { test } from "bun:test";\ntest("x", () => {});\n`);
	const r = await run(["test", "./x.test.ts"], { ...base, DOTZ_DIR: "/dotz-not-a-temp-dir" }, dir);
	expect(r.text).toContain("refused");
	expect(r.code).not.toBe(0);
});

test("the gateway entry and a temp DOTZ_DIR may write; a test run on a real dir may not", () => {
	expect(liveEmitRefusal("/Users/x/.dotz", {}, "/Users/x/Code/dotz/hub/main.ts")).toBeUndefined();
	expect(liveEmitRefusal("/tmp/d", { DOTZ_DIR: "/tmp/d" }, "/tmp/probe.ts")).toBeUndefined();
	expect(liveEmitRefusal("/Users/x/.dotz", {}, "/tmp/probe.ts")).toContain("refused");
	expect(liveEmitRefusal("/Users/x/.dotz", { DOTZ_DIR: "/Users/x/.dotz" }, "/tmp/probe.ts")).toContain("refused");
	expect(testDataRefusal("/Users/x/.dotz", { NODE_ENV: "test" })).toContain("refused");
	expect(testDataRefusal("/Users/x/.dotz", {})).toBeUndefined();
	expect(testDataRefusal("/tmp/d", { NODE_ENV: "test" })).toBeUndefined();
});

test("the preload refuses the live gateway port", async () => {
	await expect(fetch("http://127.0.0.1:7420/api/state")).rejects.toThrow("refused");
	await expect(fetch("http://localhost:7420")).rejects.toThrow("refused");
});
