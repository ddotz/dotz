import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EvidenceEntry } from "./gate-file.ts";
import { matchesAny } from "./gate-file.ts";
import { isRecord, list, message } from "./util.ts";

const LISTED_FILES = 10;
const LISTED_MANIFESTS = 3;
const SHORT = 12;
const WAIVER = /(^|\/)waiver-[^/]+\.md$/;
const DRIVER = /^\.omp\/skills\/verify-[^/]+\/[^]+$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
const JPEG = [0xff, 0xd8, 0xff];
const SQLITE = [...new TextEncoder().encode("SQLite format 3"), 0];
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const FTYP = [0x66, 0x74, 0x79, 0x70];
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const FEATURES_FILE = ".omp/verify/features.json";
export const PROOFS = ["screenshot", "video", "log", "db"] as const;

export type Proof = (typeof PROOFS)[number];

/** One entry of `.omp/verify/features.json`: the files a feature lives in and the kind of artifact that proves it. */
export interface Feature {
	id: string;
	paths: string[];
	proof: Proof;
}

export interface Features {
	features: Feature[];
	error?: string;
}

export interface FileTime {
	path: string;
	mtimeMs: number;
}

export interface EvidenceVerdict {
	verdict: "none" | "satisfied" | "waived" | "missing";
	waiver?: string;
	uncovered: string[];
	lacking: string[];
}

const proofOf = (value: unknown): Proof | undefined => PROOFS.find(proof => proof === value);

const repoRelative = (value: unknown): value is string => typeof value === "string" && value !== "" && !value.startsWith("/") && !value.split("/").includes("..");

/** Parses the text of `.omp/verify/features.json`; every malformed shape is an error. */
export function parseFeatures(source: string): Feature[] {
	let data: unknown;
	try {
		data = JSON.parse(source);
	} catch (error) {
		throw new Error(`not valid JSON (${message(error)})`);
	}
	const items = list(data);
	if (!items) throw new Error("must be an array of { id, paths, proof }");
	const features = items.map((item, i): Feature => {
		const at = `[${i}]`;
		if (!isRecord(item)) throw new Error(`${at} must be an object`);
		const extra = Object.keys(item).find(key => key !== "id" && key !== "paths" && key !== "proof");
		if (extra !== undefined) throw new Error(`${at} has an unknown key "${extra}" (known: id, paths, proof)`);
		const { id, paths } = item;
		if (typeof id !== "string" || id.trim() === "") throw new Error(`${at}.id must be a non-empty string`);
		const globs = list(paths);
		if (!globs || globs.length === 0 || !globs.every(repoRelative)) throw new Error(`${at}.paths must be a non-empty array of globs relative to the repo root`);
		const proof = proofOf(item.proof);
		if (proof === undefined) throw new Error(`${at}.proof must be one of ${PROOFS.join(", ")}`);
		return { id, paths: globs.map(glob => glob.replace(/^\.\//, "")), proof };
	});
	const duplicate = features.map(feature => feature.id).find((id, i, ids) => ids.indexOf(id) !== i);
	if (duplicate !== undefined) throw new Error(`two features are named "${duplicate}"`);
	return features;
}

const featuresOf = (source: string, where: string): Features => {
	try {
		return { features: parseFeatures(source) };
	} catch (error) {
		return { features: [], error: `${where}: ${message(error)}` };
	}
};

/** The features of `repo`; none, without an error, when the file does not exist. */
export function readFeatures(repo: string): Features {
	const path = join(repo, FEATURES_FILE);
	return existsSync(path) ? featuresOf(readFileSync(path, "utf8"), FEATURES_FILE) : { features: [] };
}

/** The features `.omp/verify/features.json` held at the git revision `rev`; none, without an error, when it did not exist there. */
export function featuresAt(repo: string, rev: string): Features {
	const shown = spawnSync("git", ["-C", repo, "show", `${rev}:${FEATURES_FILE}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return shown.status === 0 ? featuresOf(shown.stdout, `${FEATURES_FILE} at ${rev}`) : { features: [] };
}

const trackedAndUntracked = (repo: string): string[] =>
	execFileSync("git", ["-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024 })
		.toString("utf8")
		.split("\0")
		.filter(file => file !== "");

/** Whether the repo-relative `file` lies in the repo-relative directory `dir`. */
export function isUnder(dir: string, file: string): boolean {
	const prefix = dir.replace(/\/+$/, "");
	return file === prefix || file.startsWith(`${prefix}/`);
}

/** The content fingerprint of the files `paths` match now (tracked and untracked, ignored ones left out, deleted ones left out), leaving out the evidence under `dir`: commits and edits elsewhere in the repo do not change it. A symlink counts by its link text; a directory (nested repo, submodule) is skipped. */
export function evidenceTree(repo: string, paths: readonly string[], dir: string): string {
	const files = [...new Set(trackedAndUntracked(repo))].filter(file => matchesAny(paths, file) && !isUnder(dir, file)).sort();
	const hash = createHash("sha256");
	for (const file of files) {
		const path = join(repo, file);
		let stat: Stats;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
			throw error;
		}
		if (stat.isSymbolicLink()) hash.update(`${file}\0link\0${readlinkSync(path)}\0`);
		else if (stat.isFile()) hash.update(`${file}\0${sha256(readFileSync(path))}\0`);
	}
	return hash.digest("hex");
}

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean => magic.every((byte, i) => bytes[at + i] === byte);

function isText(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return false;
	try {
		UTF8.decode(bytes);
		return true;
	} catch {
		return false;
	}
}

const u16 = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

const u32 = (bytes: Uint8Array, at: number): number => u16(bytes, at) * 0x10000 + u16(bytes, at + 2);

function isPng(bytes: Uint8Array): boolean {
	return startsWith(bytes, PNG) && u32(bytes, 8) === 13 && startsWith(bytes, IHDR, 12) && u32(bytes, 16) > 0 && u32(bytes, 20) > 0;
}

function isJpeg(bytes: Uint8Array): boolean {
	if (!startsWith(bytes, JPEG)) return false;
	let at = 2;
	while (at + 3 < bytes.length) {
		if (bytes[at] !== 0xff) return false;
		const marker = bytes[at + 1] ?? 0;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return at + 8 < bytes.length && u16(bytes, at + 5) > 0 && u16(bytes, at + 7) > 0;
		if (marker === 0xd9 || marker === 0xda) return false;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			at += 2;
			continue;
		}
		const length = u16(bytes, at + 2);
		if (length < 2) return false;
		at += 2 + length;
	}
	return false;
}

/** Whether the bytes are what `kind` says: a PNG with an IHDR of nonzero size or a JPEG with a start-of-frame of nonzero size, a WebM or MP4, a SQLite file or non-empty UTF-8 text for `db`, non-empty UTF-8 text for `log`. */
export function isKind(kind: Proof, bytes: Uint8Array): boolean {
	switch (kind) {
		case "screenshot":
			return isPng(bytes) || isJpeg(bytes);
		case "video":
			return startsWith(bytes, WEBM) || startsWith(bytes, FTYP, 4);
		case "log":
			return isText(bytes);
		case "db":
			return startsWith(bytes, SQLITE) || isText(bytes);
	}
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const short = (print: string): string => print.slice(0, SHORT);

function problemsOf(repo: string, feature: Feature, tree: string, manifestPath: string, source: string): string[] {
	let data: unknown;
	try {
		data = JSON.parse(source);
	} catch (error) {
		return [`${manifestPath} is not valid JSON (${message(error)})`];
	}
	if (!isRecord(data)) return [`${manifestPath} must be a JSON object`];
	const problems: string[] = [];
	const { driver, command, artifacts } = data;
	if (typeof command !== "string" || command.trim() === "") problems.push(`${manifestPath}: command is missing`);
	if (typeof driver !== "string" || !DRIVER.test(driver) || driver.split("/").includes("..")) problems.push(`${manifestPath}: driver must name a script under .omp/skills/verify-*/ (got ${JSON.stringify(driver)})`);
	else if (!existsSync(join(repo, driver)) || !statSync(join(repo, driver)).isFile()) problems.push(`${manifestPath}: driver ${driver} does not exist in the repo`);
	if (data.tree !== tree) problems.push(`${manifestPath}: stale tree for feature "${feature.id}" (manifest ${typeof data.tree === "string" ? short(data.tree) : "none"}, files now ${short(tree)}); the feature's files changed after the driver ran, run the driver again`);
	const items = list(artifacts);
	if (!items || items.length === 0) return [...problems, `${manifestPath}: artifacts is empty`];
	const base = dirname(manifestPath);
	let proves = false;
	for (const [i, item] of items.entries()) {
		if (!isRecord(item) || !repoRelative(item.path) || typeof item.sha256 !== "string") {
			problems.push(`${manifestPath}: artifacts[${i}] needs a path inside the run directory and a sha256`);
			continue;
		}
		const kind = proofOf(item.kind);
		const file = join(repo, base, item.path);
		const shown = `${base}/${item.path}`;
		let bytes: Uint8Array;
		try {
			bytes = readFileSync(file);
		} catch {
			problems.push(`${manifestPath}: artifact ${shown} is missing`);
			continue;
		}
		if (sha256(bytes) !== item.sha256) problems.push(`${manifestPath}: artifact ${shown} has a bad sha256 (manifest ${short(item.sha256)}, file ${short(sha256(bytes))})`);
		if (kind === undefined) problems.push(`${manifestPath}: artifact ${shown} has kind ${JSON.stringify(item.kind)}, expected ${PROOFS.join("|")}`);
		else if (!isKind(kind, bytes)) problems.push(`${manifestPath}: artifact ${shown} is declared ${kind} but its content is not ${kind === "screenshot" ? "a PNG or JPEG" : kind === "video" ? "a WebM or MP4" : kind === "db" ? "a SQLite file or non-empty UTF-8 text" : "non-empty UTF-8 text"}`);
		else if (kind === feature.proof) proves = true;
	}
	if (!proves && problems.length === 0) problems.push(`${manifestPath}: no artifact of kind ${feature.proof}, the proof feature "${feature.id}" requires`);
	return problems;
}

function manifestsUnder(root: string, rel = ""): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, rel), { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap(entry => {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return manifestsUnder(root, path);
		return entry.isFile() && entry.name === "manifest.json" ? [path] : [];
	});
}

/** The reasons no manifest under `dir` proves `feature` for `tree`: an empty list means one does. */
export function featureLacks(repo: string, dir: string, feature: Feature, tree: string): string[] {
	const candidates: { path: string; source: string }[] = [];
	for (const rel of manifestsUnder(join(repo, dir)).sort().reverse()) {
		const path = `${dir.replace(/\/+$/, "")}/${rel}`;
		let source: string;
		try {
			source = readFileSync(join(repo, path), "utf8");
		} catch {
			continue;
		}
		let named: unknown;
		try {
			named = (JSON.parse(source) as { feature?: unknown } | null)?.feature;
		} catch {
			named = undefined;
		}
		if (named === feature.id) candidates.push({ path, source });
	}
	if (candidates.length === 0) return [`feature "${feature.id}" (${feature.proof}): no manifest.json for it under ${dir}/; run the verify-* driver for it, it writes the manifest`];
	const shown: string[] = [];
	for (const { path, source } of candidates) {
		const problems = problemsOf(repo, feature, tree, path, source);
		if (problems.length === 0) return [];
		if (shown.length < LISTED_MANIFESTS) shown.push(...problems.map(problem => `feature "${feature.id}": ${problem}`));
	}
	return shown;
}

function waiverOf(repo: string, entry: EvidenceEntry, changed: readonly string[]): string | undefined {
	const newest = changed.reduce((best, file) => Math.max(best, mtimeOf(repo, file)), 0);
	return walk(join(repo, entry.dir)).find(file => WAIVER.test(file.path) && file.mtimeMs > newest)?.path;
}

const strength = (proof: Proof): number => (proof === "screenshot" || proof === "video" ? 2 : 1);

function weakenings(repo: string, changed: readonly string[], features: readonly Feature[], base: Features): string[] {
	if (base.error !== undefined) return [];
	const files = trackedAndUntracked(repo);
	const problems: string[] = [];
	for (const was of base.features) {
		const now = features.find(feature => feature.id === was.id);
		let why: string | undefined;
		if (now === undefined) why = "the feature was removed";
		else if (strength(now.proof) < strength(was.proof)) why = `its proof went from ${was.proof} to ${now.proof}`;
		else if (files.some(file => matchesAny(was.paths, file) && !matchesAny(now.paths, file))) why = "its paths no longer cover files they covered";
		if (why !== undefined) problems.push(`${FEATURES_FILE} weakened in this session: ${was.id} (${why})`);
	}
	for (const feature of features) {
		if (base.features.some(was => was.id === feature.id) || strength(feature.proof) > 1) continue;
		if (changed.some(file => matchesAny(feature.paths, file))) problems.push(`${FEATURES_FILE} weakened in this session: ${feature.id} (a new feature covering changed UI files declares only ${feature.proof} proof)`);
	}
	return problems;
}

/**
 * What an evidence entry lacks. `changed` = the changed files matching the entry's paths, outside its dir. Each changed file
 * must lie in a feature of `.omp/verify/features.json`, and each such feature needs a manifest under the entry's dir whose
 * tree, artifacts and driver check out. `base`, when given, is the features file at the session base: a feature of it that
 * lost its proof strength or paths, or a new feature that covers changed files with only log or db proof, is a problem.
 * A waiver newer than the newest changed file waives all of it.
 */
export function evidenceVerdict(repo: string, entry: EvidenceEntry, changed: readonly string[], features: Features, base?: Features): EvidenceVerdict {
	if (changed.length === 0) return { verdict: "none", uncovered: [], lacking: [] };
	const waiver = waiverOf(repo, entry, changed);
	if (waiver !== undefined) return { verdict: "waived", waiver, uncovered: [], lacking: [] };
	const uncovered = features.error === undefined ? changed.filter(file => !features.features.some(feature => matchesAny(feature.paths, file))) : [];
	const lacking: string[] = features.error === undefined ? [] : [features.error];
	if (features.error === undefined && base !== undefined) lacking.push(...weakenings(repo, changed, features.features, base));
	for (const feature of features.features) {
		if (!changed.some(file => matchesAny(feature.paths, file))) continue;
		lacking.push(...featureLacks(repo, entry.dir, feature, evidenceTree(repo, feature.paths, entry.dir)));
	}
	return { verdict: uncovered.length === 0 && lacking.length === 0 ? "satisfied" : "missing", uncovered, lacking };
}

/** The mtime of a changed file; a deleted file counts as the moment its directory last changed. */
export function mtimeOf(repo: string, file: string): number {
	let path = join(repo, file);
	for (;;) {
		try {
			return statSync(path).mtimeMs;
		} catch {
			const up = dirname(path);
			if (up === path) return 0;
			path = up;
		}
	}
}

/** The files under `root` that hold something, with their mtimes; an empty file is no evidence and is left out. */
export function walk(root: string, rel = ""): FileTime[] {
	const out: FileTime[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, rel), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(root, path));
		else if (entry.isFile()) {
			try {
				const stat = statSync(join(root, path));
				if (stat.size > 0) out.push({ path, mtimeMs: stat.mtimeMs });
			} catch {
				continue;
			}
		}
	}
	return out;
}

const listed = (files: readonly string[]): string => `${files.slice(0, LISTED_FILES).join(", ")}${files.length > LISTED_FILES ? ` (+${files.length - LISTED_FILES} more)` : ""}`;

/** What the stop asks of an evidence entry whose changed files lack evidence: a driver-written manifest under the entry's dir, or a waiver there. */
export function evidenceAsk(entry: EvidenceEntry): string[] {
	return [
		`Evidence is a manifest.json that a verify-* driver wrote under ${entry.dir}/ for the current content of each feature's files; do not write one by hand.`,
		`If the surface cannot be driven, a non-empty waiver-<slug>.md in ${entry.dir}/ stating the reason is the only accepted substitute.`,
	];
}

export function evidenceText(repo: string, entry: EvidenceEntry, changed: readonly string[], verdict: EvidenceVerdict): string {
	const lines = [`done-gate: evidence "${entry.name}" is missing in ${repo}.`, `Changed files matching ${entry.paths.join(", ")}: ${listed(changed)}.`];
	if (verdict.uncovered.length > 0) lines.push(`No feature in ${FEATURES_FILE} covers: ${listed(verdict.uncovered)}. Add an entry { "id", "paths": [glob], "proof": "${PROOFS.join("|")}" } for them.`);
	for (const lack of verdict.lacking) lines.push(`- ${lack}`);
	lines.push(...evidenceAsk(entry));
	return lines.join("\n");
}

const flag = (args: readonly string[], name: string): string => {
	const at = args.indexOf(`--${name}`);
	const value = at < 0 ? undefined : args[at + 1];
	if (value === undefined) throw new Error(`missing --${name}`);
	return value;
};

/**
 * `bun evidence.ts tree --repo R --feature ID [--dir D]` prints the tree fingerprint a manifest for ID must carry.
 * `bun evidence.ts manifest --repo R --feature ID --driver PATH --command CMD --run DIR ARTIFACT...` writes DIR/manifest.json
 * for the feature's current files from artifacts given as RUN-RELATIVE-PATH[:KIND], refusing one that does not check out.
 */
export async function cli(args: readonly string[]): Promise<number> {
	const [mode] = args;
	const repo = resolve(flag(args, "repo"));
	const id = flag(args, "feature");
	const { features, error } = readFeatures(repo);
	const feature = features.find(item => item.id === id);
	if (!feature) throw new Error(error ?? `no feature "${id}" in ${FEATURES_FILE}`);
	const dir = args.includes("--dir") ? flag(args, "dir") : ".omp/verify/runs";
	const tree = evidenceTree(repo, feature.paths, dir);
	if (mode === "tree") {
		console.log(tree);
		return 0;
	}
	if (mode !== "manifest") throw new Error("usage: evidence.ts tree|manifest --repo R --feature ID ...");
	const run = resolve(flag(args, "run"));
	const names = args.filter((arg, i) => i > 0 && !arg.startsWith("--") && !args[i - 1].startsWith("--"));
	const artifacts = names.map(name => {
		const [path, kind = feature.proof] = name.split(/:(?=[^:/]*$)/);
		return { path, sha256: sha256(readFileSync(join(run, path))), kind };
	});
	const out = join(run, "manifest.json");
	if (!out.startsWith(`${repo}/`)) throw new Error(`--run must lie inside ${repo}`);
	mkdirSync(run, { recursive: true });
	writeFileSync(out, `${JSON.stringify({ feature: id, driver: flag(args, "driver"), command: flag(args, "command"), tree, artifacts }, null, 2)}\n`);
	const rel = out.slice(repo.length + 1);
	const problems = problemsOf(repo, feature, tree, rel, readFileSync(out, "utf8"));
	for (const problem of problems) console.error(problem);
	return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exitCode = await cli(process.argv.slice(2));
	} catch (error) {
		console.error(message(error));
		process.exitCode = 2;
	}
}
