import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./log.ts";
import { changedFiles, committedFiles, git, hashFile, mapLimit, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { TextAt } from "./types.ts";

/** The largest file whose text is kept as a base text; a bigger one is unknown. */
export const MAX_TEXT_BYTES = 1024 * 1024;

const MAX_STORED_BYTES = 128 * 1024 * 1024;
const SAVE_CONCURRENCY = 8;
const STALE_MS = 24 * 60 * 60 * 1000;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const DELETED = "deleted";
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

interface Entry {
	hash: string;
	saved: boolean;
}

/** Removes the base-text directories of runs that ended without cleaning up, such as one whose process was killed: those not touched for a day. */
export function pruneStaleBases(now = Date.now()): void {
	const root = join(stateDir(), "base");
	try {
		for (const name of readdirSync(root)) {
			const path = join(root, name);
			if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
		}
	} catch {
		return;
	}
}

/**
 * What the files of one repo held at the base point of a run, where that is not simply `git show <base head>:<file>`, and the
 * files the session has changed so far. At the run start the text of every dirty or untracked file is copied under the state
 * dir (a file over 1 MiB, or past 128 MiB in all, is not copied and is unknown); `textAt` serves those texts to the anti-escape
 * stage and answers undefined for every other file. Around a history-moving git command in a bash call, `observe` and `move` move
 * the base text of a file the command changed to its content after the command, unless the session has changed that file at any
 * point of the run: `changed` only grows, so a file the session touched keeps its base text whatever later commands do to it.
 * Around a call that runs other commands too, which may have written any file, `observe` and `moveBrought` move only the files
 * that an older commit brought in, on the conditions `moveBrought` lists.
 */
export class BaseTexts {
	readonly changed = new Set<string>();
	private readonly entries = new Map<string, Entry>();
	private seenHead = "none";
	private dir: string | undefined;
	private stored = 0;
	private disposed = false;

	constructor(private readonly repo: string) {}

	/** Copies the text of every file `snapshot` lists as dirty; the run's base point is that snapshot. Never rejects: a file that cannot be copied is unknown. */
	async start(snapshot: Snapshot, signal: AbortSignal): Promise<void> {
		this.seenHead = snapshot.head;
		await mapLimit(Object.entries(snapshot.dirty), SAVE_CONCURRENCY, ([file, hash]) => this.keep(file, hash, signal));
	}

	/** Takes `before`, the repo just before a history-moving command, as seen: the files committed since the previous look and the files whose content is not their base text are the session's. */
	async observe(before: Snapshot, signal: AbortSignal): Promise<void> {
		for (const file of await committedFiles(this.repo, this.seenHead, before.head, signal)) this.changed.add(file);
		this.seenHead = before.head;
		for (const [file, hash] of Object.entries(before.dirty)) if (this.entries.get(file)?.hash !== hash) this.changed.add(file);
	}

	/** After the command that `before` preceded: every file it changed that the session never changed takes its content now as its base text. */
	async move(before: Snapshot, signal: AbortSignal): Promise<void> {
		const after = await takeSnapshot(this.repo, signal);
		const files = changedFiles(before, after, await committedFiles(this.repo, before.head, after.head, signal)).filter(file => !this.changed.has(file));
		await mapLimit(files, SAVE_CONCURRENCY, async file => this.keep(file, await hashFile(this.repo, file, signal), signal));
		this.seenHead = after.head;
	}

	/**
	 * After the call that `before` preceded, which began at `startedAt` (ms) and ran a history-moving git command next to other
	 * commands: a file takes its content now as its base text only when all of these hold. HEAD changed during the call, and the
	 * new HEAD commit's committer time, in whole seconds, is less than the second the call began in (a commit made in that second,
	 * such as one the call made itself, does not qualify). The file differs between the old and the new HEAD. Its content now is its
	 * content at the new HEAD. The session never changed it.
	 */
	async moveBrought(before: Snapshot, startedAt: number, signal: AbortSignal): Promise<void> {
		const after = await takeSnapshot(this.repo, signal);
		if (after.head === before.head || after.head === "none" || !(await this.predates(after.head, startedAt, signal))) return;
		const files = (await committedFiles(this.repo, before.head, after.head, signal)).filter(file => !this.changed.has(file) && !Object.hasOwn(after.dirty, file));
		await mapLimit(files, SAVE_CONCURRENCY, async file => this.keep(file, await hashFile(this.repo, file, signal), signal));
		this.seenHead = after.head;
	}

	/** Before the session's first tool edit of `file`: when git ignores it (so no snapshot saw it), its text now, or null when it does not exist yet, is its base text. */
	async keepHidden(file: string, signal: AbortSignal): Promise<void> {
		if (this.entries.has(file) || !(await this.ignored(file, signal))) return;
		await this.keep(file, await hashFile(this.repo, file, signal), signal);
	}

	/** The base text of a file: its text, null when it did not exist, undefined when this store does not hold it. */
	readonly textAt: TextAt = async file => {
		const entry = this.entries.get(file);
		if (entry === undefined) return undefined;
		if (entry.hash === DELETED) return null;
		if (!entry.saved || this.dir === undefined) return undefined;
		try {
			return decoder.decode(await readFile(join(this.dir, entry.hash)));
		} catch {
			return undefined;
		}
	};

	/** Removes the copied texts; the store keeps nothing afterwards. */
	dispose(): void {
		this.disposed = true;
		if (this.dir !== undefined) rmSync(this.dir, { recursive: true, force: true });
	}

	private async predates(commit: string, startedAt: number, signal: AbortSignal): Promise<boolean> {
		const committed = (await git(this.repo, ["show", "-s", "--format=%ct", commit], signal)).trim();
		return /^\d+$/.test(committed) && Number(committed) < Math.floor(startedAt / 1000);
	}

	private async ignored(file: string, signal: AbortSignal): Promise<boolean> {
		try {
			await git(this.repo, ["check-ignore", "-q", "--", file], signal);
			return true;
		} catch {
			signal.throwIfAborted();
			return false;
		}
	}

	private async keep(file: string, hash: string, signal: AbortSignal): Promise<void> {
		this.entries.set(file, { hash, saved: false });
		if (this.disposed || !CONTENT_HASH.test(hash) || this.stored >= MAX_STORED_BYTES) return;
		try {
			const data = await readFile(join(this.repo, file), { signal });
			if (data.length > MAX_TEXT_BYTES || createHash("sha256").update(data).digest("hex") !== hash) return;
			if (await this.save(hash, data)) this.entries.set(file, { hash, saved: true });
		} catch {
			return;
		}
	}

	private async save(hash: string, data: Uint8Array): Promise<boolean> {
		if (this.disposed) return false;
		const dir = this.dir ?? join(stateDir(), "base", `${process.pid}-${randomUUID()}`);
		this.dir = dir;
		const path = join(dir, hash);
		if (!existsSync(path)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			await writeFile(path, data, { mode: 0o600 });
			this.stored += data.length;
		}
		if (this.disposed) rmSync(dir, { recursive: true, force: true });
		return !this.disposed;
	}
}
