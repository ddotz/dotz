import { expect, test } from "bun:test";
import { lessonCandidates } from "./reflect.ts";

const DAY = 24 * 3600_000;
const now = Date.UTC(2026, 9, 19);

test("stale: exactly 90 days old is kept, 91 days is flagged", () => {
	const exact = "- [2026-07-21] exactly ninety days";
	const over = "- [2026-07-20] ninety-one days";
	expect(now - Date.UTC(2026, 6, 21)).toBe(90 * DAY);
	expect(lessonCandidates(`${exact}\n${over}`, now).stale).toEqual([over]);
});

test("duplicates: jaccard 0.6 is flagged, below is not", () => {
	// shared aa bb cc; 3 of 5 = 0.6
	const a = "- [2026-10-01] aa bb cc dd";
	const b = "- [2026-10-02] aa bb cc ee";
	expect(lessonCandidates(`${a}\n${b}`, now).duplicates).toEqual([{ a, b, score: 0.6 }]);
	// 3 of 6 = 0.5
	expect(lessonCandidates(`${a}\n- [2026-10-02] aa bb cc ee ff`, now).duplicates).toEqual([]);
});

test("dates do not count as overlap and tokens are case-insensitive", () => {
	expect(lessonCandidates("- [2026-10-01] one\n- [2026-10-01] two", now).duplicates).toEqual([]);
	expect(lessonCandidates("- [2026-10-01] Restart Gateway\n- [2026-10-02] restart gateway", now).duplicates).toHaveLength(1);
});

test("undated, malformed and impossible-date lines are ignored", () => {
	const text = ["# Lessons", "- no date here, aa bb cc dd", "- [2026-7-1] short month aa bb cc dd", "- [2026-13-45] aa bb cc dd", "- [2026-02-30] aa bb cc dd", "- [2020-01-01]", ""].join("\n");
	const r = lessonCandidates(text, now);
	expect(r.stale).toEqual(["- [2020-01-01]"]);
	expect(r.duplicates).toEqual([]);
});
