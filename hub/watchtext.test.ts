import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clockKo, humanLabel, isMachineOutput, rawFence, scheduleLine, watchLine, watchSummary } from "./watchtext.ts";

const KAKAO = "kakao chat=458693335449148 new=1 from=3957198286878674945 to=3957198286878674945 at=2026-10-22T12:26:36.000Z";
const NOW = Date.parse("2026-10-22T13:00:00.000Z");
const TZ = "Asia/Seoul";

test("an internal watch key reads as words; a label written for people stays", () => {
	expect(humanLabel("kakao-new")).toBe("kakao new");
	expect(humanLabel("node_security-upgrade")).toBe("node security upgrade");
	expect(humanLabel("재고 감시 1")).toBe("재고 감시 1");
	expect(humanLabel("  ")).toBe("모니터링");
});

test("time is in the owner's timezone and short, never ISO UTC", () => {
	expect(clockKo("2026-10-22T12:26:36.000Z", NOW, TZ)).toBe("오후 9:26");
	expect(clockKo("2026-10-21T12:26:36.000Z", NOW, TZ)).toBe("10월 21일 오후 9:26");
	expect(clockKo("2026-10-22T12:26:36.000Z", NOW, "America/New_York")).toBe("오전 8:26");
	expect(clockKo("nope", NOW, TZ)).toBe("");
});

test("a machine line is told from plain text, and only generic fields are summarized", () => {
	expect(isMachineOutput(KAKAO)).toBe(true);
	expect(isMachineOutput('{"a":1}')).toBe(true);
	expect(isMachineOutput("saved at 2026-10-22T12:26:36Z")).toBe(true);
	expect(isMachineOutput("새 메일이 1통 왔어요")).toBe(false);
	expect(watchSummary(KAKAO, NOW, TZ)).toBe("새 소식 1건 · 오후 9:26");
	expect(watchSummary("new=0 x=1", NOW, TZ)).toBe("");
	expect(watchSummary("chat=1 to=2", NOW, TZ)).toBe("");
});

test("the kakao-style post is the label, a human line and a folded raw text; the machine line is not in the prose", () => {
	const text = watchLine("kakao-new", "matched /./", KAKAO, { now: NOW, tz: TZ });
	const [title, summary, ...fence] = text.split("\n");
	expect(title).toBe("kakao new: 찾던 내용이 나왔어요");
	expect(summary).toBe("새 소식 1건 · 오후 9:26");
	expect(fence.join("\n")).toBe(`${rawFence(KAKAO)}`);
	expect(text.replace(/```원문[\s\S]*?```/, "")).not.toMatch(/=|\d{9,}|T\d\d:\d\d/);
});

test("without a summary the raw text still folds; plain Korean output stays prose; the bell gets no raw", () => {
	expect(watchLine("재고", "output changed", "cartier_mails=1")).toBe("재고: 결과가 바뀌었어요\n```원문\ncartier_mails=1\n```");
	expect(watchLine("재고", "output changed", "새 메일이 1통 왔어요")).toBe("재고: 결과가 바뀌었어요\n새 메일이 1통 왔어요");
	expect(watchLine("재고", "output changed", KAKAO, { raw: false, now: NOW, tz: TZ })).toBe("재고: 결과가 바뀌었어요\n새 소식 1건 · 오후 9:26");
	expect(watchLine("재고", "recovered")).toBe("재고: 다시 정상이에요");
});

test("a failure keeps its tool output in the fold, never in the prose", () => {
	const err = "curl: (7) Failed to connect to 127.0.0.1 port 8080";
	expect(watchLine("api-health", "failed 3 times in a row (exit 7)", err)).toBe(`api health: 3번 연속 실패했어요\n\`\`\`원문\n${err}\n\`\`\``);
});

test("the raw text is cut to a few lines and cannot close its own fence", () => {
	const long = Array.from({ length: 9 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n");
	const fenced = rawFence(long);
	expect(fenced.length).toBeLessThan(700);
	expect(fenced).toMatch(/…\n```$/);
	expect(rawFence(Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n"))).toBe("```원문\nl0\nl1\nl2\nl3\nl4\n…\n```");
	expect(rawFence("a ``` b")).toBe("```원문\na ''' b\n```");
});

test("a schedule fire says a job started; the instruction folds, and the bell gets one line", () => {
	const en = "ch:7 morning brief: summarize today's calendar (zele cal events --today)";
	expect(scheduleLine(en)).toBe("예약한 일이 시작됐어요\n```원문\nmorning brief: summarize today's calendar (zele cal events --today)\n```");
	expect(scheduleLine(en, { raw: false })).toBe("예약한 일이 시작됐어요");
	expect(scheduleLine("주간 보고 정리", { raw: false })).toBe("주간 보고 정리");
	expect(scheduleLine("주간 보고 정리")).toBe("예약한 일이 시작됐어요\n주간 보고 정리");
});

test("web/js/11-watchtext.js words the same posts as this module", () => {
	const src = readFileSync(join(import.meta.dir, "../web/js/11-watchtext.js"), "utf8");
	const web = new Function(`${src}; return { watchLine, scheduleLine, humanLabel };`)() as Record<string, (...a: any[]) => string>;
	const opts = { now: NOW, tz: TZ };
	const cases: [string, string, string][] = [["kakao-new", "matched /./", KAKAO], ["재고", "output changed", "새 메일이 1통 왔어요"], ["api-health", "failed 3 times in a row (exit 7)", "curl: (7) boom"], ["x", "recovered", ""]];
	for (const [l, r, o] of cases) expect(web.watchLine!(l, r, o, opts)).toBe(watchLine(l, r, o, opts));
	for (const t of ["ch:7 morning brief: summarize", "주간 보고 정리"]) expect(web.scheduleLine!(t)).toBe(scheduleLine(t));
	expect(web.humanLabel!("kakao-new")).toBe(humanLabel("kakao-new"));
});
