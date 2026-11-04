import { beforeEach, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { retireStoredAsks } from "./asks.ts";
import { answerDecision, ignoreNotice, listNotices, needsAnswer, type Notice, resetNoticesForTest } from "./notices.ts";

// One lane question is one item on every list (owner 2026-11-05: "2개가 사실상 같은 질문지인데 따로 생성되고 있음"): the lists of the 알림 screen, 답변 필요
// and the push all read the notices, so these count them after the real event path.
beforeEach(resetNoticesForTest);
const T0 = Date.UTC(2026, 10, 5, 0, 0);
let tick = 0;
const at = () => new Date(T0 + ++tick * 1000).toISOString();
const ASK = "[ask] 디자인 문서를 다 썼어요.\n\n결정: 자기 주소가 있는 컴퓨터를 고르면 어떻게 열까요?\n**1) 그 주소의 웹앱으로 이동**\n화면과 기능이 그대로예요.\n**2) 평소 채팅 화면에서 중계**\n앱 안에 머물러요.";
const laneReport = (text: string) => emit("inbox", { ts: at(), kind: "lane_report", source: "lane:web", lane: "web", text });
const waiting = () => listNotices().items.filter(needsAnswer);
const asked = () => listNotices().items.filter(n => n.tone === "ask");

test("a lane's [ask] is one item, its title the question, and the same words again stay one", () => {
	laneReport(ASK);
	expect(asked()).toHaveLength(1);
	const [n] = waiting();
	expect(n).toMatchObject({ kind: "decision", title: "자기 주소가 있는 컴퓨터를 고르면 어떻게 열까요?" });
	expect(n!.decision!.options.map(o => o.label)).toEqual(["그 주소의 웹앱으로 이동", "평소 채팅 화면에서 중계"]);
	laneReport(ASK);
	emit("outbox", { ts: at(), kind: "out", source: "lane:web", target: "lane:web", text: ASK });
	expect(asked()).toHaveLength(1);
});

test("answering clears the one item everywhere", async () => {
	laneReport(ASK);
	const before = listNotices().unread;
	const r = await answerDecision(waiting()[0]!.id, { n: 1 }, async () => {});
	expect(r.status).toBe(200);
	expect(waiting()).toEqual([]);
	expect(listNotices().unread).toBe(before - 1);
});

test("the x clears it too, with nothing left behind", () => {
	laneReport(ASK);
	ignoreNotice(waiting()[0]!.id);
	expect(waiting()).toEqual([]);
});

test("a [done] holding a choice block keeps its result row beside the card: only an [ask] is one item", () => {
	laneReport("[done] 끝났어요.\n\n결정: 바로 반영할까요?\n**1) 네**\n**2) 아니요**");
	expect(listNotices().items.map(n => n.kind).sort()).toEqual(["decision", "result"]);
});

test("stored items: a twin leaves the lists, a session's question without choices closes, the rest stay", () => {
	const base = { ts: "t", updated: "t", tone: "ask", read: false, text: "x" };
	const item = (o: Record<string, unknown>) => ({ ...base, ...o }) as unknown as Notice;
	const list = [
		item({ id: "twin", kind: "result", title: "웹앱", at: "a1", src: "lane:web", open: "lane:web", by: "lane:web" }),
		item({ id: "card", kind: "decision", title: "고를까요?", at: "a1", decision: { options: [{ n: 1, label: "네" }, { n: 2, label: "아니요" }], to: "lane:web", reply_to: "a1", group: 1, state: "open" } }),
		item({ id: "bare", kind: "decision", title: "형의 답을 기다리는 중이에요", at: "a2", decision: { options: [], to: "lane:web", reply_to: "a2", group: 1, state: "open" } }),
		item({ id: "loose", kind: "result", title: "웹앱", at: "a3", src: "lane:api", open: "lane:api", by: "lane:api" }),
		item({ id: "main", kind: "decision", title: "언제 할까요?", at: "a4", decision: { options: [], to: "main", reply_to: "a4", group: 1, state: "open" } }),
	];
	expect(retireStoredAsks(list, "z")).toBe(3);
	const by = (id: string) => list.find(n => n.id === id)!;
	expect(by("twin")).toMatchObject({ read: true, dismissed: true });
	expect(by("card")).toMatchObject({ read: false, decision: { state: "open" } });
	expect(by("bare")).toMatchObject({ read: true, decision: { state: "answered", resolved: true } });
	expect(by("loose").read).toBe(true);
	expect(by("loose").dismissed).toBeUndefined();
	expect(by("main").decision!.state).toBe("open");
	expect(retireStoredAsks(list, "z")).toBe(0);
});
