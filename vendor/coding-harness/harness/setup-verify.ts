import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isRecord } from "./gate/util.ts";

/** One place where a machine is not what the repo describes. */
export interface Difference {
	kind: "missing" | "different" | "config" | "deps" | "omp" | "payload" | "stale";
	path: string;
	detail?: string;
}

/** Config keys that are filled once and then owned by the machine: the model-tiers extension rewrites `modelRoles` while omp runs, and omp owns `setupVersion`. */
export const SEED_ONLY_KEYS: readonly string[] = ["modelRoles", "setupVersion"];

const ROOTS = ["agent", "home"] as const;
const CONFIG = "agent/config.yml";
const HOME_FILES: Readonly<Record<string, string>> = { "home/AGENTS.md": "AGENTS.md" };
const UNLISTED = new Set(["node_modules", "logs", ".DS_Store", "__pycache__"]);

function walk(root: string, prefix: string): string[] {
	return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
		if (UNLISTED.has(entry.name)) return [];
		const path = `${prefix}/${entry.name}`;
		return entry.isDirectory() ? walk(root, path) : [path];
	});
}

/** The paths the repo installs, relative to the repo: what git tracks under `agent/` and `home/`, or everything there when the source is not a git checkout. */
export function payloadFiles(source: string): string[] {
	const listed = spawnSync("git", ["-C", source, "ls-files", "-z", "--", ...ROOTS], { encoding: "utf8" });
	const tracked = listed.status === 0 ? listed.stdout.split("\0").filter(path => path !== "") : [];
	return (tracked.length > 0 ? tracked : ROOTS.flatMap(root => walk(source, root))).sort();
}

/** Where a payload file belongs under a home directory, or undefined for a path under `home/` that has no place. */
export function targetOf(home: string, file: string): string | undefined {
	if (file.startsWith("agent/")) return join(home, ".omp", "agent", file.slice("agent/".length));
	const place = HOME_FILES[file];
	return place === undefined ? undefined : join(home, place);
}

function yamlOf(path: string): Record<string, unknown> {
	const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
	return isRecord(parsed) ? parsed : {};
}

function holds(wanted: unknown, found: unknown): boolean {
	if (!isRecord(wanted)) return Bun.deepEquals(wanted, found, true);
	return isRecord(found) && Object.keys(wanted).every(key => key in found && holds(wanted[key], found[key]));
}

function configDifferences(source: string, home: string): Difference[] {
	const target = join(home, ".omp", "agent", "config.yml");
	if (!existsSync(target)) return [{ kind: "missing", path: target }];
	const wanted = yamlOf(join(source, CONFIG));
	const found = yamlOf(target);
	return Object.keys(wanted).flatMap((key): Difference[] => {
		if (SEED_ONLY_KEYS.includes(key)) return key in found ? [] : [{ kind: "config", path: target, detail: `${key} is absent` }];
		return holds(wanted[key], found[key]) ? [] : [{ kind: "config", path: target, detail: `${key} differs from the repo` }];
	});
}

function staleDifferences(source: string, home: string): Difference[] {
	const recorded = join(home, ".omp", "agent", "harness", ".setup-version");
	if (!existsSync(recorded)) return [];
	const version = readFileSync(recorded, "utf8").trim();
	if (version === "" || spawnSync("git", ["-C", source, "rev-parse", "--verify", "--quiet", `${version}^{commit}`], { encoding: "utf8" }).status !== 0) return [];
	const removed = spawnSync("git", ["-C", source, "diff", "-z", "--name-only", "--no-renames", "--diff-filter=D", version, "HEAD", "--", ...ROOTS], { encoding: "utf8" });
	if (removed.status !== 0) return [];
	const realHome = realpathSync(home);
	return removed.stdout.split("\0").flatMap((file): Difference[] => {
		const target = file === "" ? undefined : targetOf(home, file);
		if (target === undefined || !existsSync(target)) return [];
		const reachedThroughLink = realpathSync(dirname(target)) !== join(realHome, relative(home, dirname(target)));
		return reachedThroughLink ? [] : [{ kind: "stale", path: target, detail: `the repo deleted or renamed ${file} since ${version.slice(0, 12)}; back it up, then delete it` }];
	});
}

function installed(manifest: string, dir: string): boolean {
	const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
	const names = isRecord(parsed) ? ["dependencies", "devDependencies"].flatMap(field => (isRecord(parsed[field]) ? Object.keys(parsed[field]) : [])) : [];
	return names.every(name => existsSync(join(dir, "node_modules", name, "package.json")));
}

/**
 * Everything on a machine that is not what the repo at `source` describes: payload files that are missing or have other
 * bytes, config keys with another value (seed-only keys only have to exist; machine-only keys at any depth are fine),
 * files the repo deleted or renamed since the commit in `.setup-version` that are still installed
 * (`stale`), dependencies not installed, and an omp that does not run. A payload path that is not a regular file, or has no place on a machine, is reported as a
 * defect of the repo (`payload`). An empty result means the setup is complete.
 */
export function verifySetup(input: { source: string; home: string; ompCheck?: boolean }): Difference[] {
	const { source, home } = input;
	const files = payloadFiles(source);
	const found: Difference[] = [];
	for (const file of files) {
		if (file === CONFIG) continue;
		const target = targetOf(home, file);
		if (target === undefined || !lstatSync(join(source, file)).isFile()) {
			found.push({ kind: "payload", path: join(source, file), detail: target === undefined ? "has no place on a machine" : "is not a regular file; the payload holds regular files only" });
		} else if (!existsSync(target)) {
			found.push({ kind: "missing", path: target });
		} else if (!lstatSync(target).isFile() || !readFileSync(join(source, file)).equals(readFileSync(target))) {
			found.push({ kind: "different", path: target });
		}
	}
	found.push(...configDifferences(source, home), ...staleDifferences(source, home));
	for (const file of files.filter(path => /^agent\/(?:harness|skills\/[^/]+)\/package\.json$/.test(path))) {
		const dir = join(targetOf(home, file) ?? "", "..");
		if (!installed(join(source, file), dir)) found.push({ kind: "deps", path: join(dir, "node_modules"), detail: `run \`bun install --frozen-lockfile\` in ${dir}` });
	}
	if (input.ompCheck !== false && spawnSync("omp", ["--version"], { encoding: "utf8" }).status !== 0) found.push({ kind: "omp", path: "omp", detail: "install omp first" });
	return found;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const homeAt = argv.indexOf("--home");
	const home = resolve(homeAt === -1 ? homedir() : (argv[homeAt + 1] ?? ""));
	const source = resolve(import.meta.dir, "..", "..");
	const known = argv.every((arg, i) => arg === "--home" || arg === "--skip-omp-check" || (homeAt !== -1 && i === homeAt + 1));
	if (!known || !existsSync(join(source, "agent", "skills")) || !existsSync(join(source, "home"))) {
		console.error("usage: bun agent/harness/setup-verify.ts [--home <dir>] [--skip-omp-check]   (run it from a checkout of the repo, not from ~/.omp/agent)");
		process.exitCode = 2;
	} else {
		const found = verifySetup({ source, home, ompCheck: !argv.includes("--skip-omp-check") });
		for (const difference of found) console.log(`${difference.kind}\t${difference.path}${difference.detail === undefined ? "" : `\t${difference.detail}`}`);
		console.log(found.length === 0 ? `setup verified: ${home} matches ${source}` : `${found.length} difference(s); see SETUP.md`);
		process.exitCode = found.length === 0 ? 0 : 1;
	}
}
