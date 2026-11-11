import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLimited, TIMED_OUT_CODE } from "./run-limited.ts";
import { advance } from "./runtime/test-clock.ts";

// The test preload replaces setTimeout with a manual clock: the child is a real process, and moving the clock past the limit is what ends it.
const LIMIT_MS = 300;

const stateOf = async (pid: string): Promise<string> => {
	const ps = Bun.spawn(["ps", "-o", "stat=", "-p", pid], { stdout: "pipe", stderr: "ignore" });
	const state = (await new Response(ps.stdout).text()).trim();
	await ps.exited;
	return state;
};

test("a child that outlives the limit is killed and reported as a timeout", async () => {
	const running = runLimited(["sleep", "30"], LIMIT_MS);
	await advance(LIMIT_MS);
	const r = await running;
	expect(r.timedOut).toBe(true);
	expect(r.code).toBe(TIMED_OUT_CODE);
});

test("a helper the child started dies with it, so the pipes close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-run-limited-"));
	try {
		const fifo = join(dir, "pid");
		await Bun.spawn(["mkfifo", fifo]).exited;
		const running = runLimited(["sh", "-c", 'sleep 30 & echo $! > "$1"; wait', "sh", fifo], LIMIT_MS);
		const reader = Bun.spawn(["cat", fifo], { stdout: "pipe" });
		const helper = (await new Response(reader.stdout).text()).trim();
		expect(helper).toMatch(/^\d+$/);
		await advance(LIMIT_MS);
		expect((await running).timedOut).toBe(true);
		const state = await stateOf(helper);
		expect(state === "" || state.startsWith("Z")).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a normal exit keeps its output and is not a timeout", async () => {
	const r = await runLimited(["sh", "-c", "echo out; echo err >&2"], LIMIT_MS);
	expect(r).toEqual({ code: 0, stdout: "out\n", stderr: "err\n", timedOut: false });
});

test("a failing command keeps its own code and is not a timeout", async () => {
	const r = await runLimited(["sh", "-c", "echo bad >&2; exit 3"], LIMIT_MS);
	expect(r.code).toBe(3);
	expect(r.stderr).toBe("bad\n");
	expect(r.timedOut).toBe(false);
});

test("a command that cannot start is code 127, not a timeout and not a throw", async () => {
	const r = await runLimited(["/nonexistent/dotz-no-such-binary"], LIMIT_MS);
	expect(r.code).toBe(127);
	expect(r.timedOut).toBe(false);
});

test("stdin text reaches the command", async () => {
	expect((await runLimited(["cat"], LIMIT_MS, { stdin: "hello" })).stdout).toBe("hello");
});
