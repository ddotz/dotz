import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLimitWait, deferForLimit, limitBadge, limitWaits, limitWaitStarted, markLimitWait } from "./limitwait.ts";

const AT = "2026-11-02T05:30:00.000Z"; // 14:30 KST
const NOW = Date.parse("2026-11-02T02:00:00.000Z");
const stateFile = (state?: unknown) => {
	const file = join(mkdtempSync(join(tmpdir(), "limitwait-")), "state.json");
	if (state !== undefined) writeFileSync(file, JSON.stringify(state));
	return file;
};
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const recorder = () => {
	const posts: [string, string, string][] = [];
	return { posts, post: async (t: string, k: string, x: string) => void posts.push([t, k, x]) };
};

test("badge text: 한도 리셋되면 재개 (HH:MM) in the given zone, 24h; no time when resume_at is unreadable", () => {
	expect(limitBadge(AT, "Asia/Seoul")).toBe("한도 리셋되면 재개 (14:30)");
	expect(limitBadge("2026-11-02T15:05:00.000Z", "Asia/Seoul")).toBe("한도 리셋되면 재개 (00:05)");
	expect(limitBadge(undefined)).toBe("한도 리셋되면 재개");
});

test("a budget-gate refusal records waiting_for and resume_at on the lane's item and posts the badge on its worklog line", () => {
	const file = stateFile({ note: "kept", open_tasks: [{ id: "other", what: "x" }, { id: "t1", what: "UI 정리", lane: "ui-fix", since: "s" }] });
	const { posts, post } = recorder();
	deferForLimit(file, "ui-fix", "UI 정리", AT, post, () => {});
	const s = read(file);
	expect(s.note).toBe("kept");
	expect(s.open_tasks).toEqual([{ id: "other", what: "x" }, { id: "t1", what: "UI 정리", lane: "ui-fix", since: "s", waiting_for: "limit-reset", resume_at: AT }]);
	expect(posts).toHaveLength(1);
	expect(posts[0]!.slice(0, 2)).toEqual(["worklog", "lane:ui-fix"]);
	expect(posts[0]![2]).toMatch(/^\[run\] UI 정리: 한도 리셋되면 재개 \(\d{2}:\d{2}\)$/);
});

test("with no matching item the refusal creates a minimal one; a missing state file is created", () => {
	const file = stateFile();
	markLimitWait(file, "big-job", "큰 작업", AT, NOW);
	expect(read(file).open_tasks).toEqual([{ id: "big-job", what: "큰 작업", lane: "big-job", since: new Date(NOW).toISOString(), waiting_for: "limit-reset", resume_at: AT }]);
	expect(limitWaits(file)).toEqual([{ id: "big-job", what: "큰 작업", lane: "big-job", resume_at: AT }]);
});

test("the legacy '[한도 리셋 뒤 재개 HH:MM] ' prefix is stripped, so the time never shows twice", () => {
	const file = stateFile({ open_tasks: [{ id: "big-job", what: "[한도 리셋 뒤 재개 14:30] 큰 작업" }, { id: "old", what: "[한도 리셋 뒤 재개 9:05] 남은 일", waiting_for: "limit-reset", resume_at: AT }] });
	markLimitWait(file, "big-job", "ignored", AT);
	markLimitWait(file, "big-job", "ignored", AT);
	expect(read(file).open_tasks[0].what).toBe("큰 작업");
	expect(limitWaits(file).map(t => t.what)).toEqual(["큰 작업", "남은 일"]);
	clearLimitWait(file, "old");
	expect(read(file).open_tasks[1]).toEqual({ id: "old", what: "남은 일" });
});

test("a lane start clears the fields and edits the worklog line; nothing is rewritten or posted when it had no wait", () => {
	const file = stateFile({ open_tasks: [{ id: "t1", what: "UI 정리", lane: "ui-fix", waiting_for: "limit-reset", resume_at: AT }] });
	const { posts, post } = recorder();
	expect(limitWaitStarted(file, "ui-fix", "UI 정리", post, () => {})).toBe(true);
	expect(read(file).open_tasks).toEqual([{ id: "t1", what: "UI 정리", lane: "ui-fix" }]);
	expect(limitWaits(file)).toEqual([]);
	expect(posts).toEqual([["worklog", "lane:ui-fix", "[run] UI 정리: 시작했어요"]]);
	const before = readFileSync(file, "utf8");
	expect(limitWaitStarted(file, "ui-fix", "UI 정리", post, () => {})).toBe(false);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(posts).toHaveLength(1);
});

test("an unreadable state.json is left alone and logged, the worklog line still goes out", () => {
	const file = stateFile();
	writeFileSync(file, "{not json");
	const { posts, post } = recorder();
	const logs: string[] = [];
	deferForLimit(file, "x", "엑스", AT, post, l => logs.push(l));
	expect(readFileSync(file, "utf8")).toBe("{not json");
	expect(logs[0]).toContain("not recorded");
	expect(posts).toHaveLength(1);
	expect(limitWaits(file)).toEqual([]);
});
