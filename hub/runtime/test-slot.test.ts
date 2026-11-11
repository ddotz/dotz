import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import gate from "../update-gate.json";
import { isFullSuite, runLogPath } from "./test-slot.ts";

const words = (line: string) => line.split(" ");

test("a run with no file argument, a filter or many files is a full suite", () => {
	for (const line of ["bun test", "bun test --parallel=4", "bun test --isolate --timeout 20000", "bun test hub", "bun test connectors", `bun test ${Array.from({ length: 21 }, (_, i) => `f${i}.test.ts`).join(" ")}`])
		expect(isFullSuite(words(line))).toBe(true);
});

test("a run of a few named files, a worker or another command is free", () => {
	for (const line of ["bun test hub/x.test.ts", "bun test --parallel=2 hub/x.test.ts hub/y.test.ts", `bun test ${Array.from({ length: 20 }, (_, i) => `f${i}.test.ts`).join(" ")}`, "bun test -t name hub/x.test.ts", "bun test --test-worker --isolate", "bun run test", "bun hub/main.ts"])
		expect(isFullSuite(words(line))).toBe(false);
});

test("the update gate's named script is free, so it never queues past its own time limit", () => {
	expect(isFullSuite(gate.cmd)).toBe(false);
});

// A throwaway project behind the repo's real bunfig and preload: `bun test` here goes through the same path as in a lane.
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dotz-run-limit-")));
	dirs.push(cwd);
	const repo = join(import.meta.dir, "..", "..");
	const data = join(cwd, "data");
	mkdirSync(data);
	writeFileSync(join(cwd, "bunfig.toml"), readFileSync(join(repo, "bunfig.toml"), "utf8").replace("./hub/runtime/test-setup.ts", join(repo, "hub/runtime/test-setup.ts")));
	const ran = join(cwd, "ran");
	for (const [name, passes] of [["bad", false], ["good", true]] as const)
		writeFileSync(join(cwd, `${name}.test.ts`), `import { appendFileSync } from "node:fs"; import { expect, test } from "bun:test"; test("${name}", () => { appendFileSync(${JSON.stringify(ran)}, "x"); expect(${passes}).toBe(true); });`);
	const run = async (args: string[], extra: Record<string, string | undefined> = { DOTZ_LANE: "limit-test" }) => {
		const env: Record<string, string | undefined> = { ...process.env, DOTZ_DIR: data, ...extra };
		delete env.DOTZ_TEST_DIR;
		delete env.BUN_TEST_WORKER_ID; // a parallel run's worker id would make this new run read as a worker of the test process
		rmSync(ran, { force: true });
		const p = Bun.spawn([process.execPath, "test", ...args], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { code, text: out + err, ran: existsSync(ran) };
	};
	return { cwd, data, run };
}

test("the third full run of a lane in one worktree is refused and names the failed files; those files and one last run stay possible", async () => {
	const { run } = project();
	expect((await run([])).ran).toBe(true);
	expect((await run([])).ran).toBe(true);
	const third = await run([]);
	expect(third.ran).toBe(false);
	expect(third.code).not.toBe(0);
	expect(third.text).toContain("bun test bad.test.ts");
	expect(third.text).toContain("DOTZ_TEST_FINAL=1");

	const failedFile = await run(["bad.test.ts"]);
	expect(failedFile.ran).toBe(true);
	expect((await run([])).ran).toBe(false);
	const lastRun = { DOTZ_LANE: "limit-test", DOTZ_TEST_FINAL: "1" };
	expect((await run([], lastRun)).ran).toBe(true);
	expect((await run([], lastRun)).ran).toBe(false);
}, 60_000);

test("a refused --parallel run stops at once and still says why", async () => {
	const { run } = project();
	await run([]);
	await run([]);
	const refused = await run(["--parallel=2"]);
	expect(refused.ran).toBe(false);
	expect(refused.code).not.toBe(0);
	expect(refused.text).toContain("full test run refused");
}, 60_000);

test("outside a lane a full run is never limited: the gates (self-update, release, CI) have no lane", async () => {
	const { run } = project();
	for (let i = 0; i < 3; i++) expect((await run([], { DOTZ_LANE: undefined })).ran).toBe(true);
}, 60_000);

test("runs older than the window do not count", async () => {
	const { cwd, data, run } = project();
	const log = runLogPath(data, cwd);
	mkdirSync(dirname(log), { recursive: true });
	appendFileSync(log, "1000 run 11\n1000 run 12\n1000 run 13\n"); // a fixed old time: this process runs on the fake clock, the run under test on the real one
	expect((await run([])).ran).toBe(true);
}, 60_000);

test("a broken counter runs the tests", async () => {
	const { cwd, data, run } = project();
	mkdirSync(runLogPath(data, cwd), { recursive: true }); // the log path is a folder: every read and write of it fails
	for (let i = 0; i < 3; i++) expect((await run([])).ran).toBe(true);
}, 60_000);
