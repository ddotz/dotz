import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TEXT_BYTES } from "./base-text.ts";
import { repoStateKey, stateDir } from "./log.ts";
import type { TextAt } from "./types.ts";
import { isRecord } from "./util.ts";

const GATE_FILE = ".omp/gate.json";
const LINT_DIR = ".omp/lint";
const MAX_GATE_FILES = 2000;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

interface Saved {
	texts: Record<string, string>;
	unknown: string[];
}

type Current = Map<string, string | undefined>;

/** Whether a repo-relative path is a gate file: `.omp/gate.json` or anything under `.omp/lint/`. */
export const isGateFile = (file: string): boolean => file === GATE_FILE || file.startsWith(`${LINT_DIR}/`);

const recordPath = (repo: string) => join(stateDir(), `${repoStateKey(repo)}.accepted.json`);

function textOf(path: string): string | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return undefined;
		return decoder.decode(readFileSync(path));
	} catch {
		return undefined;
	}
}

function listLint(repo: string, dir: string, found: string[]): void {
	let names: string[];
	try {
		names = readdirSync(join(repo, dir)).sort();
	} catch {
		return;
	}
	for (const name of names) {
		if (found.length >= MAX_GATE_FILES) return;
		const path = `${dir}/${name}`;
		try {
			const stat = lstatSync(join(repo, path));
			if (stat.isDirectory()) listLint(repo, path, found);
			else if (stat.isFile()) found.push(path);
		} catch {
			continue;
		}
	}
}

function current(repo: string): Current {
	const files: string[] = [];
	if (existsSync(join(repo, GATE_FILE))) files.push(GATE_FILE);
	listLint(repo, LINT_DIR, files);
	return new Map(files.map(file => [file, textOf(join(repo, file))]));
}

function load(repo: string): Saved | undefined {
	try {
		const data: unknown = JSON.parse(readFileSync(recordPath(repo), "utf8"));
		if (!isRecord(data) || !isRecord(data.texts) || !Array.isArray(data.unknown)) return undefined;
		const texts: Record<string, string> = {};
		for (const [file, text] of Object.entries(data.texts)) if (typeof text === "string") texts[file] = text;
		return { texts, unknown: data.unknown.filter((file): file is string => typeof file === "string") };
	} catch {
		return undefined;
	}
}

function save(repo: string): void {
	const texts: Record<string, string> = {};
	const unknown: string[] = [];
	for (const [file, text] of current(repo)) {
		if (text === undefined) unknown.push(file);
		else texts[file] = text;
	}
	try {
		mkdirSync(stateDir(), { recursive: true });
		const path = recordPath(repo);
		writeFileSync(`${path}.tmp`, JSON.stringify({ repo, texts, unknown }));
		renameSync(`${path}.tmp`, path);
	} catch {
		return;
	}
}

/** Records the gate files of `repo` as they are now as the accepted state when none is recorded yet; a record that exists is left alone. */
export function ensureAccepted(repo: string): void {
	if (load(repo) === undefined) save(repo);
}

/** Makes the gate files of `repo` as they are now the accepted state. */
export function recordAccepted(repo: string): void {
	save(repo);
}

/** The last accepted text of a gate file of `repo`: its text, null when it did not exist, undefined for a path that is no gate file or a file too big to keep; undefined itself when no state is recorded for the repo. */
export function acceptedTextAt(repo: string): TextAt | undefined {
	const record = load(repo);
	if (record === undefined) return undefined;
	return async file => {
		if (!isGateFile(file) || record.unknown.includes(file)) return undefined;
		return record.texts[file] ?? null;
	};
}

type Standing = "same" | "drifted";

function standing(repo: string): Map<string, Standing> {
	const found = new Map<string, Standing>();
	const record = load(repo);
	if (record === undefined) return found;
	const now = current(repo);
	for (const file of [...new Set([...Object.keys(record.texts), ...record.unknown, ...now.keys()])].sort()) {
		if (record.unknown.includes(file)) continue;
		const after = now.get(file);
		if (now.has(file) && after === undefined) continue;
		found.set(file, record.texts[file] === after ? "same" : "drifted");
	}
	return found;
}

/** The gate files of `repo` whose text differs from the accepted state, modified, deleted or new, in path order; none when no state is recorded. A file too big to keep never drifts. */
export function driftedGateFiles(repo: string): string[] {
	return [...standing(repo)].filter(([, state]) => state === "drifted").map(([file]) => file);
}

/** The gate files of `repo` that exist and hold their accepted text; they are not a change of the session whatever the run did to them. */
export function acceptedGateFiles(repo: string): Set<string> {
	return new Set([...standing(repo)].filter(([, state]) => state === "same").map(([file]) => file));
}
