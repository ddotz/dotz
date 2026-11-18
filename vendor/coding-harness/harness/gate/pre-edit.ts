import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TEXT_BYTES } from "./base-text.ts";
import { repoRelative } from "./repo-files.ts";
import { existingDir, repoOfDir } from "./session.ts";
import type { DirRepos } from "./session.ts";
import { dirtyFiles } from "./snapshot.ts";
import type { TextAt } from "./types.ts";
import { isRecord } from "./util.ts";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

type Saved = Map<string, string | null | undefined>;

async function textOf(path: string, signal: AbortSignal): Promise<string | null | undefined> {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return undefined;
		return decoder.decode(await readFile(path, { signal }));
	} catch (error) {
		return isRecord(error) && error.code === "ENOENT" ? null : undefined;
	}
}

/**
 * The text each file held when a worker session first targeted it with edit, write or ast_edit: the base text of that worker's
 * edit feedback, so that lines already in the shared checkout are not blamed on the worker. A file saved once is not saved
 * again. An ast_edit naming a directory cannot say which files it will change, so every dirty file of that repo is saved.
 */
export class PreEditTexts {
	private readonly dirRepos: DirRepos = new Map();
	private readonly saved = new Map<string, Saved>();

	/** Saves the current text of each target of a call that is about to run: null for a file that does not exist yet, undefined for one that is too big to keep. */
	async save(paths: readonly string[], signal: AbortSignal): Promise<void> {
		await Promise.all(paths.map(path => this.saveTarget(path, signal)));
	}

	/** The saved text of a file of `repo`; undefined when none was saved, which leaves the diff against HEAD. */
	textAt(repo: string): TextAt {
		return async file => this.saved.get(repo)?.get(file);
	}

	/** The files of `repo` this session has targeted so far, in path order. */
	files(repo: string): string[] {
		return [...(this.saved.get(repo)?.keys() ?? [])].sort();
	}

	private async saveTarget(path: string, signal: AbortSignal): Promise<void> {
		const dir = existingDir(path);
		const repo = dir === undefined ? undefined : await repoOfDir(this.dirRepos, dir, signal);
		if (dir === undefined || repo === undefined) return;
		const known = this.saved.get(repo) ?? new Map<string, string | null | undefined>();
		this.saved.set(repo, known);
		const files = dir === path ? await dirtyFiles(repo, signal) : [repoRelative(repo, path)];
		for (const file of files) if (file !== undefined && !known.has(file)) known.set(file, await textOf(join(repo, file), signal));
	}
}
