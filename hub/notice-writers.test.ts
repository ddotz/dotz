import { expect, test } from "bun:test";
import { NAME } from "./config.ts";
import { emit, type HubEvent, onEmit } from "./events.ts";
import { classOfNotice } from "./notice-class.ts";
import { kindOf, pushTitle } from "./notice-kinds.ts";
import { allNotices, type Notice, onNoticeUnread } from "./notices.ts";
import { route } from "./notify-route.ts";
import { alert, laneFailed, out } from "./outbound.ts";
import { classify, noticePush } from "./push.ts";
import { reportSend } from "./reply-wire.ts";
import { flush } from "./runtime/test-clock.ts";
import type { Watch } from "./watch.ts";
import { watchWakeEvent } from "./workchannels.ts";

const u = Date.now().toString(36);
const unread: Notice[] = [];
onNoticeUnread(n => unread.push({ ...n }));
const outs: HubEvent[] = [];
onEmit(e => void (e.kind === "out" && outs.push(e)));
const latest = (pick: (n: Notice) => boolean): Notice | undefined => allNotices().findLast(pick);

test("a reply send that failed, may have gone out, or was taken back by a restart is an alert in the bell and on the phone", async () => {
	const base = { conv: "main", title: `견적 답장 ${u}`, text: "상대 서버가 거부했어요", at: Date.now() };
	reportSend({ ...base, ref: `f${u}`, state: "failed" });
	reportSend({ ...base, ref: `s${u}`, state: "unsure" });
	reportSend({ ...base, ref: `b${u}`, state: "back", cause: "restart" });
	await flush();
	for (const [ref, nk] of [[`f${u}`, "send-fail"], [`s${u}`, "send-check"], [`b${u}`, "send-check"]] as const) {
		const n = unread.find(x => x.text.includes(`(${ref})`));
		expect([ref, n && classOfNotice(n).cls]).toEqual([ref, "alert"]);
		expect([ref, n && noticePush(n)]).toMatchObject([ref, { kind: "alert", title: pushTitle(nk, NAME), url: expect.stringContaining("#chat/main") }]);
	}
});

test("an owner message that could not reach its session is an alert in the conversation it was written in", async () => {
	laneFailed("web", `gone${u}`, undefined, new Error(`no such session ${u}`));
	await flush();
	const n = unread.find(x => x.text.includes(`gone${u}`));
	expect(n && classOfNotice(n).cls).toBe("alert");
	expect(n && noticePush(n)).toMatchObject({ kind: "alert", title: pushTitle("undelivered", NAME), url: expect.stringContaining("#chat/main") });
});

test("the gateway's usage-limit stop and its orchestrator-error answer are alerts", async () => {
	await out("web", `지금 사용량 한도로 멈춰 있어요 ${u}`, undefined, { source: "gateway", nk: "usage-stop" });
	await out("web", `오케스트레이터만 다시 시작해요 ${u}`, undefined, { source: "gateway", nk: "orch-error" });
	for (const [said, nk] of [["한도로 멈춰", "usage-stop"], ["다시 시작해요", "orch-error"]] as const) {
		const n = unread.find(x => x.text.includes(`${said}`) && x.text.includes(u));
		expect([nk, n && classOfNotice(n).cls]).toEqual([nk, "alert"]);
		expect([nk, n && noticePush(n)]).toMatchObject([nk, { kind: "alert", title: pushTitle(nk, NAME) }]);
	}
});

test("the work ledger's own notice is news in the bell and on the phone", async () => {
	await out("web", `내일 마감인 일이 1건 있어요.\n- 세금 신고 ${u}`, undefined, { source: "gateway", nk: "ledger", news: true });
	const n = unread.find(x => x.text.includes(`세금 신고 ${u}`));
	expect(n && classOfNotice(n).cls).toBe("news");
	expect(n && noticePush(n)).toMatchObject({ kind: "news", title: pushTitle("ledger", NAME), url: expect.stringContaining("#chat/main") });
});

test("a gateway note reaches no bell and no phone, and goes to Discord and messengers as an unnamed gateway line did", async () => {
	await out("web", `모델을 바꿨어요 ${u}`, undefined, { source: "gateway", nk: "gateway-note" });
	expect(kindOf("gateway-note")).toBe("gateway-note");
	expect(allNotices().some(n => n.text.includes(`모델을 바꿨어요 ${u}`))).toBe(false);
	const r = (extra: Record<string, unknown>) => route({ target: "web", text: "모델을 바꿨어요", extra, replyTo: "123456789012345678", messengers: ["jandi"] });
	expect(r({ source: "gateway", nk: "gateway-note" })).toEqual({ ...r({ source: "gateway" }), push: false });
	expect(r({ source: "gateway", nk: "gateway-note" }).messengers).toEqual({ discord: true, jandi: true });
});

test("a conversation answer notifies again once five minutes passed since that conversation's last push, and lands on that answer", () => {
	const conv = `ch:${Date.now() % 1_000_000_000}${u.length}`;
	const t0 = Date.parse("2026-11-19T01:00:00.000Z");
	const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
	const said = (min: number) => emit("outbox", { ts: at(min), kind: "out", source: "orchestrator", target: conv, text: `답 ${min}분 ${u}` });
	const mine = () => unread.filter(n => n.key === `msg:${conv}`);
	said(0);
	said(3);
	expect(mine().length).toBe(1);
	said(6);
	expect(mine().length).toBe(2);
	expect(noticePush(mine().at(-1)!)).toMatchObject({ kind: "conv", ts: at(6), url: expect.stringContaining(`m=${encodeURIComponent(at(6))}`) });
	said(8);
	expect(mine().length).toBe(2);
});

test("an orchestrator answer in the alert conversation is no alert push, and a gateway alert there still is", async () => {
	await out("alert", `확인해 보니 디스크 한도 문제는 없었어요 ${u}`, undefined, { source: "orchestrator" });
	const answer = outs.findLast(e => String(e.text).includes(`한도 문제는 없었어요 ${u}`))!;
	expect(classify(answer)?.kind).not.toBe("alert");
	const item = latest(n => n.text.includes(`한도 문제는 없었어요 ${u}`));
	expect(item && noticePush(item)?.kind).not.toBe("alert");
	alert(`땃쥐: 모델 제공자 오류 ${u}`);
	const real = latest(n => n.text.includes(`모델 제공자 오류 ${u}`));
	expect(real && noticePush(real)).toMatchObject({ kind: "alert", title: pushTitle("alert", NAME) });
});

test("an orchestrator [fail] or [ask] in the alert conversation keeps its own class (only a plain answer there is a conversation answer)", async () => {
	await out("alert", `[fail] 디스크 정리에 실패했어요 ${u}`, undefined, { source: "orchestrator" });
	const failed = latest(n => n.text.includes(`디스크 정리에 실패했어요 ${u}`));
	expect(failed && classOfNotice(failed).cls).toBe("alert");
	expect(failed && noticePush(failed)?.kind).toBe("alert");
});

const watch = (name: string): Watch => ({ id: name, name, command: "true", every_minutes: 30, on: "change", to: "web", created: "2026-11-19T00:00:00.000Z", state: { fails: 0 } });
test("a monitor report with a [fail] line is an alert; any other report stays news", () => {
	emit("inbox", watchWakeEvent(watch(`cmt-fail-${u}`), "output changed", `[fail] 블로그: 김님 댓글에 답글을 올리지 못했어요 ${u}\n블로그: 새 댓글 1개`));
	emit("inbox", watchWakeEvent(watch(`cmt-news-${u}`), "output changed", `블로그: 새 댓글 1개가 답을 기다려요 ${u}`));
	const failed = latest(n => n.watch === `cmt-fail-${u}`);
	expect(failed && classOfNotice(failed).cls).toBe("alert");
	expect(failed && noticePush(failed)?.kind).toBe("alert");
	const news = latest(n => n.watch === `cmt-news-${u}`);
	expect(news && classOfNotice(news).cls).toBe("news");
	expect(news && noticePush(news)?.kind).toBe("news");
});
