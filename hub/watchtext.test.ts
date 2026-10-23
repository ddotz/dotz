import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clockKo, deriveLabel, describeOutput, humanLabel, isKeyLabel, isMachineOutput, rawFence, scheduleLine, watchLine, watchSummary } from "./watchtext.ts";

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
	const cases: [string, string, string, string?][] = [["kakao-new", "matched /./", KAKAO], ["재고", "output changed", "새 메일이 1통 왔어요"], ["api-health", "failed 3 times in a row (exit 7)", "curl: (7) boom"], ["x", "recovered", ""], ["재고", "output changed", "Item A\nItem C", "Item A\nItem B"], ["재고", "fail", "DOTZ_FAIL login\nx"], ["상태", "output changed", '{"version":"8.2.36","id":"q"}'], ["상태", "output changed", "+ Build 9.1.0\n- Build 9.0.9"]];
	for (const [l, r, o, prev] of cases) expect(web.watchLine!(l, r, o, { ...opts, prev })).toBe(watchLine(l, r, o, { ...opts, prev }));
	for (const t of ["ch:7 morning brief: summarize", "주간 보고 정리"]) expect(web.scheduleLine!(t)).toBe(scheduleLine(t));
	expect(web.humanLabel!("kakao-new")).toBe(humanLabel("kakao-new"));
});

test("an unlabeled watch gets a readable Korean name, never its key", () => {
	expect(deriveLabel({ name: "ch-1234-2", project: "샘플 프로젝트", index: 2 })).toBe("샘플 프로젝트 감시 2");
	expect(deriveLabel({ name: "ch-ch-2" })).toBe("프로젝트 감시 2");
	expect(deriveLabel({ name: "sample-login" })).toBe("sample 로그인");
	expect(deriveLabel({ name: "x1", site: "example.com" })).toBe("example.com 로그인 유지");
	expect(deriveLabel({ name: "stock-check", header: "# 재고가 생기는지 확인합니다.", project: "샘플" })).toBe("샘플 재고가 생기는지 확인합니다");
	expect(isKeyLabel("kdb login")).toBe(true);
	expect(isKeyLabel("샘플 로그인")).toBe(false);
	expect(isKeyLabel("Cartier")).toBe(false);
});

test("a changed output becomes a sentence of what was added or gone, with the raw folded", () => {
	const prev = "Item A\nItem B";
	const now = "Item A\nItem C\nItem D";
	expect(describeOutput(now, { prev })).toEqual({ text: "새로 생겼어요: Item C · Item D\n사라졌어요: Item B", readable: true });
	expect(watchLine("샘플 감시", "output changed", now, { prev })).toBe("샘플 감시: 결과가 바뀌었어요\n새로 생겼어요: Item C · Item D\n사라졌어요: Item B\n" + rawFence(now));
	expect(describeOutput("+ Build 9.1.0\n- Build 9.0.9").text).toBe("새로 생겼어요: Build 9.1.0\n사라졌어요: Build 9.0.9");
	expect(describeOutput("\x1b[32mItem A\x1b[0m\nItem E 3957223900184580097", { prev: "Item A" }).text).toBe("새로 생겼어요: Item E");
});

test("a DOTZ_FAIL kind reads as a Korean phrase", () => {
	expect(describeOutput("DOTZ_FAIL login\nsession expired", { issue: true }).text).toBe("로그인이 풀렸어요");
	expect(describeOutput("DOTZ_FAIL fetch\n페이지가 열리지 않아요", { issue: true }).text).toBe("내용을 가져오지 못했어요\n페이지가 열리지 않아요");
	expect(describeOutput("DOTZ_FAIL something-new", { issue: true }).text).toBe("점검에 실패했어요");
	expect(watchLine("샘플 감시", "failed 3 times in a row (exit 1)", "DOTZ_FAIL login")).toBe("샘플 감시: 3번 연속 실패했어요\n로그인이 풀렸어요\n" + rawFence("DOTZ_FAIL login"));
});

test("JSON output is drawn as key: value lines without ids", () => {
	const d = describeOutput('{"id":"abc","version":"8.2.36","status":{"state":"ready","at":"2026-10-22T13:18:18Z"},"tags":["a","b"]}');
	expect(d.readable).toBe(true);
	expect(d.text.split("\n")).toEqual(["version: 8.2.36", "status.state: ready", "status.at: " + clockKo("2026-10-22T13:18:18Z"), "tags: a, b"]);
});

test("output the rules cannot read stays raw until a cached model sentence is given", () => {
	const blob = "aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgcmVhZGFibGU=#%^&*";
	expect(describeOutput(blob).readable).toBe(false);
	expect(watchLine("샘플 감시", "output changed", blob)).toBe("샘플 감시: 결과가 바뀌었어요\n" + rawFence(blob));
	expect(watchLine("샘플 감시", "output changed", blob, { summary: "새 항목이 하나 늘었어요" })).toBe("샘플 감시: 결과가 바뀌었어요\n새 항목이 하나 늘었어요\n" + rawFence(blob));
});
