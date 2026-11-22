import { beforeEach, afterEach, expect, test } from "bun:test";
import { webAnswer } from "./approval-wire.ts";
import { emit, onEmit, type HubEvent } from "./events.ts";
import { flush, sendWeb } from "./intake.ts";
import { LaneRuntimeMismatch } from "./lanerun.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { deliverAnswer } from "./routes.ts";
import { setUpdateNow, type UpdateNow } from "./update-now.ts";

const LANE = "sample-2";
const QUESTION = "어디로 받을까요?";
const ENDED = "이 세션은 이미 끝나서 전달하지 못했어요";
const RAW = /does not exist|report\.md|\/lanes\/|ECONNRESET|\/tmp\//;

const seen: HubEvent[] = [];
onEmit(e => void seen.push(e));
const held: string[] = [];
beforeEach(() => {
	resetNoticesForTest();
	seen.length = 0;
	held.length = 0;
	setUpdateNow({ hold: (text: string) => (held.push(text), true), holding: () => false } as unknown as UpdateNow);
});
afterEach(() => setUpdateNow(undefined));

const ask = () => {
	const ts = new Date(Date.now() - 60_000).toISOString();
	emit("inbox", { ts, kind: "lane_report", source: `lane:${LANE}`, lane: LANE, text: `[ask] ${QUESTION}\n결정: ${QUESTION}\n**1) 회사 메일로 받기**\n**2) 집 메일로 받기**` });
	return listNotices(100).items.find(n => n.kind === "decision" && n.decision?.to === `lane:${LANE}`)!;
};
const deliver = (login = "me") => (a: Parameters<typeof deliverAnswer>[0]) => deliverAnswer({ ...a, login });
const ownerReads = () => JSON.stringify([seen.filter(e => e.kind === "out" || e.kind === "delivery").map(e => e.text), listNotices(300).items.map(n => [n.title, n.text])]);

test("an answer to a session that is gone is refused and the card stays open: no answered card, no raw lane error or path anywhere the owner reads", async () => {
	const card = ask();
	const r = await webAnswer(card.id, { n: 1 }, "me", deliver());
	expect(r).toMatchObject({ status: 409, body: { code: "session_ended", error: ENDED } });
	expect(listNotices(100).items.find(n => n.id === card.id)!.decision).toMatchObject({ state: "open" });
	expect(seen.some(e => e.kind === "lane_message")).toBe(false);
	expect(ownerReads()).toContain("이미 끝나서");
	expect(ownerReads()).not.toMatch(RAW);
});

test("words typed in the sheet to a session that is gone are refused the same way", async () => {
	const card = ask();
	const r = await webAnswer(card.id, { note: "회사 메일로 해 줘" }, "me", deliver());
	expect(r).toMatchObject({ status: 409, body: { code: "session_ended" } });
	expect(listNotices(100).items.find(n => n.id === card.id)!.decision!.state).toBe("open");
});

test("메인에 넘기기 hands the question and the owner's answer to the main conversation and closes the card", async () => {
	const card = ask();
	expect((await webAnswer(card.id, { n: 1 }, "me", deliver())).status).toBe(409);
	const r = await webAnswer(card.id, { n: 1, handoff: "main" }, "me", deliver());
	expect(r.status).toBe(200);
	const closed = listNotices(100).items.find(n => n.id === card.id)!.decision!;
	expect(closed.state).toBe("answered");
	expect(closed.answer).toContain("1) 회사 메일로 받기");
	flush("web");
	expect(held).toHaveLength(1);
	for (const part of [LANE, QUESTION, "1) 회사 메일로 받기"]) expect(held[0]).toContain(part);
	expect(seen.some(e => e.kind === "message" && e.channel === "web" && String(e.text).includes(QUESTION))).toBe(true);
	expect(ownerReads()).not.toMatch(RAW);
});

test("a hand-off is only for a question a session asked", async () => {
	const main = (() => {
		emit("outbox", { ts: new Date(Date.now() - 60_000).toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] ${QUESTION}\n결정: ${QUESTION}\n**1) 회사 메일로 받기**\n**2) 집 메일로 받기**` });
		return listNotices(100).items.find(n => n.kind === "decision" && n.decision?.to === "main")!;
	})();
	expect(await webAnswer(main.id, { n: 1, handoff: "main" }, "me", deliver())).toMatchObject({ status: 400 });
	expect(listNotices(100).items.find(n => n.id === main.id)!.decision!.state).toBe("open");
});

test("any other delivery failure also leaves the card open and shows a Korean reason without the raw error", async () => {
	const card = ask();
	const r = await webAnswer(card.id, { n: 2 }, "me", async () => {
		throw new Error("ECONNRESET while writing /tmp/lanes/sample-2/report.md");
	});
	expect(r).toMatchObject({ status: 409, body: { code: "not_delivered", error: "전달하지 못했어요. 잠시 뒤에 다시 해 주세요" } });
	expect(listNotices(100).items.find(n => n.id === card.id)!.decision!.state).toBe("open");
});

test("a session of another runtime is refused in its own words, which offer the handover, not the generic retry line", async () => {
	const card = ask();
	const refusal = new LaneRuntimeMismatch(LANE, "omp", "omo");
	const r = await webAnswer(card.id, { n: 1 }, "me", async () => {
		throw refusal;
	});
	expect(r).toMatchObject({ status: 409, body: { code: "runtime_mismatch", error: refusal.message } });
	expect(listNotices(100).items.find(n => n.id === card.id)!.decision!.state).toBe("open");
});

test("a message typed to a session that is gone ends with the same reason, and the chat note names no path", async () => {
	await expect(sendWeb({ lane: LANE, channel: "web", text: "상태 알려줘", mode: "default", login: "me" })).rejects.toThrow(ENDED);
	expect(ownerReads()).not.toMatch(RAW);
	expect(ownerReads()).toContain("이미 끝나서");
});
