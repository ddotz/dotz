import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNoticeKoWeb } from "./gen-notice-ko-web.ts";
import { cronKo, errorKo, noticeKo, plainTable } from "./notice-ko.ts";
import { stripMarkers } from "./tone.ts";
import { clockKo } from "./watchtext.ts";

// What reaches a toast, the bell, an 알림 row or a push is everyday Korean: raw names, commands, ids and paths are gone, the data stays.
const RAW = /dotz_|\/Users|\*\/5|\bssh\b|\[(?:done|ask|run|fail)\]|\blane:|\bch:\d|`|[0-9a-f]{8}-[0-9a-f]{4}|launchctl/;
const lanes = (name: string) => (name === "mail-reply-drafts" ? "메일 답장 초안" : undefined);

test("raw identifiers become words and the data stays", () => {
	const text = "[done] `dotz_watch`로 메일 3통을 확인했어요. 초안은 /Users/hyuns/.dotz/drafts/weekly_report.md 에 있어요 (id=3f2a9b1c-1111-2222-3333-444455556666)";
	const out = noticeKo(text, { lane: lanes });
	expect(out).not.toMatch(RAW);
	expect(out).toContain("메일 3통");
	expect(out).toContain("weekly_report.md");
	expect(out).toContain("모니터링으로");
});

test("commands, schedules, remote logins and session ids read as plain phrases", () => {
	const out = noticeKo("ssh macmini 'launchctl kickstart gateway' 뒤에 `*/5 * * * *` 예약을 `bun test` 로 확인했고 lane:mail-reply-drafts 가 ch:123456 에서 끝났어요", { lane: lanes });
	expect(out).not.toMatch(RAW);
	expect(out).toContain("macmini");
	expect(out).toContain("5분마다");
	expect(out).toContain("메일 답장 초안");
	expect(noticeKo("`0 9 * * 1`")).toBe(cronKo("0 9 * * 1"));
});

test("text that is already plain passes through, twice over too", () => {
	for (const t of ["가격이 9,900원에서 8,900원으로 내려갔어요", "일정 4개 · 답장할 메일 2통", "오전/오후 10/23 and/or 2개"]) {
		expect(noticeKo(t)).toBe(t);
		expect(noticeKo(noticeKo(t))).toBe(noticeKo(t));
	}
	const mixed = noticeKo("[가격 페이지] `dotz_watch` 확인했어요");
	expect(noticeKo(mixed)).toBe(mixed);
});

test("[file] lines are dropped, or kept for a body that draws them", () => {
	const t = "끝났어요\n[file] /tmp/out/report.pdf";
	expect(noticeKo(t)).not.toContain("[file]");
	expect(noticeKo(t, { keepFiles: true })).toContain("[file] /tmp/out/report.pdf");
});

test("an error message is worded; its name stays", () => {
	expect(errorKo("HTTP 500")).not.toMatch(/HTTP|500/);
	expect(noticeKo("Failed to fetch", { error: true })).not.toMatch(/fetch/i);
	expect(noticeKo("a.png: HTTP 413", { error: true })).toStartWith("a.png: ");
	expect(noticeKo("저장하지 못했어요: ENOENT: x", { error: true })).toBe("저장하지 못했어요");
});

test("the page's copy is this code, and runs to the same answers", () => {
	const shipped = readFileSync(join(import.meta.dir, "..", "web/js/01-notice-ko.js"), "utf8");
	return buildNoticeKoWeb().then(built => {
		expect(shipped).toBe(built);
		const web = new Function("stripMarkers", "clockKo", `${shipped}; return noticeKo;`)(stripMarkers, clockKo) as typeof noticeKo;
		for (const t of ["[ask] `dotz_schedule` 를 /restart 로 다시 켰어요 ssh me@box 'ls'", "https://www.example.com/a?b=1 과 web/js/30-notices.js 와 lane:x", "[가격 페이지] 확인했어요", "```bash\nrm -rf x\n```\n끝"]) {
			expect(web(t, { lane: lanes })).toBe(noticeKo(t, { lane: lanes }));
			expect(web(t, { error: true })).toBe(noticeKo(t, { error: true }));
		}
	});
});

test("an id that was all of a code span leaves no marks behind", () => {
	expect(noticeKo("근거: `a1b2c3d` · 테스트 24개 통과")).toBe("근거: 테스트 24개 통과");
	expect(noticeKo("커밋 `e1b86a59`, 테스트 · `a1b2c3d` · 끝")).not.toContain("``");
});

test("a table reads as words in a one-line preview", () => {
	expect(plainTable("앞\n| | 기본 | 넉넉 |\n|---|:--|---|\n| 요금 | 1 | 2 |")).toBe("앞\n기본 · 넉넉\n요금 · 1 · 2");
	expect(plainTable("a | b 는 그대로예요")).toBe("a | b 는 그대로예요");
});
