// The results a finished job names in its report, as the web shows them under its row (web/js/08-home.js resultChips): the files of its
// `[file]` lines and backticked paths, the commits of its `근거:` line (each a link to the commit page of the repo that has it), and the web
// links it gives. Paths and links only, never contents; a few per row.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expand } from "./config.ts";
import { fileLinePaths } from "./files.ts";

export type ResultFile = { path: string; name: string; size: number };
export type ResultLink = { kind: "commit"; hash: string; url: string } | { kind: "link"; url: string };

const RESULT_FILES_MAX = 6;
const RESULT_LINKS_MAX = 3;
// A report names its outputs in `[file]` lines, or as a backticked absolute path to a document, page, sheet or image it made.
const RESULT_EXT = /\.(md|markdown|txt|pdf|html?|csv|tsv|xlsx?|docx?|pptx?|hwpx?|png|jpe?g|gif|webp|svg|json|zip)$/i;
const backtickPaths = (text: string) => [...text.matchAll(/`((?:~|\/)[^`\n]+?)`/g)].map(m => m[1]!).filter(p => RESULT_EXT.test(p));
export function resultFiles(report: string | undefined): ResultFile[] {
	const out: ResultFile[] = [];
	for (const line of report ? new Set([...fileLinePaths(report), ...backtickPaths(report)]) : []) {
		const path = expand(line);
		if (!path.startsWith("/") || !existsSync(path) || out.some(f => f.path === path)) continue;
		const st = statSync(path);
		if (st.isFile()) out.push({ path, name: basename(path), size: st.size });
		if (out.length === RESULT_FILES_MAX) break;
	}
	return out;
}

// The lines outside code fences: a hash or URL inside a code block is an example, not a result.
function proseLines(text: string): string[] {
	const out: string[] = [];
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		else if (!fence) out.push(line);
	}
	return out;
}

// The web page of a repo from its origin remote (git@host:o/r.git, https://host/o/r.git, ssh://git@host/o/r), or none.
export function repoWebUrl(remote: string): string | undefined {
	const r = remote.trim().replace(/\.git$/, "");
	const m = /^git@([\w.-]+):([\w.-]+\/[\w.-]+)$/.exec(r) ?? /^(?:https?|ssh):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+\/[\w.-]+)$/.exec(r);
	return m ? `https://${m[1]}/${m[2]}` : undefined;
}
const gitOut = (dir: string, ...args: string[]) => {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 3000 });
	return r.status === 0 ? r.stdout.trim() : undefined;
};
// Both answers are asked once per folder and per (folder, hash): a commit does not leave its repo, and a report is read on every listing.
const REPO = new Map<string, string | null>(), COMMIT = new Map<string, string | null>();
const CACHE_MAX = 500;
const remember = <T>(m: Map<string, T>, k: string, v: T) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!); m.set(k, v); return v; };
function commitUrl(hash: string, dirs: string[]): string | undefined {
	for (const dir of dirs) {
		const key = `${dir}\n${hash}`;
		const known = COMMIT.get(key);
		if (known !== undefined) {
			if (known) return known;
			continue;
		}
		const base = REPO.has(dir) ? REPO.get(dir) : remember(REPO, dir, (existsSync(dir) && repoWebUrl(gitOut(dir, "remote", "get-url", "origin") ?? "")) || null);
		const full = base ? gitOut(dir, "rev-parse", "--verify", "-q", `${hash}^{commit}`) : undefined;
		if (remember(COMMIT, key, base && full ? `${base}/commit/${full}` : null)) return COMMIT.get(key)!;
	}
	return undefined;
}

// ASCII URL characters only, so a particle (…/a에서) or markdown (…/b**) glued on is not taken; a balanced (…) stays (Foo_(bar)).
const URL_RE = /https?:\/\/(?:[\w\-.~:/?#@!$&+,;=%]|\([\w\-.~:/?#@!$&+,;=%]*\))+/g;
const LOCAL = /^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/;
// `dirs`: the folders whose repos may hold the commits (the job's folder, then dotz's own); a hash no repo has gets no chip.
export function resultLinks(report: string | undefined, dirs: string[]): ResultLink[] {
	if (!report) return [];
	const out: ResultLink[] = [];
	const lines = proseLines(report);
	const roots = [...new Set(dirs.filter(Boolean).map(expand))];
	for (const line of lines.filter(l => /근거\s*:/.test(l))) {
		for (const m of line.matchAll(/(?<![\w/.-])[0-9a-f]{7,40}(?![\w/.-])/g)) {
			const hash = m[0];
			if (!/\d/.test(hash) || out.some(x => x.kind === "commit" && x.url.endsWith(hash))) continue;
			const url = commitUrl(hash, roots);
			if (url && !out.some(x => x.url === url)) out.push({ kind: "commit", hash: hash.slice(0, 8), url });
			if (out.length === RESULT_LINKS_MAX) return out;
		}
	}
	for (const line of lines) {
		for (const m of line.matchAll(URL_RE)) {
			const url = m[0].replace(/[.,;:!?。、]+$/, "");
			if (LOCAL.test(url) || out.some(x => x.url === url)) continue;
			out.push({ kind: "link", url });
			if (out.length === RESULT_LINKS_MAX) return out;
		}
	}
	return out;
}
