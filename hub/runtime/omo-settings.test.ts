// orchestrator.keep_recent: the OmO orchestrator's project settings file (<cwd>/.omo/settings.json) carries compaction.keepRecentTokens.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg } from "../config.ts";
import { omo, omoArgs } from "./omo.ts";
import { syncKeepRecent } from "./omo-settings.ts";

let dir: string;
const saved = cfg.orchestrator;
const file = () => join(dir, ".omo", "settings.json");
const read = () => JSON.parse(readFileSync(file(), "utf8"));
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-keep-recent-"))));
afterEach(() => {
	cfg.orchestrator = saved;
	rmSync(dir, { recursive: true, force: true });
});

// The binary DOTZ_OMO names does not exist under test, so the process ends by itself; the file is written before it starts.
async function spawn(role: "orchestrator" | "lane") {
	const lane = role === "lane" ? { name: "t", dir, workerModel: "anthropic/test-worker", compactAt: 300_000, keepRecent: 30_000 } : undefined;
	const agent = omo.start({ role, cwd: dir, model: "anthropic/test-orch:low", env: {}, ...(lane ? { lane } : {}) });
	await agent.exited;
}

test("an OmO orchestrator spawn writes the configured keep_recent; without the key it writes 10000", async () => {
	await spawn("orchestrator");
	expect(read()).toEqual({ compaction: { keepRecentTokens: 10_000 } });
	cfg.orchestrator = { ...saved, keep_recent: 24_000 };
	await spawn("orchestrator");
	expect(read()).toEqual({ compaction: { keepRecentTokens: 24_000 } });
});

test("an existing project settings file keeps its other keys", () => {
	mkdirSync(join(dir, ".omo"));
	writeFileSync(file(), JSON.stringify({ theme: "dark", compaction: { enabled: false, reserveTokens: 9000 } }));
	expect(syncKeepRecent(dir, 10_000)).toBe(true);
	expect(read()).toEqual({ theme: "dark", compaction: { enabled: false, reserveTokens: 9000, keepRecentTokens: 10_000 } });
});

test("a value under 5000 becomes 5000", async () => {
	cfg.orchestrator = { ...saved, keep_recent: 1_000 };
	await spawn("orchestrator");
	expect(read().compaction.keepRecentTokens).toBe(5_000);
});

test("an unchanged value does not rewrite the file", () => {
	expect(syncKeepRecent(dir, 10_000)).toBe(true);
	const before = statSync(file()).ino;
	expect(syncKeepRecent(dir, 10_000)).toBe(false);
	expect(statSync(file()).ino).toBe(before);
	expect(syncKeepRecent(dir, 12_000)).toBe(true);
	expect(read().compaction.keepRecentTokens).toBe(12_000);
});

test("a file that is not a JSON object is left as it is", () => {
	mkdirSync(join(dir, ".omo"));
	writeFileSync(file(), "{ not json");
	expect(syncKeepRecent(dir, 10_000)).toBe(false);
	expect(readFileSync(file(), "utf8")).toBe("{ not json");
});

test("the orchestrator starts with --approve, without which OmO ignores the project settings file; a lane does not", () => {
	const args = (role: "orchestrator" | "lane") => omoArgs({ role, cwd: dir, model: "anthropic/claude-opus-5-5:medium", env: {} });
	expect(args("orchestrator")).toContain("--approve");
	expect(args("lane")).not.toContain("--approve");
});

test("a lane spawn writes no project settings file", async () => {
	await spawn("lane");
	expect(existsSync(join(dir, ".omo"))).toBe(false);
});
