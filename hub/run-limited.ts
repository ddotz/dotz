// Runs an outside command with a time limit, so a hung binary cannot hold its caller and its pipes for good. The child leads its own process
// group: on the limit the whole group is killed (a helper it started cannot keep the pipes open), and the pipes are read for at most a moment
// after it exited. It never throws: a command that cannot start is code 127, one that outlived the limit is code 124 with timedOut set, so a
// timeout is told apart from a normal failure. A timeout is logged once, with the command name.
import { basename } from "node:path";
import { log } from "./config.ts";

export type Ran = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type RunOptions = { stdin?: string; cwd?: string; env?: Record<string, string | undefined> };

const PIPE_GRACE_MS = 2000;
export const TIMED_OUT_CODE = 124;

function killGroup(proc: Bun.Subprocess): void {
	try {
		process.kill(-proc.pid, "SIGKILL");
	} catch {
		proc.kill("SIGKILL"); // no group of its own (already gone): the child itself
	}
}

/** The JSON a command printed; undefined when it failed, timed out or printed something else. */
export async function runJson(argv: readonly string[], limitMs: number): Promise<unknown> {
	const r = await runLimited(argv, limitMs);
	if (r.code !== 0) return undefined;
	try {
		return JSON.parse(r.stdout);
	} catch {
		return undefined; // not JSON: the same as no answer
	}
}

export async function runLimited(argv: readonly string[], limitMs: number, opts: RunOptions = {}): Promise<Ran> {
	let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([...argv], { cwd: opts.cwd, env: opts.env, stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin), stdout: "pipe", stderr: "pipe", detached: true });
	} catch (error) {
		return { code: 127, stdout: "", stderr: (error as Error).message, timedOut: false };
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(proc);
	}, limitMs);
	const reading = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exit = await proc.exited;
	clearTimeout(timer);
	const within = () => Promise.race([reading, Bun.sleep(PIPE_GRACE_MS).then(() => undefined)]);
	let read = await within();
	if (!read) {
		killGroup(proc);
		read = await within();
	}
	if (timedOut) log(`${basename(argv[0] ?? "")}: no answer in ${Math.round(limitMs / 1000)} s, killed with its children`);
	return { code: timedOut ? TIMED_OUT_CODE : exit, stdout: read?.[0] ?? "", stderr: read?.[1] ?? "", timedOut };
}
