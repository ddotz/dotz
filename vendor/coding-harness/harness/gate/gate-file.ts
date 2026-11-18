import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, list, message } from "./util.ts";

const DEFAULT_TIMEOUT_SEC = 300;

export interface Check {
	name: string;
	command: string;
	paths: string[];
	timeoutSec: number;
}

export interface EvidenceEntry {
	name: string;
	paths: string[];
	dir: string;
}

export interface GateFile {
	checks: Check[];
	evidence: EvidenceEntry[];
}

export const gateFilePath = (repo: string) => join(repo, ".omp", "gate.json");

function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be a non-empty string`);
	return value;
}

function repoRelative(value: unknown, where: string): string {
	const path = text(value, where).replace(/^\.\//, "");
	if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`${where} must be relative to the repo root and must not contain ..`);
	return path;
}

function globs(value: unknown, where: string): string[] {
	const items = list(value);
	if (!items || items.length === 0) throw new Error(`${where} must be a non-empty array of globs`);
	return items.map((item, i) => repoRelative(item, `${where}[${i}]`));
}

function known(item: Record<string, unknown>, keys: readonly string[], where: string): void {
	const extra = Object.keys(item).find(key => !keys.includes(key));
	if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}" (known: ${keys.join(", ")})`);
}

function section<T extends { name: string }>(value: unknown, where: string, keys: readonly string[], parse: (item: Record<string, unknown>, at: string) => T): T[] {
	if (value === undefined) return [];
	const items = list(value);
	if (!items) throw new Error(`${where} must be an array`);
	const parsed = items.map((item, i) => {
		if (!isRecord(item)) throw new Error(`${where}[${i}] must be an object`);
		known(item, keys, `${where}[${i}]`);
		return parse(item, `${where}[${i}]`);
	});
	const names = parsed.map(item => item.name);
	const duplicate = names.find((name, i) => names.indexOf(name) !== i);
	if (duplicate !== undefined) throw new Error(`${where} has two entries named "${duplicate}"`);
	return parsed;
}

/** Parses <repo>/.omp/gate.json; every malformed shape and every unknown key is an error, so a typo cannot silently leave a check out. */
export function parseGateFile(source: string): GateFile {
	let data: unknown;
	try {
		data = JSON.parse(source);
	} catch (error) {
		throw new Error(`not valid JSON (${message(error)})`);
	}
	if (!isRecord(data)) throw new Error("must be a JSON object with `checks` and/or `evidence`");
	known(data, ["checks", "evidence"], "the gate file");
	const checks = section<Check>(data.checks, "checks", ["name", "command", "paths", "timeoutSec"], (item, at) => {
		const timeout = item.timeoutSec;
		if (timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) throw new Error(`${at}.timeoutSec must be a positive number`);
		return { name: text(item.name, `${at}.name`), command: text(item.command, `${at}.command`), paths: globs(item.paths, `${at}.paths`), timeoutSec: timeout ?? DEFAULT_TIMEOUT_SEC };
	});
	const evidence = section<EvidenceEntry>(data.evidence, "evidence", ["name", "paths", "dir"], (item, at) => ({
		name: text(item.name, `${at}.name`),
		paths: globs(item.paths, `${at}.paths`),
		dir: repoRelative(item.dir, `${at}.dir`),
	}));
	return { checks, evidence };
}

export function readGateFile(repo: string): GateFile {
	try {
		return parseGateFile(readFileSync(gateFilePath(repo), "utf8"));
	} catch (error) {
		throw new Error(`${gateFilePath(repo)}: ${message(error)}`);
	}
}

const globCache = new Map<string, Bun.Glob>();

export function matchesAny(patterns: readonly string[], file: string): boolean {
	return patterns.some(pattern => {
		let glob = globCache.get(pattern);
		if (!glob) {
			glob = new Bun.Glob(pattern);
			globCache.set(pattern, glob);
		}
		return glob.match(file);
	});
}
