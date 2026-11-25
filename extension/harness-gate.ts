import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HarnessGate = { extension: string; bootstrap: string };

export const BOOTSTRAP_LIMIT_MS = 100_000;

/** Set on a coding-harness session to its payload dir: dotz's own guard copies stand down for the payload's originals (guard-config.ts installedOriginal). */
export const CODING_HARNESS_ENV = "DOTZ_CODING_HARNESS";

export function harnessFiles(agentDir: string): HarnessGate | undefined {
	const gate = { extension: join(agentDir, "extensions", "done-gate.ts"), bootstrap: join(agentDir, "harness", "gate", "bootstrap.ts") };
	return existsSync(gate.extension) && existsSync(gate.bootstrap) ? gate : undefined;
}

const NOT_A_REPO = { ok: false, out: "" };
function gitIn(cwd: string, ...args: string[]): { ok: boolean; out: string } {
	try {
		return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim() };
	} catch {
		return NOT_A_REPO;
	}
}

const GENERATED = [
	{ path: ".omp/gate.json", line: "/.omp/gate.json" },
	{ path: ".omp/lint", line: "/.omp/lint/" },
];

function readUnlessMissing(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw e;
	}
}

export function excludeGenerated(checkout: string): void {
	const file = gitIn(checkout, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
	if (!file.ok || !file.out) return;
	const text = readUnlessMissing(file.out);
	const have = new Set(text.split("\n").map(l => l.trim()));
	const add = GENERATED.filter(g => !have.has(g.line) && !gitIn(checkout, "ls-tree", "-r", "--name-only", "HEAD", "--", g.path).out).map(g => g.line);
	if (!add.length) return;
	mkdirSync(dirname(file.out), { recursive: true });
	appendFileSync(file.out, `${text && !text.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
}
