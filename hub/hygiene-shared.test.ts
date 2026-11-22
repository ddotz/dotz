import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTempSessions } from "./cleanup.ts";
import { runDataCleanup, worktreeCleanupApplies } from "./hygiene.ts";

const DAY = 86_400_000;
let agentDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "dotz-hygiene-shared-"));
	saved = { OMO_CODING_AGENT_DIR: process.env.OMO_CODING_AGENT_DIR, DOTZ_SHARED_CLEANUP: process.env.DOTZ_SHARED_CLEANUP };
	process.env.OMO_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

function staleTempSession(sessions: string, name: string): void {
	const dir = join(sessions, name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", cwd: "/tmp/dotz-hygiene-shared-no-such-dir" })}\n`);
	const old = new Date(Date.now() - 2 * DAY);
	utimesSync(file, old, old);
	utimesSync(dir, old, old);
}

test("a gateway started with DOTZ_SHARED_CLEANUP=off keeps the harness sessions a normal pass prunes and skips the omp worktree cleanup", () => {
	const sessions = join(agentDir, "sessions");
	staleTempSession(sessions, "kept");
	process.env.DOTZ_SHARED_CLEANUP = "off";
	runDataCleanup();
	expect(readdirSync(sessions)).toEqual(["kept"]);
	expect(worktreeCleanupApplies(["omp"])).toBe(false);
	expect(pruneTempSessions(sessions, DAY).removed).toEqual(["kept"]);

	delete process.env.DOTZ_SHARED_CLEANUP;
	expect(worktreeCleanupApplies(["omp"])).toBe(true);
});
