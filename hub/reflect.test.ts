import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "./config.ts";
import { digest, lessonCandidates, reflectPrompt, repeatedLessons } from "./reflect.ts";

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

test("the digest cites the Discord message id of an owner correction, the source of an observation line", () => {
	const had = existsSync(paths.inbox) ? readFileSync(paths.inbox, "utf8") : undefined;
	writeFileSync(paths.inbox, `${JSON.stringify({ ts: new Date(now - 3600_000).toISOString(), kind: "message", channel: "chat", message_id: "1561556210908667915", text: "아니 그거 하지 마" })}\n`);
	try {
		expect(digest("", now)).toContain("- 아니 그거 하지 마 (src: discord 1561556210908667915)");
	} finally {
		if (had === undefined) rmSync(paths.inbox);
		else writeFileSync(paths.inbox, had);
	}
});

test("observations older than 90 days are handed to the reflection for deletion", () => {
	const had = readFileSync(paths.observations, "utf8");
	const old = "- [2026-07-01] cond: a | reaction: \"b\" (src) | next: c";
	const fresh = "- [2026-10-18] cond: d | reaction: \"e\" (src) | next: f";
	writeFileSync(paths.observations, `${had}${old}\n${fresh}\n`);
	try {
		const p = reflectPrompt("digest", now);
		expect(p).toContain(old);
		expect(p).not.toContain(fresh);
	} finally {
		writeFileSync(paths.observations, had);
	}
});

test("undated, malformed and impossible-date lines are ignored", () => {
	const text = ["# Lessons", "- no date here, aa bb cc dd", "- [2026-7-1] short month aa bb cc dd", "- [2026-13-45] aa bb cc dd", "- [2026-02-30] aa bb cc dd", "- [2020-01-01]", ""].join("\n");
	const r = lessonCandidates(text, now);
	expect(r.stale).toEqual(["- [2020-01-01]"]);
	expect(r.duplicates).toEqual([]);
});

test("the [MM-DD] lines the nightly turn writes are lessons too: a year-less date is this year's, or last year's when it would be ahead", () => {
	const at = Date.UTC(2026, 9, 28);
	expect(lessonCandidates("- [07-01] keep the gateway log short and plain\n- [07-02] keep the gateway log short and plain", at).duplicates).toHaveLength(1);
	expect(lessonCandidates("- [12-30] a lesson from last december", at).stale).toEqual(["- [12-30] a lesson from last december"]);
	expect(lessonCandidates("- [10-20] a lesson from last week", at).stale).toEqual([]);
});

test("a lesson broken again by a correction today is listed unless its line names an enforcer", () => {
	const lessons = ["- [10-21] Never git checkout a file that holds uncommitted work", "- [10-22] Read the notices before saying something waits (enforced: hub/notices.ts check)", "- [10-23] short one"].join("\n");
	const said = ["왜 또 git checkout 했어? 그 file uncommitted work 날아갔잖아", "notices read before saying waits, again"];
	expect(repeatedLessons(lessons, said)).toEqual(["- [10-21] Never git checkout a file that holds uncommitted work"]);
	expect(repeatedLessons(lessons, ["오늘은 다른 얘기"])).toEqual([]);
});
