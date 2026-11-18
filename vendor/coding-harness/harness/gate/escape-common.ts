import { basename } from "node:path";
import type { EscapeInput } from "./types.ts";

const GIT_TIMEOUT_MS = 20_000;
const MAX_TEXT_LENGTH = 160;

/** What a child process wrote to stdout and stderr, and its exit code. */
export interface Run {
	code: number;
	out: string;
	err: string;
}

/** How a child process is bounded: it is killed after `timeoutMs`, and when `signal` aborts. `stdin` is written to it, then closed. */
export interface RunOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	stdin?: Uint8Array;
}

/** `ceiling` milliseconds, or the value of the environment variable `name` when that is a lower positive number. */
export function timeoutMs(name: string, ceiling: number): number {
	const wanted = Number(process.env[name]);
	return Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, ceiling) : ceiling;
}

/** Runs a command to completion. An aborting `signal` kills it and rejects with the abort reason; one that outlives its timeout is killed and rejects with "did not finish". The child has exited before the call settles. */
export async function run(cmd: string[], cwd: string, options: RunOptions): Promise<Run> {
	const { signal, stdin } = options;
	signal?.throwIfAborted();
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
	const proc = Bun.spawn(cmd, { cwd, env, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, options.timeoutMs);
	const onAbort = (): void => {
		proc.kill("SIGKILL");
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		signal?.throwIfAborted();
		if (timedOut) throw new Error(`escape: \`${basename(cmd[0])} ${cmd[1]}\` did not finish within ${options.timeoutMs} ms and was killed`);
		return { code, out, err };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Runs git in `repo`, bounded as `run` bounds it. */
export function git(repo: string, args: string[], signal?: AbortSignal): Promise<Run> {
	return run(["git", ...args], repo, { timeoutMs: timeoutMs("DONE_GATE_ESCAPE_GIT_TIMEOUT_MS", GIT_TIMEOUT_MS), signal });
}

/** The text of `file` in the tree of `base`; undefined when the tree has no file of that name. */
export async function gitShow(repo: string, base: string, file: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await git(repo, ["cat-file", "blob", `${base}:${file}`], signal);
	return result.code === 0 ? result.out : undefined;
}

/** What `file` held at the session's base point: the answer of `input.baseText`, else its text in the tree of `input.base`; null when it did not exist. */
export async function baseTextOf(input: EscapeInput, file: string): Promise<string | null> {
	input.signal?.throwIfAborted();
	const provided = await input.baseText?.(file);
	if (provided !== undefined) return provided;
	return (await gitShow(input.repo, input.base, file, input.signal)) ?? null;
}

/** Runs `task` over `items`, at most `limit` at a time, and returns the results in the order of `items`. The first failure aborts the signal the other tasks run under and is thrown once every task that started has ended, so no child process outlives the call. */
export async function runAll<T, R>(items: readonly T[], limit: number, signal: AbortSignal | undefined, task: (item: T, signal: AbortSignal) => Promise<R>): Promise<R[]> {
	const scope = new AbortController();
	const inner = signal === undefined ? scope.signal : AbortSignal.any([signal, scope.signal]);
	const results = new Array<R>(items.length);
	let failure: { error: unknown } | undefined;
	let next = 0;
	const worker = async (): Promise<void> => {
		while (failure === undefined && next < items.length) {
			const index = next++;
			try {
				results[index] = await task(items[index], inner);
			} catch (error) {
				failure ??= { error };
				scope.abort(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failure !== undefined) throw failure.error;
	return results;
}

/** The value of property `key` of `value`; undefined when `value` is not an object. */
export function propertyOf(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** `text` cut to the length a finding row keeps. */
export function shortened(text: string): string {
	return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 3)}...` : text;
}
