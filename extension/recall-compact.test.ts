import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the orchestrator extension sends into the session after a compaction, in a data dir that holds only a state.json.
const SCRIPT = `
const handlers = {}; const sent = [];
const base = { on: (n, f) => (handlers[n] ??= []).push(f), sendMessage: m => sent.push(m) };
const pi = new Proxy(base, { get: (t, p) => (p in t ? t[p] : p === "zod" ? undefined : () => undefined) });
(await import("./extension/index.ts")).default(pi);
for (const f of handlers.session_compact ?? []) f({}, { agent: { kind: "main" } });
console.log(JSON.stringify(sent.map(m => String(m.content))));
process.exit(0);`;

function compactMessages(dataDir: string, extraEnv: Record<string, string> = {}): string[] {
	const env = { ...process.env, DOTZ_DIR: dataDir, DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omo", ...extraEnv } as Record<string, string | undefined>;
	for (const k of ["OMO_SENPI_TASK_DEPTH", "DOTZ_LANE", "DOTZ_CONV"]) delete env[k];
	const r = Bun.spawnSync([process.execPath, "-e", SCRIPT], { cwd: join(import.meta.dir, ".."), env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "[]");
}

test("after a compaction the state is the newest-first task list under the budget, not a raw cut of state.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-recall-compact-"));
	try {
		const open_tasks = Array.from({ length: 120 }, (_, i) => ({ id: `task-${i}`, what: `work item number ${i}`, since: "2026-11-01", next: "keep going" }));
		writeFileSync(join(dir, "state.json"), JSON.stringify({ open_tasks, notes: { long: "x".repeat(5000) } }, null, 2));
		const text = compactMessages(dir).join("\n");
		const state = text.slice(text.search(/Current state\.json:\n/) + "Current state.json:\n".length);
		expect(state.length).toBeLessThanOrEqual(4000);
		const ids = [...state.matchAll(/^- task-(\d+):/gm)].map(m => Number(m[1]));
		expect(ids.length).toBeGreaterThan(14); // the raw 4,000-character cut showed 14 of the pretty-printed list
		expect(ids[0]).toBe(119); // newest first
		expect(ids).toEqual(ids.toSorted((a, b) => b - a));
		expect(ids).not.toContain(0); // the oldest are what the budget drops
		expect(state).toContain("state.json"); // the cut names the file to read for the rest
		expect(() => JSON.parse(state)).toThrow(); // a listing, never a half-cut JSON object
		expect(state.trimEnd().split("\n").every(l => l.startsWith("- task-") || l.startsWith("open_tasks:") || l.startsWith("other keys:") || l.startsWith("[... cut at"))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The contract's re-read is the one `[dotz] ` message of a compaction (the guard sends its own rules message beside it). Its data dir holds one marker per
// part that follows MODE; MODE itself is the repo's (the data dir holds none).
const MODE_HEADINGS = readFileSync(join(import.meta.dir, "..", "MODE.md"), "utf8").split("\n").filter(line => line.startsWith("## "));
function contractDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dotz-recall-compact-"));
	mkdirSync(join(dir, "identity"));
	writeFileSync(join(dir, "identity", "IDENTITY.md"), "identity marker 7f3a");
	writeFileSync(join(dir, "RULES.md"), "rule marker 41c9");
	writeFileSync(join(dir, "LESSONS.md"), "lesson marker 88d2");
	writeFileSync(join(dir, "state.json"), JSON.stringify({ open_tasks: [{ id: "t1", what: "state marker 5e10" }] }));
	return dir;
}
const reread = (dir: string, extraEnv?: Record<string, string>): string => compactMessages(dir, extraEnv).find(m => m.startsWith("[dotz] "))!;

test("with identity and MODE in the system prompt (DOTZ_MODE_IN_SYSTEM) the re-read leaves both out and keeps the rules, lessons and state", () => {
	const dir = contractDir();
	try {
		const text = reread(dir, { DOTZ_RUNTIME: "omp", DOTZ_MODE_IN_SYSTEM: "1" });
		expect(text).not.toContain("identity marker 7f3a");
		for (const heading of MODE_HEADINGS) expect(text).not.toContain(heading);
		for (const marker of ["Owner rules:\nrule marker 41c9", "Lessons:\nlesson marker 88d2", "Current state.json:\nopen_tasks:\n- t1: state marker 5e10"]) expect(text).toContain(marker);
		expect(text).toContain("system prompt"); // says where the two are
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("without the flag the re-read is unchanged: identity, MODE, rules, lessons and state, in that order", () => {
	const dir = contractDir();
	try {
		const text = reread(dir);
		expect(text.startsWith("[dotz] Contract re-read after compaction:\n\nIdentity:\nidentity marker 7f3a\n\n")).toBe(true);
		const at = ["identity marker 7f3a", MODE_HEADINGS.at(-1)!, "Owner rules:\nrule marker 41c9", "Lessons:\nlesson marker 88d2", "Current state.json:\nopen_tasks:\n- t1: state marker 5e10"].map(part => text.indexOf(part));
		expect(at.every(i => i >= 0)).toBe(true);
		expect(at).toEqual(at.toSorted((a, b) => a - b));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
