import { execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isRecord } from "../gate/util.ts";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const LIST_TIMEOUT_MS = 5_000;
const SNAPSHOT_ID_PATTERN = /^s[0-9]+$/;
const WRITE_TIMEOUT_MS = 30_000;

/** The outcome of one ovnfs call as a value: the parsed answer, or the reason there is none. */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

/** One row of `ovnfs ls --json`: `source` is the folder's real path, `created` and `touched` are epoch milliseconds. ovnfs's own `dirty` flag is left out on purpose: it does not say whether a checkout holds work. */
export interface Row {
	readonly name: string;
	readonly path: string;
	readonly source: string;
	readonly base: string;
	readonly parent: string | undefined;
	readonly git: boolean;
	readonly created: number;
	readonly touched: number;
}

/** One snapshot of `ovnfs ls --json`: `label` is what `snap -m` was given (none when it had none), `created` is epoch milliseconds, `orphan` is true once the checkout it was taken of is removed. */
export interface Snapshot {
	readonly id: string;
	readonly checkout: string;
	readonly label: string | undefined;
	readonly created: number;
	readonly orphan: boolean;
}

/** What `ovnfs land` did to the folder's branch, or would do under `--dry-run`. `left` counts paths that stay changed in the checkout outside the landed commits; ovnfs reports none when there was nothing to land. */
export type LandOutcome =
	| { readonly kind: "landed"; readonly from: string; readonly to: string; readonly branch: string; readonly left: number }
	| { readonly kind: "nothing" }
	| { readonly kind: "moved"; readonly instruction: string }
	| { readonly kind: "dirty-folder"; readonly files: readonly string[] }
	| { readonly kind: "unknown"; readonly text: string };

interface Ran {
	readonly status: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly failure: string | undefined;
}

function ran(args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number }): Promise<Ran> {
	const { promise, resolve } = Promise.withResolvers<Ran>();
	execFile("ovnfs", [...args], { cwd: options.cwd, env: childEnv(), encoding: "utf8", timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
		if (error === null) {
			resolve({ status: 0, stdout, stderr, failure: undefined });
			return;
		}
		const code: unknown = (error as NodeJS.ErrnoException).code;
		if (typeof code === "number") resolve({ status: code, stdout, stderr, failure: undefined });
		else if (error.killed) resolve({ status: undefined, stdout, stderr, failure: `ovnfs ${args[0]} did not answer in ${options.timeoutMs} ms` });
		else resolve({ status: undefined, stdout, stderr, failure: `ovnfs ${args[0]} could not run: ${error.message}` });
	});
	return promise;
}

function childEnv(): NodeJS.ProcessEnv {
	return { ...process.env, NO_COLOR: "1" };
}

function reasonOf(result: Ran): string {
	if (result.failure !== undefined) return result.failure;
	const text = `${result.stderr}\n${result.stdout}`.trim();
	return text === "" ? `ovnfs exited ${result.status}` : text;
}

function realOrSame(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function millis(value: unknown): number {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

function rowOf(value: unknown): Row | undefined {
	if (!isRecord(value)) return undefined;
	const { name, path, source, base, parent, git, created, touched } = value;
	if (typeof name !== "string" || typeof path !== "string" || typeof source !== "string") return undefined;
	return {
		name,
		path,
		source: realOrSame(source),
		base: typeof base === "string" ? base : "",
		parent: typeof parent === "string" ? parent : undefined,
		git: git === true,
		created: millis(created),
		touched: millis(touched),
	};
}

function parseRows(text: string): Result<Row[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, why: `ovnfs ls printed text that is not JSON: ${(error as Error).message}` };
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.checkouts)) return { ok: false, why: "ovnfs ls JSON has no checkouts array" };
	const rows: Row[] = [];
	for (const value of parsed.checkouts) {
		const row = rowOf(value);
		if (row !== undefined) rows.push(row);
	}
	return { ok: true, value: rows };
}

function snapshotOf(value: unknown): Snapshot | undefined {
	if (!isRecord(value)) return undefined;
	const { id, checkout, label, created, orphan } = value;
	if (typeof id !== "string" || typeof checkout !== "string") return undefined;
	return { id, checkout, label: typeof label === "string" ? label : undefined, created: millis(created), orphan: orphan === true };
}

function parseSnapshots(text: string): Result<Snapshot[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, why: `ovnfs ls printed text that is not JSON: ${(error as Error).message}` };
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.snapshots)) return { ok: false, why: "ovnfs ls JSON has no snapshots array" };
	const found: Snapshot[] = [];
	for (const value of parsed.snapshots) {
		const snapshot = snapshotOf(value);
		if (snapshot !== undefined) found.push(snapshot);
	}
	return { ok: true, value: found };
}

function validName(name: string): Result<string> {
	return NAME_PATTERN.test(name) ? { ok: true, value: name } : { ok: false, why: `not a usable checkout name: ${JSON.stringify(name)}` };
}

function validSnapshotId(id: string): Result<string> {
	return SNAPSHOT_ID_PATTERN.test(id) ? { ok: true, value: id } : { ok: false, why: `not a usable snapshot id: ${JSON.stringify(id)}` };
}

/** Every checkout ovnfs knows, `ovnfs ls --json`; a failure or an unparsable answer is `ok: false`. */
export async function list(timeoutMs: number = LIST_TIMEOUT_MS): Promise<Result<Row[]>> {
	const result = await ran(["ls", "--json"], { timeoutMs });
	if (result.status !== 0) return { ok: false, why: reasonOf(result) };
	return parseRows(result.stdout);
}

/** The same listing, blocking, for callers that cannot await (`whereis`). */
export function listSync(timeoutMs: number): Result<Row[]> {
	const result = spawnSync("ovnfs", ["ls", "--json"], { env: childEnv(), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES });
	if (result.error !== undefined) {
		const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		return { ok: false, why: timedOut ? `ovnfs ls did not answer in ${timeoutMs} ms` : `ovnfs ls could not run: ${result.error.message}` };
	}
	if (result.status !== 0) return { ok: false, why: reasonOf({ status: result.status ?? undefined, stdout: result.stdout, stderr: result.stderr, failure: undefined }) };
	return parseRows(result.stdout);
}

/** Opens checkout `name` on `folder` as it is now (`ovnfs new --name`); the value is the checkout's path. */
export async function newCheckout(folder: string, name: string): Promise<Result<string>> {
	const valid = validName(name);
	if (!valid.ok) return valid;
	const result = await ran(["new", "--name", name, folder], { cwd: folder, timeoutMs: WRITE_TIMEOUT_MS });
	if (result.status !== 0) return { ok: false, why: reasonOf(result) };
	const path = result.stdout.trim().split("\n")[0] ?? "";
	return path.startsWith("/") ? { ok: true, value: path } : { ok: false, why: `ovnfs new printed no path: ${JSON.stringify(result.stdout)}` };
}

/**
 * Removes checkout `name` without `--force`: ovnfs itself refuses when the checkout holds commits its folder lacks, and that refusal is `ok: false`.
 * With `stickySnapshots` the snapshots taken of the checkout stay behind as orphans (`--sticky-snapshots`) instead of going with it.
 */
export async function removeCheckout(name: string, options: { readonly stickySnapshots?: boolean } = {}): Promise<Result<undefined>> {
	const valid = validName(name);
	if (!valid.ok) return valid;
	const result = await ran(options.stickySnapshots === true ? ["rm", "--sticky-snapshots", name] : ["rm", name], { timeoutMs: WRITE_TIMEOUT_MS });
	return result.status === 0 ? { ok: true, value: undefined } : { ok: false, why: reasonOf(result) };
}

/** Takes a snapshot of checkout `name`'s whole state, ignored and untracked files included, with `label` (`ovnfs snap -m --json`); the value is the snapshot id. */
export async function snap(name: string, label: string): Promise<Result<string>> {
	const valid = validName(name);
	if (!valid.ok) return valid;
	const result = await ran(["snap", name, "-m", label, "--json"], { timeoutMs: WRITE_TIMEOUT_MS });
	if (result.status !== 0) return { ok: false, why: reasonOf(result) };
	let reply: unknown;
	try {
		reply = JSON.parse(result.stdout);
	} catch {
		return { ok: false, why: `ovnfs snap printed text that is not JSON: ${JSON.stringify(result.stdout)}` };
	}
	const taken = isRecord(reply) && isRecord(reply.snapshot) ? reply.snapshot.id : undefined;
	return typeof taken === "string" && taken !== "" ? { ok: true, value: taken } : { ok: false, why: `ovnfs snap printed no snapshot id: ${JSON.stringify(result.stdout)}` };
}

/** Releases snapshot `id` (`ovnfs drop`). */
export async function drop(id: string): Promise<Result<undefined>> {
	const valid = validSnapshotId(id);
	if (!valid.ok) return valid;
	const result = await ran(["drop", id], { timeoutMs: WRITE_TIMEOUT_MS });
	return result.status === 0 ? { ok: true, value: undefined } : { ok: false, why: reasonOf(result) };
}

/** The snapshots of `ovnfs ls --json`; a failure or an answer without a snapshots array is `ok: false`. */
export async function snapshots(timeoutMs: number = LIST_TIMEOUT_MS): Promise<Result<Snapshot[]>> {
	const result = await ran(["ls", "--json"], { timeoutMs });
	if (result.status !== 0) return { ok: false, why: reasonOf(result) };
	return parseSnapshots(result.stdout);
}

function leftOf(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function conflictPaths(conflicts: unknown): string[] {
	if (!Array.isArray(conflicts)) return [];
	const paths: string[] = [];
	for (const conflict of conflicts) if (isRecord(conflict) && typeof conflict.path === "string") paths.push(conflict.path);
	return paths;
}

function parseLand(result: Ran): LandOutcome {
	const text = reasonOf(result);
	let reply: unknown;
	try {
		reply = JSON.parse(result.stdout);
	} catch {
		reply = undefined;
	}
	if (isRecord(reply)) {
		const files = conflictPaths(reply.conflicts);
		if (reply.refused === true || files.length > 0) return { kind: "dirty-folder", files };
		const { commit, old, branch } = reply;
		if (typeof commit === "string" && typeof old === "string" && typeof branch === "string") {
			return commit === old ? { kind: "nothing" } : { kind: "landed", from: old, to: commit, branch, left: leftOf(reply.left) };
		}
		return { kind: "unknown", text };
	}
	if (result.failure === undefined && /^conflict:.*\brebase\b/s.test(text)) return { kind: "moved", instruction: text };
	return { kind: "unknown", text };
}

/**
 * Lands checkout `name`'s commits on the branch checked out in `folder` (`ovnfs land --json`), or only reports what it would do when `dryRun`.
 * ovnfs answers a refusal with a nonzero exit and its text on stderr; the text, not the exit code, picks the result.
 */
export async function land(name: string, folder: string, options: { readonly dryRun: boolean }): Promise<LandOutcome> {
	const valid = validName(name);
	if (!valid.ok) return { kind: "unknown", text: valid.why };
	const args = ["land", ...(options.dryRun ? ["--dry-run"] : []), "--json", name];
	return parseLand(await ran(args, { cwd: folder, timeoutMs: WRITE_TIMEOUT_MS }));
}
