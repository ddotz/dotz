import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nPrelude } from "./web-i18n.ts";
import { clockKo, deriveLabel, describeOutput, humanLabel, isKeyLabel, isMachineOutput, nameKo, plainLabel, rawFence, scheduleLabel, scheduleLine, sentinelMatch, watchLine, watchSummary } from "./watchtext.ts";

const KAKAO = "kakao chat=100000000000001 new=1 from=3900000000000000001 to=3900000000000000001 at=2026-10-22T12:26:36.000Z";
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
	expect(title).toBe("kakao new: 조건에 맞는 결과가 나왔어요");
	expect(summary).toBe("새 소식 1건 · 오후 9:26");
	expect(fence.join("\n")).toBe(`${rawFence(KAKAO)}`);
	expect(text.replace(/```원문[\s\S]*?```/, "")).not.toMatch(/=|\d{9,}|T\d\d:\d\d/);
});

test("without a summary the raw text still folds; plain Korean output stays prose; the bell gets no raw", () => {
	expect(watchLine("재고", "output changed", "boutique_mails=1")).toBe("재고: 결과가 바뀌었어요\n```원문\nboutique_mails=1\n```");
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

// Schedule texts are the whole instruction a schedule runs (Big Bath audit 2026-11-10): the owner reads the first sentence without what it runs.
const SCHEDULES: [string, string][] = [
	["Big Bath 점검 시간이에요. ~/.dotz/projects/big-bath/README.md대로 돌려요. `bun ~/.dotz/projects/big-bath/collect.ts`로 요청을 모아요.", "Big Bath 점검 시간이에요"],
	["ch:7 피드백 데일리 보고: `ssh -o BatchMode=yes user@100.64.0.2 python3 - 24 < ~/.dotz/projects/feedback/collect.py`로 지난 24시간 메시지를 정리해요.", "피드백 데일리 보고: 지난 24시간 메시지를 정리해요"],
	["피드백 데일리 보고: ssh -o BatchMode=yes user@100.64.0.2 python3 - 24 < ~/x.py", "피드백 데일리 보고"],
	["00:00 릴리스(v261110.1, ecb372f) 재시작이 전체 시험 때문에 미뤄졌던 것 다시 확인: 7420 게이트웨이 pid 시작 시각을 봐요.", "00:00 릴리스(v261110.1) 재시작이 전체 시험 때문에…"],
	["PR #71(프로젝트 목록 컴퓨터별 묶기, 5ec3dd7b) 실제 확인: 이 맥 설치본에 5ec3dd7b가 들어갔는지 보고(00시 릴리스), 들어갔으면 화면을 봐요.", "PR #71(프로젝트 목록 컴퓨터별 묶기) 실제 확인"],
	["flaky-tests 3차: 맥이 한가한지(uptime load < 10) 보고 origin/main에서 ~/.dotz/projects/flaky-tests/run3.sh로 전체 테스트 3회. 2차(a3efff11) 때 실패한 파일을 봐요.", "flaky-tests 3차"],
];
// A match whose output lists items ("새 PR: ...") is counted like a change; one plain line keeps the match phrase. The last column is the items as shown:
// a kind the count already names is not said again on each item (undefined: the output as it is).
const MATCHES: [string, string, string, string, string?][] = [
	["깃허브 PR·이슈 확인", "matched /./", "새 PR: example/dotz#72 sample-user 접속 모드 표시", "깃허브 PR·이슈 확인: 새 PR 1건", "example/dotz#72 sample-user 접속 모드 표시"],
	["깃허브 이슈", "matched /./", "새 이슈: example/dotz#80 로그인 오류\n새 이슈: example/dotz#81 알림이 두 번 와요", "깃허브 이슈: 새 이슈 2건", "example/dotz#80 로그인 오류\nexample/dotz#81 알림이 두 번 와요"],
	["깃허브 PR·이슈 확인", "matched /./", "새 PR: example/dotz#72 접속 모드 표시\n새 이슈: example/dotz#80 로그인 오류", "깃허브 PR·이슈 확인: 새 PR 1건 · 새 이슈 1건"],
	["재시도 감시", "matched /./", "워커 도구 도중 끊김: 토큰 59.8M → 75.6M\n같은 호출 반복: 토큰 12.1M → 16.5M\n빈 깨움 cm:sample:notification: 토큰 12.2M → 16.3M", "재시도 감시: 조건에 맞는 항목 3건"],
	["재고", "matched /./", "재고가 들어왔어요", "재고: 조건에 맞는 결과가 나왔어요"],
];

test("a schedule is named by its first sentence, without the commands, paths and ids it runs", () => {
	for (const [text, name] of SCHEDULES) {
		expect(scheduleLabel(text)).toBe(name);
		expect(scheduleLine(text, { raw: false })).toBe(name);
	}
});

test("a match that lists items says how many in its first line, as a change does", () => {
	for (const [label, reason, out, head, shown] of MATCHES) expect(watchLine(label, reason, out, { raw: false })).toBe(`${head}\n${shown ?? out}`);
});

test("a JSON report reads in Korean key words, a long log says its lines and last time, a recovery drops its status word", () => {
	const opts = { now: NOW, tz: TZ };
	expect(watchLine("상태", "output changed", JSON.stringify({ status: "ok", count: 3, latest: { title: "샘플 항목" }, build: true }), opts)).toBe(
		'상태: 결과가 바뀌었어요\n상태: 정상\n개수: 3\n최근 제목: 샘플 항목\nbuild: 예\n```원문\n{"status":"ok","count":3,"latest":{"title":"샘플 항목"},"build":true}\n```');
	const log = ["2025-01-02T01:10:00Z INFO job=sync step=1", "2025-01-02T01:11:00Z INFO job=sync step=2", "2025-01-02T01:12:00Z INFO job=sync step=3"].join("\n");
	expect(watchSummary(log, NOW, TZ)).toBe("기록 3줄 · 마지막 1월 2일 오전 10:12");
	expect(watchSummary("new=3 checked_at=2025-01-02T01:02:03Z", NOW, TZ)).toBe("새 소식 3건 · 1월 2일 오전 10:02");
	expect(watchLine("사이트", "recovered", "ok", opts)).toBe("사이트: 다시 정상이에요\n점검이 다시 통과했어요");
	expect(watchLine("사이트", "recovered", "응답 200, 지연 30ms", opts)).toBe("사이트: 다시 정상이에요\n응답 200, 지연 30ms");
});

test("web/js/11-watchtext.js words the same posts as this module", () => {
	const src = readFileSync(join(import.meta.dir, "../web/js/11-watchtext.js"), "utf8");
	const web = new Function(`${i18nPrelude()}${src}; return { watchLine, scheduleLine, humanLabel };`)() as Record<string, (...a: any[]) => string>;
	const opts = { now: NOW, tz: TZ };
	const cases: [string, string, string, string?][] = [["kakao-new", "matched /./", KAKAO], ["재고", "output changed", "새 메일이 1통 왔어요"], ["저장소 감시", "matched /gone/", "sample-repo-gone"], ["저장소 감시", "matched /gone/", "READY\n재고가 들어왔어요"], ["저장소 감시", "output changed", "sample-repo-gone", "sample-repo-here"], ["api-health", "failed 3 times in a row (exit 7)", "curl: (7) boom"], ["x", "recovered", ""], ["x", "recovered", "ok"], ["상태", "output changed", '{"status":"ok","latest":{"at":"2025-01-02T01:00:00Z"}}'], ["로그", "output changed", "2025-01-02T01:10:00Z a=1 b=2\n2025-01-02T01:11:00Z a=1 b=3\n2025-01-02T01:12:00Z a=1 b=4"], ["재고", "output changed", "Item A\nItem C", "Item A\nItem B"], ["재고", "fail", "DOTZ_FAIL login\nx"], ["상태", "output changed", '{"version":"8.2.36","id":"q"}'], ["상태", "output changed", "+ Build 9.1.0\n- Build 9.0.9"], ["sample-items", "match", ITEMS_NOW, ITEMS_PREV]];
	for (const [l, r, o, prev] of [...cases, ...MATCHES.map(([l, r, o]) => [l, r, o] as [string, string, string])]) expect(web.watchLine!(l, r, o, { ...opts, prev })).toBe(watchLine(l, r, o, { ...opts, prev }));
	for (const t of ["ch:7 morning brief: summarize", "주간 보고 정리", ...SCHEDULES.map(([t]) => t)]) expect(web.scheduleLine!(t)).toBe(scheduleLine(t));
	expect(web.humanLabel!("kakao-new")).toBe(humanLabel("kakao-new"));
});

test("an unlabeled watch gets a readable Korean name, never its key", () => {
	expect(deriveLabel({ name: "ch-1234-2", project: "샘플 프로젝트", index: 2 })).toBe("샘플 프로젝트 감시 2");
	expect(deriveLabel({ name: "ch-ch-2" })).toBe("프로젝트 감시 2");
	expect(deriveLabel({ name: "sample-login" })).toBe("sample 로그인");
	expect(deriveLabel({ name: "x1", site: "example.com" })).toBe("example.com 로그인 유지");
	expect(deriveLabel({ name: "stock-check", header: "# 재고가 생기는지 확인합니다.", project: "샘플" })).toBe("샘플 재고가 생기는지 확인합니다");
	expect(["kakao-new", "sns-yt-comments", "sns-ig-dm", "sns-yt-tokens", "sns-tokens", "sns-due", "sns-inbox", "webmail-naver", "webmail-naver-login", "comments"].map(nameKo)).toEqual(
		["카카오톡 새 소식", "유튜브 댓글", "인스타그램 DM", "유튜브 연결 유지", "SNS 연결 유지", "SNS 예약 글 올리기", "SNS 새 영상", "네이버 메일", "네이버 메일 로그인", "댓글"]);
	expect(plainLabel("kakao 새 소식")).toBe("카카오톡 새 소식");
	expect(plainLabel("kakaopay 새 소식")).toBe("kakaopay 새 소식");
	expect(plainLabel("GitHub 감시")).toBe("GitHub 감시");
	expect(isKeyLabel("acme login")).toBe(true);
	expect(isKeyLabel("샘플 로그인")).toBe(false);
	expect(isKeyLabel("Boutique")).toBe(false);
});

test("a changed output becomes a sentence of what was added or gone, with the raw folded", () => {
	const prev = "Item A\nItem B";
	const now = "Item A\nItem C\nItem D";
	expect(describeOutput(now, { prev })).toEqual({ text: "새로 생겼어요\n- Item C\n- Item D\n사라졌어요\n- Item B", title: "새 항목 2건 · 사라진 항목 1건", readable: true });
	expect(watchLine("샘플 감시", "output changed", now, { prev })).toBe("샘플 감시: 새 항목 2건 · 사라진 항목 1건\n새로 생겼어요\n- Item C\n- Item D\n사라졌어요\n- Item B\n" + rawFence(now));
	expect(describeOutput("+ Build 9.1.0\n- Build 9.0.9").text).toBe("새로 생겼어요\n- Build 9.1.0\n사라졌어요\n- Build 9.0.9");
	expect(describeOutput("\x1b[32mItem A\x1b[0m\nItem E 3900000000000000002", { prev: "Item A" }).text).toBe("- Item E");
});

// A check that prints one "<kind>: <owner/repo>#<n> <author> <title>" line per item (neutral fixture text).
const ITEMS_PREV = ["새 이슈: sample/repo#67 user-c 셋째 제목", "새 이슈: sample/repo#68 user-d 넷째 제목", "새 이슈: sample/repo#69 user-e 다섯째 제목"].join("\n");
const ITEMS_NOW = ["이슈 갱신: sample/repo#65 user-a 첫째 제목", "이슈 갱신: sample/repo#66 user-b 둘째 제목", "이슈 갱신: sample/repo#67 user-c 셋째 제목", "이슈 갱신: sample/repo#69 user-e 다섯째 제목"].join("\n");

test("changed items read one per row, an item that only changed kind is not gone, and the title counts them", () => {
	const d = describeOutput(ITEMS_NOW, { prev: ITEMS_PREV });
	expect(d.title).toBe("이슈 갱신 4건 · 사라진 항목 1건");
	expect(d.text.split("\n")).toEqual([
		"- 이슈 갱신: sample/repo#65 user-a 첫째 제목",
		"- 이슈 갱신: sample/repo#66 user-b 둘째 제목",
		"- 새 이슈 → 이슈 갱신: sample/repo#67 user-c 셋째 제목",
		"- 외 1건",
		"사라졌어요",
		"- 새 이슈: sample/repo#68 user-d 넷째 제목",
	]);
	expect(watchLine("sample-items", "match", ITEMS_NOW, { prev: ITEMS_PREV }).split("\n")[0]).toBe("sample items: 이슈 갱신 4건 · 사라진 항목 1건");
	// the same text after the leading label is the same item when there is no reference
	expect(describeOutput("상태 바뀜: 샘플 항목", { prev: "새 항목: 샘플 항목" })).toEqual({ text: "- 새 항목 → 상태 바뀜: 샘플 항목", title: "상태 바뀜 1건", readable: true });
	expect(describeOutput("Item A\nItem C", { prev: "Item A\nItem B" }).title).toBe("새 항목 1건 · 사라진 항목 1건");
	expect(describeOutput("Item A", { prev: "Item A x=1" }).title).toBeUndefined();
	expect(describeOutput("서버 B: 정상", { prev: "서버 A: 정상" }).text).toBe("- 서버 B: 정상\n사라졌어요\n- 서버 A: 정상");
	expect(watchLine("sample-items", "recovered", "+ Item B").split("\n")[0]).toBe("sample items: 다시 정상이에요");
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
	expect(d.text.split("\n")).toEqual(["버전: 8.2.36", "상태: ready", "상태 시각: " + clockKo("2026-10-22T13:18:18Z"), "tags: a, b"]);
});

test("output the rules cannot read stays raw until a cached model sentence is given", () => {
	const blob = "aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgcmVhZGFibGU=#%^&*";
	expect(describeOutput(blob).readable).toBe(false);
	expect(watchLine("샘플 감시", "output changed", blob)).toBe("샘플 감시: 결과가 바뀌었어요\n" + rawFence(blob));
	expect(watchLine("샘플 감시", "output changed", blob, { summary: "새 항목이 하나 늘었어요" })).toBe("샘플 감시: 결과가 바뀌었어요\n새 항목이 하나 늘었어요\n" + rawFence(blob));
});

test("a sentinel a check prints never reaches the prose, and a match on it alone is just the sentence", () => {
	expect(watchLine("저장소 감시", "matched /gone/", "sample-repo-gone")).toBe("저장소 감시: 조건에 맞는 결과가 나왔어요");
	expect(watchLine("저장소 감시", "match", "READY")).toBe("저장소 감시: 조건에 맞는 결과가 나왔어요");
	expect(watchLine("저장소 감시", "matched /gone/", "저장소가 사라졌어요")).toBe("저장소 감시: 조건에 맞는 결과가 나왔어요\n저장소가 사라졌어요");
	expect(watchLine("저장소 감시", "matched /x/", "READY\n재고가 들어왔어요").split("\n").slice(0, 2)).toEqual(["저장소 감시: 조건에 맞는 결과가 나왔어요", "재고가 들어왔어요"]);
	expect(watchLine("상태 감시", "output changed", "build-failed", { prev: "build-passing", summary: "빌드가 깨졌어요" })).toBe(`상태 감시: 결과가 바뀌었어요\n빌드가 깨졌어요\n${rawFence("build-failed")}`);
	expect(describeOutput("build-failed", { prev: "build-passing" }).readable).toBe(false);
	expect(sentinelMatch("output changed", "build-failed")).toBe(false);
	for (const value of ["2026-11-06", "BTC", "OK"]) expect(sentinelMatch("match", value)).toBe(false);
	expect(sentinelMatch("matched /gone/", "sample-repo-gone")).toBe(true);
	expect(watchLine("점검", "failed 3 times in a row (exit 1)", "repo-gone")).toBe(`점검: 3번 연속 실패했어요\n${rawFence("repo-gone")}`);
});

// A schedule's name skips the channel tag its text starts with, and a name cut for length never ends inside a bracket or quote (the owner saw
// "#sample-점검(ch:…)" and "확인(형 \"지금…" as names).
test("a schedule's name skips a leading channel tag and is never cut inside a bracket or quote", () => {
	const names = [
		"#sample-점검(ch:1234567890123456789): 오늘 12:00 릴리스가 나왔는지 보고, 나왔으면 알려 줘요.",
		'12:00 릴리스 뒤 Claude 리셋권 표시 확인(형 "지금 리셋권이 몇 장 남았어?"라고 물어본 화면)을 해 줘요.',
		"답장 파일 재대조(샘플 맥 downloads 폴더의 답장 파일과 보낸 목록)을 다시 맞춰 봐요.",
	].map(scheduleLabel);
	expect(names[0]).toBe("오늘 12:00 릴리스가 나왔는지 보고, 나왔으면 알려 줘요");
	for (const n of names.slice(1)) expect({ n, open: n.replace(/[^("“(\[]/g, "").length > n.replace(/[^)”)\]]/g, "").length || (n.match(/"/g) ?? []).length % 2 === 1 }).toEqual({ n, open: false });
	expect(names[1]!.startsWith("12:00 릴리스 뒤 Claude 리셋권 표시 확인")).toBe(true);
	expect(names[2]!.startsWith("답장 파일 재대조")).toBe(true);
});
