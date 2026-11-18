import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { matchesAny } from "./gate-file.ts";
import { isRecord } from "./util.ts";

const MAX_HASHED_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const HASH_CONCURRENCY = 8;
const execFileAsync = promisify(execFile);

/** The tree git reports for a repo with no commits; a valid base for a diff in any repository. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The repo at one moment: HEAD, its tree, and a content hash for every dirty file ("none" for HEAD of a repo without commits). */
export interface Snapshot {
	head: string;
	tree: string;
	dirty: Record<string, string>;
}

/** The commit or tree a diff against this snapshot's HEAD starts from: the empty tree for a repo without commits. */
export const baseRef = (snapshot: Snapshot): string => (snapshot.head === "none" ? EMPTY_TREE : snapshot.head);

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
	return env;
}

export async function git(repo: string, args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: gitEnv(), maxBuffer: 512 * 1024 * 1024, signal });
	return stdout;
}

async function gitRef(repo: string, ref: string, signal: AbortSignal): Promise<string> {
	try {
		return (await git(repo, ["rev-parse", "--verify", "-q", ref], signal)).trim();
	} catch (error) {
		if (isRecord(error) && error.code === 1) return "none";
		throw error;
	}
}

/** The commit a diff against `repo`'s current HEAD starts from: the empty tree for a repo without commits. */
export async function headBase(repo: string, signal: AbortSignal): Promise<string> {
	const head = await gitRef(repo, "HEAD", signal);
	return head === "none" ? EMPTY_TREE : head;
}

/** The paths in `git status --porcelain=v1 -z` output; a rename or copy lists both its new and its old path. */
export function parseStatus(raw: string): string[] {
	const parts = raw.split("\0");
	const files: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		files.push(entry.slice(3));
		if (/[RC]/.test(entry.slice(0, 2))) {
			const from = parts[++i];
			if (from) files.push(from);
		}
	}
	return files;
}

async function contentHash(path: string, signal: AbortSignal): Promise<string> {
	const handle = await open(path, "r");
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		for (;;) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, null);
			if (bytesRead === 0) return hash.digest("hex");
			hash.update(chunk.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
}

function linkTarget(path: string): string {
	try {
		return `link:${readlinkSync(path)}`;
	} catch {
		return "deleted";
	}
}

/** A content hash; a file over 1 MiB is identified by size and mtime instead, and an unreadable one by the same. Rejects as soon as `signal` aborts. */
export async function hashFile(repo: string, file: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const path = join(repo, file);
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch {
		return "deleted";
	}
	if (stat.isSymbolicLink()) return linkTarget(path);
	if (stat.isDirectory()) return "dir";
	if (!stat.isFile()) return "special";
	if (stat.size > MAX_HASHED_BYTES) return `large:${stat.size}:${stat.mtimeMs}`;
	try {
		return await contentHash(path, signal);
	} catch (error) {
		signal.throwIfAborted();
		return isRecord(error) && error.code === "ENOENT" ? "deleted" : `unreadable:${stat.size}:${stat.mtimeMs}`;
	}
}

/** Runs `fn` over `items` with at most `limit` calls in flight and returns the results in the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
		}),
	);
	return out;
}

export async function takeSnapshot(repo: string, signal: AbortSignal): Promise<Snapshot> {
	const [head, tree, status] = await Promise.all([gitRef(repo, "HEAD", signal), gitRef(repo, "HEAD^{tree}", signal), git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal)]);
	const files = [...new Set(parseStatus(status))];
	const hashes = await mapLimit(files, HASH_CONCURRENCY, file => hashFile(repo, file, signal));
	return { head, tree, dirty: Object.fromEntries(files.map((file, i) => [file, hashes[i]])) };
}

/** The paths `git status` lists as changed or untracked in `repo`. */
export async function dirtyFiles(repo: string, signal: AbortSignal): Promise<string[]> {
	return [...new Set(parseStatus(await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal)))];
}

export async function committedFiles(repo: string, from: string, to: string, signal: AbortSignal): Promise<string[]> {
	if (from === to || to === "none") return [];
	const out = from === "none" ? await git(repo, ["ls-tree", "-r", "--name-only", "-z", to], signal) : await git(repo, ["diff", "--name-only", "--no-renames", "-z", from, to], signal);
	return out.split("\0").filter(Boolean);
}

/** Files committed since the baseline, dirty files whose hash differs from it, and files that were dirty then and are clean now (reverted, stashed or committed). */
export function changedFiles(base: Snapshot, now: Snapshot, committed: readonly string[]): string[] {
	const out = new Set(committed);
	for (const [file, hash] of Object.entries(now.dirty)) if (base.dirty[file] !== hash) out.add(file);
	for (const file of Object.keys(base.dirty)) if (!Object.hasOwn(now.dirty, file)) out.add(file);
	return [...out].sort();
}

/** Identifies the state of the tree as far as `paths` can tell: the HEAD tree plus the dirty files they match. */
export function fingerprint(tree: string, dirty: Readonly<Record<string, string>>, paths: readonly string[]): string {
	const matching = Object.entries(dirty)
		.filter(([file]) => matchesAny(paths, file))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return createHash("sha256").update(JSON.stringify([tree, matching])).digest("hex");
}
