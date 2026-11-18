import { lstatSync } from "node:fs";
import { join } from "node:path";
import { acceptedGateFiles, driftedGateFiles } from "./accepted-gate.ts";
import { baseRef, changedFiles, committedFiles, git, takeSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Baseline } from "./session.ts";

function exists(repo: string, file: string): boolean {
	try {
		lstatSync(join(repo, file));
		return true;
	} catch {
		return false;
	}
}

async function existedAtBase(repo: string, base: Snapshot, baseline: Baseline, file: string, signal: AbortSignal): Promise<boolean> {
	const kept = await baseline.texts.textAt(file);
	if (kept !== undefined) return kept !== null;
	try {
		await git(repo, ["cat-file", "-e", `${baseRef(base)}:${file}`], signal);
		return true;
	} catch {
		signal.throwIfAborted();
		return false;
	}
}

/** The repo-relative files the session changed in `repo` since `base`, whatever tool changed them: working tree and history changes, minus gate files that hold their accepted text, plus gate files that differ from it, plus the files the run's edit, write and ast_edit calls wrote that still exist or existed at the base, which git may not list because it ignores them; sorted. */
export async function sessionFiles(repo: string, base: Snapshot, baseline: Baseline | undefined, signal: AbortSignal): Promise<{ now: Snapshot; files: string[] }> {
	const now = await takeSnapshot(repo, signal);
	const agreeing = acceptedGateFiles(repo);
	const touched = changedFiles(base, now, await committedFiles(repo, base.head, now.head, signal));
	const written = baseline === undefined ? [] : [...baseline.toolEdited].filter(file => !touched.includes(file));
	const kept = baseline === undefined ? [] : (await Promise.all(written.map(async file => (exists(repo, file) || (await existedAtBase(repo, base, baseline, file, signal)) ? file : undefined)))).filter(file => file !== undefined);
	return { now, files: [...new Set([...touched, ...kept].filter(file => !agreeing.has(file)).concat(driftedGateFiles(repo)))].sort() };
}
