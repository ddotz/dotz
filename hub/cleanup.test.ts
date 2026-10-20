// Data cleanup (eval 2026-10-20 L3/C1): hub.log and inbox/outbox are rotated with their recent tail kept live, old
// uploads and the OmO sessions of deleted temp folders go, and open tasks waiting on an ended lane are closed with a
// reason into a history file instead of lingering in state.json.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { closeDeadLaneTasks, waitsForOwner, pruneArchives, pruneTempSessions, pruneUploads, removeSessionsFor, rotateFile } from "./cleanup.ts";

const NOW = Date.parse("2026-10-20T09:00:00Z");
const DAY = 86_400_000;
const tmp = () => mkdtempSync(join(tmpdir(), "dotz-cleanup-"));
const age = (path: string, ms: number) => utimesSync(path, new Date(NOW - ms), new Date(NOW - ms));

test("a file past its limit keeps whole recent lines live and moves the rest to a gzip archive", () => {
	const dir = tmp();
	const file = join(dir, "inbox.jsonl");
	const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(80) }));
	writeFileSync(file, `${lines.join("\n")}\n`);
	expect(rotateFile(file, 1_000_000, 2000, NOW)).toBeUndefined();
	const r = rotateFile(file, 5000, 2000, NOW)!;
	expect(r.before).toBeGreaterThan(5000);
	const live = readFileSync(file, "utf8");
	expect(live.length).toBeLessThanOrEqual(2000);
	expect(live.endsWith(`${lines[99]}\n`)).toBe(true);
	expect(live.startsWith("{")).toBe(true);
	const archived = gunzipSync(readFileSync(r.archive)).toString("utf8");
	// Nothing lost, nothing duplicated.
	expect(archived + live).toBe(`${lines.join("\n")}\n`);
	expect(r.archive).toBe(join(dir, "archive", "inbox.jsonl.20261020-090000.gz"));
});

test("archives past their retention go, others and foreign files stay", () => {
	const dir = tmp();
	const a = join(dir, "archive");
	mkdirSync(a);
	for (const n of ["hub.log.20260101-000000.gz", "hub.log.20261019-000000.gz", "inbox.jsonl.20260101-000000.gz"]) writeFileSync(join(a, n), "x");
	age(join(a, "hub.log.20260101-000000.gz"), 100 * DAY);
	age(join(a, "inbox.jsonl.20260101-000000.gz"), 100 * DAY);
	expect(pruneArchives(a, "hub.log", 90, NOW)).toEqual(["hub.log.20260101-000000.gz"]);
	expect(readdirSync(a).sort()).toEqual(["hub.log.20261019-000000.gz", "inbox.jsonl.20260101-000000.gz"]);
});

test("upload day folders older than the retention go; recent ones and non-date names stay", () => {
	const dir = tmp();
	for (const d of ["2026-08-01", "2026-10-19", "keep-me"]) {
		mkdirSync(join(dir, d));
		writeFileSync(join(dir, d, "f.txt"), "x");
	}
	expect(pruneUploads(dir, 30, NOW)).toEqual(["2026-08-01"]);
	expect(readdirSync(dir).sort()).toEqual(["2026-10-19", "keep-me"]);
	expect(pruneUploads(join(dir, "missing"), 30, NOW)).toEqual([]);
});

test("idle sessions of mkdtemp folders and of deleted /tmp folders are pruned; live, recent and real ones stay", () => {
	const sessions = tmp();
	const varRoot = tmp();
	expect(varRoot).toMatch(/^\/(private\/)?var\/folders\//);
	const tmpLive = mkdtempSync("/tmp/dotz-cleanup-");
	const mk = (name: string, cwd: string, idle: number) => {
		const d = join(sessions, name);
		mkdirSync(d);
		const f = join(d, "2026-10-19T00-00-00-000Z_x.jsonl");
		writeFileSync(f, `${JSON.stringify({ type: "session", cwd })}\n{"type":"message"}\n`);
		age(f, idle);
		age(d, idle);
	};
	mk("var-idle", varRoot, 2 * DAY);
	mk("var-recent", varRoot, 60_000);
	mk("tmp-gone-idle", "/tmp/dotz-cleanup-no-such-dir", 2 * DAY);
	mk("tmp-exists", tmpLive, 2 * DAY);
	mk("not-temp", "/Users/nobody-dotz-test/deleted", 2 * DAY);
	mk("tmp-root", "/private/tmp", 2 * DAY);
	const r = pruneTempSessions(sessions, DAY, NOW);
	expect(r.removed).toEqual(["tmp-gone-idle", "var-idle"]);
	expect(readdirSync(sessions).sort()).toEqual(["not-temp", "tmp-exists", "tmp-root", "var-recent"]);
	rmSync(tmpLive, { recursive: true, force: true });
});

test("a probe's own sessions go by cwd, in either /var or /private/var spelling", () => {
	const sessions = tmp();
	for (const [name, cwd] of [["a", "/private/var/folders/x/T/dotz-verify-omo-AAA"], ["b", "/var/folders/x/T/dotz-verify-omo-BBB"], ["c", "/private/var/folders/x/T/dotz-verify-omo-AAAB"]]) {
		mkdirSync(join(sessions, name!));
		writeFileSync(join(sessions, name!, "s.jsonl"), `${JSON.stringify({ type: "session", cwd })}\n`);
	}
	expect(removeSessionsFor("/var/folders/x/T/dotz-verify-omo-AAA", [sessions, join(sessions, "missing")])).toEqual(["a"]);
	expect(readdirSync(sessions).sort()).toEqual(["b", "c"]);
});

test("open tasks of an ended lane move to the history file with a reason; others and other keys stay", () => {
	const dir = tmp();
	const state = join(dir, "state.json");
	const history = join(dir, "tasks-closed.jsonl");
	const tasks = [
		{ id: "a", what: "lane gone", lane: "old" },
		{ id: "b", what: "lane alive", lane: "live" },
		{ id: "c", what: "no lane" },
	];
	writeFileSync(state, JSON.stringify({ open_tasks: tasks, note: "kept" }, null, 2));
	const dead = (lane: string) => (lane === "old" ? "lane old ended" : undefined);
	const closed = closeDeadLaneTasks(state, history, dead, NOW);
	expect(closed.map(t => t.id)).toEqual(["a"]);
	const after = JSON.parse(readFileSync(state, "utf8"));
	expect(after).toEqual({ open_tasks: [tasks[1], tasks[2]], note: "kept" });
	const rec = JSON.parse(readFileSync(history, "utf8").trim());
	expect(rec).toEqual({ ...tasks[0], closed_at: "2026-10-20T09:00:00.000Z", closed_reason: "lane old ended" });
	// Nothing to close: the state file is not rewritten.
	const before = readFileSync(state, "utf8");
	expect(closeDeadLaneTasks(state, history, dead, NOW)).toEqual([]);
	expect(readFileSync(state, "utf8")).toBe(before);
	expect(closeDeadLaneTasks(join(dir, "none.json"), history, dead, NOW)).toEqual([]);
	expect(existsSync(join(dir, "none.json"))).toBe(false);
});

test("closeDeadLaneTasks keeps a task of an ended lane that waits for the owner; only plain tasks close", () => {
	const dir = mkdtempSync(join(tmpdir(), "owner-wait-"));
	const state = join(dir, "state.json");
	const history = join(dir, "tasks-closed.jsonl");
	const tasks = [
		{ id: "pick", lane: "gone", next: "외부 조사 아이디어 5개 중 무엇을 할지 형 답을 레인 채널에서 기다림" },
		{ id: "approve", lane: "gone", next: "merge waits for the owner's approval" },
		{ id: "needs", lane: "gone", what: "needs-you: which theme" },
		{ id: "plain", lane: "gone", next: "레인 보고 오면 머지 SHA 확인 후 재시작" },
	];
	writeFileSync(state, JSON.stringify({ open_tasks: tasks }));
	const closed = closeDeadLaneTasks(state, history, () => "lane gone ended");
	expect(closed.map(t => t.id)).toEqual(["plain"]);
	expect(JSON.parse(readFileSync(state, "utf8")).open_tasks.map((t: { id: string }) => t.id)).toEqual(["pick", "approve", "needs"]);
	expect(waitsForOwner({ next: "형이 C(범용) 선택함, 머지 SHA 확인" })).toBe(false);
});
