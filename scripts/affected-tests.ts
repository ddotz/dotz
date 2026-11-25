import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize, parse } from "node:path";
import { FEW_FILES } from "../hub/runtime/test-slot.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE = /\.(?:ts|tsx|js|mjs)$/;
const TEST = /\.test\.(?:ts|tsx|js|mjs)$/;
const SLOW_NAME = /-web\.test\.|golden|e2e|load-qa/;
const SLOW_LIST = "scripts/slow-tests.txt";
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];
const STATIC = /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const git = (root: string, args: string[]): string[] => {
	const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
	return r.stdout.split("\n").filter(Boolean);
};

/** Repo files that import each repo file: key = imported file, value = the files that import it directly. */
export type ReverseGraph = Map<string, Set<string>>;

const resolveSpecifier = (from: string, spec: string, files: Set<string>): string | undefined => {
	if (!spec.startsWith(".")) return undefined;
	const base = normalize(join(dirname(from), spec));
	if (files.has(base)) return base;
	for (const ext of EXTENSIONS) if (files.has(base + ext)) return base + ext;
	return undefined;
};

type Sources = { files: Set<string>; text: Map<string, string>; specs: Map<string, string[]> };

const loadSources = (root: string): Sources => {
	const files = new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).filter(f => SOURCE.test(f) && existsSync(join(root, f))));
	const text = new Map<string, string>();
	const specs = new Map<string, string[]>();
	for (const file of files) {
		const source = readFileSync(join(root, file), "utf8");
		text.set(file, source);
		specs.set(file, [...source.matchAll(STATIC)].map(m => m[1] ?? m[2]).concat([...source.matchAll(DYNAMIC)].map(m => m[1])));
	}
	return { files, text, specs };
};

const graphOf = ({ files, specs }: Sources): ReverseGraph => {
	const graph: ReverseGraph = new Map();
	for (const [file, list] of specs) {
		for (const spec of list) {
			const target = resolveSpecifier(file, spec, files);
			if (!target || target === file) continue;
			let importers = graph.get(target);
			if (!importers) graph.set(target, (importers = new Set()));
			importers.add(file);
		}
	}
	return graph;
};

/** Reverse import graph of the tracked and untracked-not-ignored source files under `root`, relative specifiers only. */
export const buildGraph = (root: string): ReverseGraph => graphOf(loadSources(root));

const importNames = (file: string): string[] => {
	const name = parse(file).name;
	return name === "index" ? [name, basename(dirname(file))] : [name];
};

const specName = (spec: string): string => parse(spec.replace(/\/+$/, "")).name;

const slowListed = (root: string): Set<string> => {
	const path = join(root, SLOW_LIST);
	return new Set(existsSync(path) ? readFileSync(path, "utf8").split("\n").map(l => l.trim()).filter(Boolean) : []);
};

export type Affected = { tests: string[]; skippedSlow: string[] };

/**
 * Test files that a change to `changed` (repo-relative paths) can break: the changed test files, the tests that import a changed file,
 * and the tests that import a file that imports a changed file. Two kinds of change reach tests the import graph cannot:
 * a changed file under web/ (browser code that tests load by path) selects every test whose text names its repo path or its file name, and
 * runs the slow tier too; a deleted file (no import resolves to it any more) selects the files that import its name without extension.
 * Slow-tier tests (scripts/slow-tests.txt, `*-web.test.*`, golden, e2e, load-qa) are left out and returned in `skippedSlow` otherwise.
 */
export function affectedTests(root: string, changed: string[]): Affected {
	const sources = loadSources(root);
	const graph = graphOf(sources);
	const tests = [...sources.files].filter(f => TEST.test(f));
	const hit = new Set<string>();
	const addWithImporters = (file: string): void => {
		hit.add(file);
		for (const first of graph.get(file) ?? []) {
			hit.add(first);
			for (const second of graph.get(first) ?? []) hit.add(second);
		}
	};
	for (const file of changed) {
		addWithImporters(file);
		if (file.startsWith("web/")) {
			const name = basename(file);
			for (const test of tests) {
				const text = sources.text.get(test)!;
				if (text.includes(file) || text.includes(name)) hit.add(test);
			}
		}
		if (!existsSync(join(root, file))) {
			const names = new Set(importNames(file));
			for (const [importer, specs] of sources.specs) if (specs.some(spec => names.has(specName(spec)))) addWithImporters(importer);
		}
	}
	const slow = slowListed(root);
	const withSlow = changed.some(f => f.startsWith("web/"));
	const picked: string[] = [];
	const skippedSlow: string[] = [];
	for (const file of [...hit].sort()) {
		if (!TEST.test(file) || !existsSync(join(root, file))) continue;
		if (!withSlow && (slow.has(file) || SLOW_NAME.test(file))) skippedSlow.push(file);
		else picked.push(file);
	}
	return { tests: picked, skippedSlow };
}

/** The `bun test` commands for `tests`: `--parallel=4` (per-file isolation, which hub/runtime/test-setup.ts assumes), at most FEW_FILES files each, so no run counts as a full suite. */
export function testCommands(tests: string[]): string[][] {
	const commands: string[][] = [];
	for (let i = 0; i < tests.length; i += FEW_FILES) commands.push(["bun", "test", "--parallel=4", ...tests.slice(i, i + FEW_FILES).map(t => `./${t}`)]);
	return commands;
}

/** Runs the commands one after the other in `cwd`; stops at the first one that fails and returns its exit status (0 when all pass). */
export function runCommands(commands: string[][], cwd: string): number {
	for (const command of commands) {
		const status = spawnSync(command[0], command.slice(1), { cwd, stdio: "inherit" }).status ?? 1;
		if (status !== 0) return status;
	}
	return 0;
}

/** `git diff --name-only HEAD` plus the untracked files, repo-relative. */
export function changedFiles(root: string): string[] {
	return [...new Set([...git(root, ["diff", "--name-only", "--no-renames", "HEAD"]), ...git(root, ["ls-files", "--others", "--exclude-standard"])])];
}

const main = (): number => {
	const args = process.argv.slice(2);
	const print = args.includes("--print");
	const given = args.filter(a => !a.startsWith("--"));
	const changed = given.length > 0 ? given : changedFiles(ROOT);
	const { tests, skippedSlow } = affectedTests(ROOT, changed);
	if (skippedSlow.length > 0) console.log(`skipped ${skippedSlow.length} slow: ${skippedSlow.join(" ")}`);
	if (tests.length === 0) {
		console.log("no affected test");
		return 0;
	}
	const commands = testCommands(tests);
	if (print) {
		for (const command of commands) console.log(command.join(" "));
		return 0;
	}
	console.log(`running ${tests.length} test file${tests.length === 1 ? "" : "s"}${commands.length > 1 ? ` in ${commands.length} batches` : ""}`);
	return runCommands(commands, ROOT);
};

if (import.meta.main) process.exit(main());
