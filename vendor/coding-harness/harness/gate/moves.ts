import { join } from "node:path";
import { until } from "./deadline.ts";
import { filesByRepo } from "./repo-files.ts";
import { existingDir, isSourceFile, noteSourceWrite, repoOfDir } from "./session.ts";
import type { Baseline, PendingMove, PendingPatch, State } from "./session.ts";
import { changedFiles, committedFiles, hashFile, mapLimit, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import { movesBase, movesHistory } from "./tool-paths.ts";
import { isRecord, message } from "./util.ts";

const HASH_CONCURRENCY = 8;

async function reposOf(state: State, dirs: readonly string[], signal: AbortSignal): Promise<Set<string>> {
	const repos = new Set<string>();
	for (const dir of dirs) {
		const found = existingDir(dir);
		const repo = found === undefined ? undefined : await repoOfDir(state.dirRepo, found, signal);
		if (repo !== undefined) repos.add(repo);
	}
	return repos;
}

function countAll(state: State, baseline: Baseline): void {
	baseline.blind = true;
	state.repos.add(baseline.repo);
}

/**
 * Before a bash call runs: a snapshot of every repo of `dirs` that the run reached only as a bash command's directory and has a
 * usable baseline of, kept under the call until `afterBash`. The first call to reach such a repo uses its baseline, which that
 * call's own `track` took. A repo whose snapshot fails or does not finish by `signal` counts every change from then on.
 */
export async function beforeBash(state: State, callId: string | undefined, dirs: readonly string[], signal: AbortSignal): Promise<void> {
	const repos = await reposOf(state, dirs, signal);
	await Promise.all(
		[...repos].map(async repo => {
			const baseline = state.baselines.get(repo);
			if (baseline === undefined || baseline.direct || baseline.failure !== undefined) return;
			try {
				const settled = await until(baseline.result, signal);
				if (settled === undefined) return countAll(state, baseline);
				if (!settled.value.ok) return;
				const before = baseline.probed ? await takeSnapshot(repo, signal) : settled.value.snapshot;
				baseline.probed = true;
				baseline.probes.set(callId ?? "", before);
			} catch {
				countAll(state, baseline);
			}
		}),
	);
}

/**
 * After a bash call: in each repo `beforeBash` took, the files that differ from its snapshot, committed by the call or changed in
 * the working tree, are the call's writes; a repo where it wrote anything is seen by later runs. A call that goes on after its
 * result (a background job, `details.async.state` "running", or a named service) or whose second snapshot fails makes its repos
 * count every change from then on.
 */
export async function afterBash(state: State, callId: string | undefined, input: Record<string, unknown>, details: unknown, signal: AbortSignal): Promise<void> {
	const id = callId ?? "";
	const goesOn = (isRecord(details) && isRecord(details.async) && details.async.state === "running") || (typeof input.name === "string" && input.name.trim() !== "");
	await Promise.all(
		[...state.baselines.values()].map(async baseline => {
			const before = baseline.probes.get(id);
			if (before === undefined) return;
			try {
				if (goesOn) return countAll(state, baseline);
				const after = await takeSnapshot(baseline.repo, signal);
				const files = changedFiles(before, after, await committedFiles(baseline.repo, before.head, after.head, signal));
				for (const file of files) baseline.bashWrote.add(file);
				if (files.length > 0) state.repos.add(baseline.repo);
			} catch {
				countAll(state, baseline);
			} finally {
				baseline.probes.delete(id);
			}
		}),
	);
}

/** Notes the files of `paths` as changed by the session and as written by a tool, in each repo the run has a baseline of; a directory, which an ast_edit may name, is not a file and is skipped. */
export async function markEdited(state: State, paths: readonly string[], signal: AbortSignal): Promise<void> {
	for (const [repo, files] of await filesByRepo(state.dirRepo, paths.filter(path => existingDir(path) !== path), signal)) {
		const baseline = state.baselines.get(repo);
		if (baseline === undefined) continue;
		for (const file of files) {
			baseline.texts.changed.add(file);
			baseline.toolEdited.add(file);
		}
	}
}

/** Before a tool call writes `paths`: saves the text of each file that git ignores and the run's tool edits have not reached yet, as its base text, in each repo the run has a usable baseline of. */
export async function saveHidden(state: State, paths: readonly string[], signal: AbortSignal): Promise<void> {
	for (const [repo, files] of await filesByRepo(state.dirRepo, paths.filter(path => existingDir(path) !== path), signal)) {
		const baseline = state.baselines.get(repo);
		if (baseline === undefined || baseline.failure !== undefined) continue;
		const settled = await until(baseline.result, signal);
		if (!settled?.value.ok) continue;
		for (const file of files) if (!baseline.toolEdited.has(file)) await baseline.texts.keepHidden(file, signal);
	}
}

const sharedStarts = new WeakMap<PendingMove[], number>();

/**
 * The first snapshot of a bash call that runs a history-moving git command: of every repo in `dirs` that the run has a usable
 * baseline of, before the command runs. What the repo shows then is taken as seen by the run, and the call's `afterCommand` moves
 * base texts from it. When every command of the call is a git command or a directory change, that moves every file the command
 * changed that the session never changed; when the call runs anything else too, which may have written any file, only what
 * `BaseTexts.moveBrought` allows, measured from the moment the call began. A call with no history-moving git command is not looked
 * at. The engine does not hand it a call that applies a patch (`git apply`, `git am`, `patch`): whatever such a call brings in stays
 * the session's, and `beforePatch` looks at it instead.
 */
export async function beforeCommand(state: State, callId: string | undefined, command: string, dirs: readonly string[], signal: AbortSignal): Promise<void> {
	const alone = movesBase(command);
	if (!alone && !movesHistory(command)) return;
	const startedAt = Date.now();
	const repos = await reposOf(state, dirs, signal);
	const taken = await Promise.all(
		[...repos].map(async (repo): Promise<PendingMove | undefined> => {
			const baseline = state.baselines.get(repo);
			if (baseline === undefined || baseline.failure !== undefined) return undefined;
			try {
				const settled = await until(baseline.result, signal);
				if (!settled?.value.ok) return undefined;
				const before = await takeSnapshot(repo, signal);
				await baseline.texts.observe(before, signal);
				return { repo, before };
			} catch (error) {
				state.errors.push(`could not take ${repo} before a history-moving git command, so the base texts of the files it changes stay as they were: ${message(error)}`);
				return undefined;
			}
		}),
	);
	const moves = taken.filter(move => move !== undefined);
	if (!alone) sharedStarts.set(moves, startedAt);
	state.moves.set(callId ?? "", moves);
}

/** The second snapshot of the call: moves the base texts of the files the command changed by the rule `beforeCommand` chose for the call. */
export async function afterCommand(state: State, callId: string | undefined, signal: AbortSignal): Promise<void> {
	const pending = state.moves.get(callId ?? "");
	if (pending === undefined) return;
	state.moves.delete(callId ?? "");
	const startedAt = sharedStarts.get(pending);
	await Promise.all(
		pending.map(async ({ repo, before }) => {
			try {
				const texts = state.baselines.get(repo)?.texts;
				if (startedAt === undefined) await texts?.move(before, signal);
				else await texts?.moveBrought(before, startedAt, signal);
			} catch (error) {
				state.errors.push(`could not move the base texts of ${repo} after a history-moving git command, so lines it brought in may be blamed on the session: ${message(error)}`);
			}
		}),
	);
}

/**
 * The first snapshot of a call that applies a patch (a `task` call, or a bash command that runs `git apply`, `git am` or `patch`): of
 * every repo the run has a usable baseline of, before the call runs, with the content hash of every dirty file and of every source file
 * an edit tool wrote. A repo whose snapshot fails or does not finish by `signal` is left out, and the failure goes to `state.errors`.
 */
export async function beforePatch(state: State, callId: string | undefined, signal: AbortSignal): Promise<void> {
	const taken = await Promise.all(
		[...state.baselines].map(async ([repo, baseline]): Promise<PendingPatch | undefined> => {
			if (!baseline.settled || baseline.failure !== undefined) return undefined;
			try {
				const before = await takeSnapshot(repo, signal);
				const written = [...baseline.toolEdited].filter(file => isSourceFile(file) && !Object.hasOwn(before.dirty, file));
				const hashes = await mapLimit(written, HASH_CONCURRENCY, file => hashFile(repo, file, signal));
				written.forEach((file, at) => {
					before.dirty[file] = hashes[at];
				});
				return { repo, before };
			} catch (error) {
				state.errors.push(`could not take ${repo} before a call that applies a patch, so the source files it changes there are not counted as written: ${message(error)}`);
				return undefined;
			}
		}),
	);
	state.patches.set(callId ?? "", taken.filter(patch => patch !== undefined));
}

async function changedSince(repo: string, before: Snapshot, signal: AbortSignal): Promise<string[]> {
	const after = await takeSnapshot(repo, signal);
	const committed = await committedFiles(repo, before.head, after.head, signal);
	const files = [...new Set([...Object.keys(before.dirty), ...Object.keys(after.dirty), ...committed])].filter(isSourceFile);
	const differs = await mapLimit(files, HASH_CONCURRENCY, async file => {
		const was = before.dirty[file];
		return was === undefined || (after.dirty[file] ?? (await hashFile(repo, file, signal))) !== was;
	});
	return files.filter((_, at) => differs[at]);
}

/**
 * The second snapshot of the call that `beforePatch` preceded: every source file whose content differs from what the first snapshot
 * saw, whether it was created, changed or deleted, in the working tree or by a commit the call made, is a write of the call, at the
 * call's tool-call count `calls`, also when an edit tool wrote the file before; the absolute paths of those files are returned. A
 * call that changes nothing records nothing, and neither does a repo whose snapshot fails or does not finish by `signal`: that
 * failure goes to `state.errors`.
 */
export async function afterPatch(state: State, callId: string | undefined, calls: number, signal: AbortSignal): Promise<string[]> {
	const pending = state.patches.get(callId ?? "");
	if (pending === undefined) return [];
	state.patches.delete(callId ?? "");
	const written = await Promise.all(
		pending.map(async ({ repo, before }) => {
			try {
				const files = await changedSince(repo, before, signal);
				for (const file of files) noteSourceWrite(state, repo, file, calls);
				return files.map(file => join(repo, file));
			} catch (error) {
				state.errors.push(`could not take ${repo} after a call that applies a patch, so the source files it changed there are not counted as written: ${message(error)}`);
				return [];
			}
		}),
	);
	return written.flat();
}
