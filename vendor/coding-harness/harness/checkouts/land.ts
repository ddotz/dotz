import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LetThrough } from "../gate/decision.ts";
import { git } from "../gate/snapshot.ts";
import { isRecord, message } from "../gate/util.ts";
import { withFolderLock } from "./lock.ts";
import { land } from "./ovnfs.ts";
import { type Placement, workOf } from "./place.ts";

const FOLDER_LOCK_MS = 10_000;
const INDEX_LOCK_WAIT_MS = 2_000;
const INDEX_LOCK_RETRY_MS = 1_000;
const STEP_MS = 100;

/** A slot's tree as the gate judged it: HEAD and a digest of `git status --porcelain=v1 -z --untracked-files=no`. Untracked files are left out: only commits land, and a check that writes artifacts must not make a judged tree look changed. */
export interface TreeStamp {
	readonly head: string;
	readonly tracked: string;
}

/**
 * What `landSlot` did. `landed`: `commits` commits went onto `branch` of the folder (`from` -> `to`); `uncommitted` are the slot's
 * paths that still differ from the folder (`workOf`), as in `nothing`, where the folder already holds the slot's HEAD. `moved`: the
 * folder's branch holds commits the slot is not based on, and `instruction` is the command that rebases the slot on it. `dirty-folder`:
 * the folder's own uncommitted edits conflict with the landing. `stale`: the slot no longer has the judged stamp. `skipped`: anything
 * else that stopped the landing, with `why`. Only `landed` changed the folder.
 */
export type LandResult =
	| { readonly kind: "landed"; readonly commits: number; readonly from: string; readonly to: string; readonly branch: string; readonly uncommitted: readonly string[] }
	| { readonly kind: "nothing"; readonly uncommitted: readonly string[] }
	| { readonly kind: "moved"; readonly branch: string; readonly instruction: string }
	| { readonly kind: "dirty-folder"; readonly files: readonly string[] }
	| { readonly kind: "stale" }
	| { readonly kind: "skipped"; readonly why: string };

const SAFE_WORD = /^[\w@%+=:,./-]+$/;

function quoted(text: string): string {
	return SAFE_WORD.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

async function isAncestor(repo: string, older: string, newer: string, signal: AbortSignal): Promise<boolean> {
	try {
		await git(repo, ["merge-base", "--is-ancestor", older, newer], signal);
		return true;
	} catch (error) {
		if (isRecord(error) && typeof error.code === "number") return false;
		throw error;
	}
}

async function uncommittedOf(placement: Placement): Promise<readonly string[]> {
	return (await workOf(placement)).uncommitted;
}

/** The stamp of the repo at `cwd`; undefined when git cannot tell its HEAD commit or status before `signal` aborts. */
export async function stampOf(cwd: string, signal: AbortSignal): Promise<TreeStamp | undefined> {
	try {
		const [head, status] = await Promise.all([git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal), git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=no"], signal)]);
		return { head: head.trim(), tracked: createHash("sha256").update(status).digest("hex") };
	} catch {
		return undefined;
	}
}

async function paused(ms: number, signal: AbortSignal): Promise<boolean> {
	try {
		await sleep(ms, undefined, { signal });
		return true;
	} catch (error) {
		if (signal.aborted) return false;
		throw error;
	}
}

async function lockGone(lock: string, signal: AbortSignal): Promise<boolean> {
	const until = Date.now() + INDEX_LOCK_WAIT_MS;
	while (existsSync(lock)) {
		const left = until - Date.now();
		if (left <= 0 || !(await paused(Math.min(STEP_MS, left), signal))) return false;
	}
	return true;
}

const lateWhy = (placement: Placement) => `git did not answer in ${placement.path} before the deadline`;

async function landLocked(placement: Placement, expect: TreeStamp, signal: AbortSignal): Promise<LandResult> {
	try {
		const now = await stampOf(placement.path, signal);
		if (now === undefined) return { kind: "skipped", why: signal.aborted ? lateWhy(placement) : `git could not read the HEAD and status of ${placement.path}` };
		if (now.head !== expect.head || now.tracked !== expect.tracked) return { kind: "stale" };
		if (await isAncestor(placement.folder, now.head, "HEAD", signal)) return { kind: "nothing", uncommitted: await uncommittedOf(placement) };
		const [folderHead, branch, gitDir] = await Promise.all([git(placement.folder, ["rev-parse", "--verify", "HEAD^{commit}"], signal), git(placement.folder, ["symbolic-ref", "--short", "HEAD"], signal), git(placement.folder, ["rev-parse", "--absolute-git-dir"], signal)]);
		const instruction = `git fetch ${quoted(placement.folder)} ${quoted(branch.trim())} && git rebase --autostash FETCH_HEAD`;
		if (!(await isAncestor(placement.path, folderHead.trim(), now.head, signal))) return { kind: "moved", branch: branch.trim(), instruction };
		const commits = Number((await git(placement.path, ["rev-list", "--count", `${folderHead.trim()}..${now.head}`], signal)).trim());
		const indexLock = join(gitDir.trim(), "index.lock");
		if (!(await lockGone(indexLock, signal))) return { kind: "skipped", why: signal.aborted ? `${indexLock} was still held when the deadline came` : `${indexLock} stayed held by another git process for ${INDEX_LOCK_WAIT_MS / 1000} s` };
		let landed = await land(placement.name, placement.folder, { dryRun: false });
		if (landed.kind === "unknown" && landed.text.includes("index.lock")) {
			if (!(await paused(INDEX_LOCK_RETRY_MS, signal))) return { kind: "skipped", why: landed.text };
			landed = await land(placement.name, placement.folder, { dryRun: false });
		}
		switch (landed.kind) {
			case "landed":
				return { kind: "landed", commits, from: landed.from, to: landed.to, branch: landed.branch, uncommitted: await uncommittedOf(placement) };
			case "nothing":
				return { kind: "nothing", uncommitted: await uncommittedOf(placement) };
			case "moved":
				return { kind: "moved", branch: branch.trim(), instruction };
			case "dirty-folder":
				return { kind: "dirty-folder", files: landed.files };
			case "unknown":
				return { kind: "skipped", why: landed.text };
		}
	} catch (error) {
		return { kind: "skipped", why: signal.aborted ? lateWhy(placement) : message(error) };
	}
}

/**
 * Lands the commits of slot `placement` on the branch checked out in its folder, with the gate's `verdict` for that slot, holding the
 * folder's lock (`withFolderLock`) from the stamp check to the end of `ovnfs land`, so a second landing of the folder sees the first one's
 * result; a lock not obtained in 10 s is `skipped`. Nothing is landed unless the slot still has stamp `expect`. A slot whose HEAD the
 * folder's HEAD already contains is `nothing`, and a slot not based on the folder's HEAD is `moved`, both without calling ovnfs. Before
 * `ovnfs land` it waits up to 2 s for the folder's `index.lock` to go away (`skipped` when it stays), and an `ovnfs land` that fails
 * naming `index.lock` runs once more after 1 s, whose result counts. Every wait and git call ends when `signal` aborts, which gives
 * `skipped`; a running `ovnfs land` is waited for. Never throws.
 */
export async function landSlot(placement: Placement, verdict: LetThrough, expect: TreeStamp, signal: AbortSignal): Promise<LandResult> {
	if (verdict.repo !== placement.path) return { kind: "skipped", why: `the gate's verdict is for ${verdict.repo}, not for ${placement.path}` };
	let began = false;
	const locked = withFolderLock(
		placement.folder,
		(): Promise<LandResult> => {
			began = true;
			return signal.aborted ? Promise.resolve({ kind: "skipped", why: lateWhy(placement) }) : landLocked(placement, expect, signal);
		},
		{ waitMs: FOLDER_LOCK_MS },
	);
	const deadline = Promise.withResolvers<boolean>();
	if (signal.aborted) deadline.resolve(!began);
	else signal.addEventListener("abort", () => deadline.resolve(!began), { once: true });
	const late = await Promise.race([locked.then(() => false), deadline.promise]);
	if (late) return { kind: "skipped", why: `the lock of ${placement.folder} was not obtained before the deadline` };
	const held = await locked;
	return held.acquired ? held.value : { kind: "skipped", why: `the lock of ${placement.folder} was not obtained in ${FOLDER_LOCK_MS / 1000} s: ${held.why}` };
}
