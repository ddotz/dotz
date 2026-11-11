import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function compactMessages(dataDir: string): string[] {
	const env = { ...process.env, DOTZ_DIR: dataDir, DOTZ_ORCHESTRATOR: "1", DOTZ_RUNTIME: "omo" } as Record<string, string | undefined>;
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
