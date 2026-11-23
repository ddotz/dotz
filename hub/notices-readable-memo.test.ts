import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { emit } from "./events.ts";
import * as noticeWords from "./notice.ts";
import { allNotices, dismissNotice, listNotices, markNoticesRead, resetNoticesForTest, setLaneTitleResolver } from "./notices.ts";
import { openDecisionNotices } from "./notices-bell.ts";
import { readable } from "./notices-read.ts";
import { diskReader, resolveView, setWebView } from "./web-i18n.ts";

const ts = (() => { let n = Date.now(); return () => new Date(++n).toISOString(); })();
const post = (target: string, text: string, extra: Record<string, unknown> = {}) => emit("outbox", { ts: ts(), kind: "out", source: "orchestrator", target, text, ...extra });
const ask = (i: number) => post("alert", `[ask] 배포 ${i}번을 할까요?\n결정: 배포 ${i}\n**1) 진행해요**\n**2) 보류해요**`);

let titleOfX = "로그인 고치기";
let words: Mock<typeof noticeWords.noticeKo>;
beforeAll(() => {
	setLaneTitleResolver(name => (name === "x" ? titleOfX : undefined));
	words = spyOn(noticeWords, "noticeKo");
});
afterAll(() => words.mockRestore());
beforeEach(() => {
	titleOfX = "로그인 고치기";
	resetNoticesForTest();
	words.mockClear();
});

function fixture(): void {
	for (let i = 0; i < 60; i++) post("worklog", `[run] lane:x 에서 ${i}번째 단계를 했어요`);
	for (let i = 0; i < 40; i++) post("alert", `[fail] 서버 ${i} 가 ${new Date(Date.UTC(2020, 0, 5, 3, i)).toISOString()} 에 멈췄어요`);
	for (let i = 0; i < 40; i++) post("alert", `[done] 보고서 ${i} 를 /tmp/report-${i}.md 로 저장했어요`);
	for (let i = 0; i < 5; i++) ask(i);
	for (let i = 0; i < 5; i++) emit("inbox", { ts: ts(), kind: "watch", source: "watch:뉴스", watch: "뉴스", channels: [], reason: "바뀌었어요", text: `내용 ${i}` });
}

test("the list the owner reads is the same after it was read once: answered from memory, same bytes", () => {
	fixture();
	const first = JSON.stringify(allNotices());
	const listed = JSON.stringify(listNotices(300, true));
	words.mockClear();
	expect(JSON.stringify(allNotices())).toBe(first);
	expect(JSON.stringify(listNotices(300, true))).toBe(listed);
	expect(words).not.toHaveBeenCalled();
	expect(allNotices().find(n => n.text.includes("lane:x"))).toBeUndefined();
	expect(allNotices().some(n => n.title === "로그인 고치기" || n.text.includes("로그인 고치기"))).toBe(true);
});

test("a full list converts each notice once, not once per request", () => {
	fixture();
	const total = allNotices().length;
	expect(total).toBeGreaterThan(100);
	words.mockClear();
	for (let i = 0; i < 5; i++) {
		allNotices();
		listNotices(300, true);
	}
	expect(words).toHaveBeenCalledTimes(0);
});

test("the open decisions behind /api/state are the open ones of the full list, and only those are converted", () => {
	fixture();
	words.mockClear();
	const open = openDecisionNotices();
	expect(open).toHaveLength(5);
	expect(words.mock.calls.length).toBeLessThanOrEqual(open.length * 2);
	expect(JSON.stringify(open)).toBe(JSON.stringify(allNotices().filter(n => n.kind === "decision" && n.decision?.state === "open")));
});

test("a notice that changed is converted again, and only that one", () => {
	post("worklog", "[run] 첫 줄이에요", { update_key: "lane:x" });
	post("worklog", "[run] 다른 줄이에요", { update_key: "lane:y" });
	allNotices();
	words.mockClear();
	post("worklog", "[run] 바뀐 첫 줄이에요", { update_key: "lane:x" });
	const list = allNotices();
	expect(list.find(n => n.key === "lane:x")?.text).toBe("바뀐 첫 줄이에요");
	expect(list.find(n => n.key === "lane:y")?.text).toBe("다른 줄이에요");
	expect(words.mock.calls.filter(([, opts]) => opts?.keepFiles).length).toBeLessThanOrEqual(2);
});

test("reading or dismissing a notice shows at once, with no new conversion", () => {
	post("alert", "[fail] 디스크가 찼어요");
	const [n] = allNotices();
	words.mockClear();
	markNoticesRead({ ids: [n!.id] });
	expect(allNotices().find(x => x.id === n!.id)?.read).toBe(true);
	dismissNotice(n!.id);
	expect(allNotices().find(x => x.id === n!.id)).toBeUndefined();
	expect(words).not.toHaveBeenCalled();
});

test("a session that is renamed renames itself in the notices that name it", () => {
	post("worklog", "[run] lane:x 가 일하고 있어요");
	post("alert", "[fail] 서버가 멈췄어요");
	expect(allNotices().some(n => n.text.includes("로그인 고치기"))).toBe(true);
	titleOfX = "결제 고치기";
	const after = allNotices();
	expect(after.some(n => n.text.includes("결제 고치기"))).toBe(true);
	expect(after.some(n => n.text.includes("로그인 고치기"))).toBe(false);
});

test("a notice is worded again when the page language changes", () => {
	post("alert", "[done] 작업이 끝났어요 watch 감시 cron");
	const ko = JSON.stringify(allNotices());
	expect(ko).toContain("감시 예약");
	const prev = setWebView(() => resolveView("en", diskReader()));
	try {
		const en = JSON.stringify(allNotices());
		expect(en).not.toBe(ko);
	} finally {
		setWebView(prev);
	}
	expect(JSON.stringify(allNotices())).toBe(ko);
});

test("readable keeps a notice that needs no rewording as the very same object", () => {
	post("alert", "[done] 작업을 끝냈어요");
	const stored = readable({ id: "a", ts: "t", updated: "t", kind: "alert", tone: "done", title: "알림", text: "작업을 끝냈어요", open: "alert", read: false });
	expect(readable(stored)).toBe(stored);
});
