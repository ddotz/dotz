// Nightly session hygiene leaves alone only the session files a running process holds (hub/hygiene.ts liveSessionFiles): a lane
// that stopped keeps its registry entry, and its idle file is cleaned like any other. Synthetic sessions in a temp dir; DOTZ_DIR
// points at the throwaway config of the bun test preload (hub/runtime/test-setup.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveSessionFiles } from "./hygiene.ts";
import { lanes, type Lane } from "./lanes.ts";
import { runSessionHygiene } from "./session-hygiene.ts";

const DAY = 86_400_000;
const FAKE_GH = `ghp_${"A1b2".repeat(9)}`;

let root = "", folder = "";
beforeEach(() => {
	lanes.clear();
	root = mkdtempSync(join(tmpdir(), "hygiene-test-"));
	folder = join(root, "--home-x--");
	mkdirSync(folder);
});
afterEach(() => {
	lanes.clear();
	rmSync(root, { recursive: true, force: true });
});

const laneSession = (name: string, running: boolean): string => {
	const file = join(folder, `2026-11-07T00-00-00-000Z_${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `키 ${FAKE_GH}` }] } })}\n`, { mode: 0o644 });
	const at = new Date(Date.now() - 2 * DAY);
	utimesSync(file, at, at);
	lanes.set(name, { name, cwd: "/tmp", model: "m", status: running ? "idle" : "exited", startedAt: "", reports: 0, ctx: {} as Lane["ctx"], lastText: "", proc: running ? ({} as Lane["proc"]) : undefined, sessionFile: file });
	return file;
};
const nightly = () => runSessionHygiene({ roots: [root], secrets: [], keepDays: 90, dryRun: false, active: new Set(liveSessionFiles()) });

test("a stopped lane's session file is masked and set 600", () => {
	const file = laneSession("stopped1", false);
	const r = nightly();
	expect(r.skipped.active).toBe(0);
	const text = readFileSync(file, "utf8");
	expect(text).toContain("[가림:github]");
	expect(text).not.toContain(FAKE_GH);
	expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a running lane's session file is left alone", () => {
	const file = laneSession("running1", true);
	const before = readFileSync(file, "utf8");
	const r = nightly();
	expect(r.skipped.active).toBe(1);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(statSync(file).mode & 0o777).toBe(0o644);
});
