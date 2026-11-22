import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { existingDir, repoOfDir } from "./session.ts";
import type { DirRepos } from "./session.ts";

/** `path` relative to `repo` with forward slashes, whether it is inside as given or through the real path of its directory; undefined when it is not inside. */
export function repoRelative(repo: string, path: string): string | undefined {
	let real = path;
	try {
		real = join(realpathSync(dirname(path)), basename(path));
	} catch {
		real = path;
	}
	for (const candidate of [path, real]) {
		const inside = relative(repo, candidate);
		if (inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return inside.split(sep).join("/");
	}
	return undefined;
}

/** The repo-relative files of `paths` grouped by the git repo each lies in; a path outside every repo is dropped. */
export async function filesByRepo(cache: DirRepos, paths: readonly string[], signal: AbortSignal): Promise<Map<string, string[]>> {
	const byRepo = new Map<string, string[]>();
	await Promise.all(
		paths.map(async path => {
			const dir = existingDir(path);
			const repo = dir === undefined ? undefined : await repoOfDir(cache, dir, signal);
			const file = repo === undefined ? undefined : repoRelative(repo, path);
			if (repo !== undefined && file !== undefined) byRepo.set(repo, [...(byRepo.get(repo) ?? []), file]);
		}),
	);
	return byRepo;
}
