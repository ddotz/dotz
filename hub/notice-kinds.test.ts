import { expect, test } from "bun:test";
import { emit, type HubEvent } from "./events.ts";
import { NOTICE_CLASSES } from "./notice-class.ts";
import { NOTICE_KIND_NAMES, NOTICE_KINDS, type NoticeKindName, pushTitle } from "./notice-kinds.ts";
import { allNotices, type Notice, onDecision, onNoticeUnread, updateAvailable } from "./notices.ts";
import { postClass } from "./notify-route.ts";
import { classify, decisionPush, noticePush } from "./push.ts";
import { diskReader, HANGUL, resolveView, webText } from "./web-i18n.ts";

const u = Date.now().toString(36);
const ch = `ch:${Date.now()}`;
const at = (i: number) => new Date(Date.now() - 3_600_000 + i * 1000).toISOString();
const out = (i: number, e: Record<string, unknown>): HubEvent => ({ ts: at(i), kind: "out", source: "orchestrator", text: "", ...e });
const SAMPLES: Record<NoticeKindName, { event?: HubEvent; run?: () => void; find: (n: Notice) => boolean }> = {
	ask: { event: out(1, { target: `${ch}01`, text: `[ask] 어느 쪽으로 할까요 ${u}?` }), find: n => n.text.includes(`할까요 ${u}`) },
	"session-ask": { event: out(2, { source: `lane:ka${u}`, target: `lane:ka${u}`, text: `[ask] 머지할까요 ${u}?` }), find: n => n.text.includes(`머지할까요 ${u}`) },
	decision: { event: out(3, { target: `${ch}02`, text: `[ask] 정해 주세요.\n결정: 배포 ${u}\n**1) 지금**\n**2) 밤에**` }), find: n => n.title === `배포 ${u}` },
	alert: { event: out(4, { source: "gateway", target: "alert", text: `땃쥐: 모델 제공자 오류 ${u}` }), find: n => n.text.includes(`오류 ${u}`) },
	"session-fail": { event: { ts: at(5), kind: "lane_report", source: `lane:kf${u}`, lane: `kf${u}`, text: "[fail] 테스트가 깨졌어요" }, find: n => n.open === `lane:kf${u}` },
	"worklog-fail": { event: out(6, { source: "gateway", target: "worklog", text: `[fail] 야간 정리 실패 ${u}` }), find: n => n.text.includes(`정리 실패 ${u}`) },
	"answer-fail": { event: out(7, { target: `${ch}07`, text: `[fail] 못 했어요 ${u}` }), find: n => n.open === `${ch}07` },
	"session-done": { event: { ts: at(8), kind: "lane_report", source: `lane:kd${u}`, lane: `kd${u}`, text: "[done] 끝났어요" }, find: n => n.open === `lane:kd${u}` },
	"worklog-done": { event: out(9, { target: "worklog", text: `[done] 정리 끝 ${u}` }), find: n => n.text.includes(`정리 끝 ${u}`) },
	"answer-done": { event: out(10, { target: `${ch}10`, text: `[done] 다 했어요 ${u}` }), find: n => n.open === `${ch}10` },
	mail: { event: { ts: at(11), kind: "mail", source: "acme", incoming: true, mail: `km${u}`, from: "Kim <kim@example.com>", subject: `견적 ${u}`, text: "" }, find: n => n.open === `mail:km${u}` },
	watch: { event: out(12, { source: "gateway", target: `${ch}12`, text: `[감시${u}] 새 글이 올라왔어요` }), find: n => n.open === `${ch}12` },
	"self-update": { run: () => updateAvailable(`dotz ${u} 버전이 나왔어요`), find: n => n.key === "self-update" },
	answer: { event: out(13, { target: `${ch}13`, text: `보고서 정리했어요 ${u}` }), find: n => n.open === `${ch}13` },
};

test("every notice kind has a title in each language (no Korean on an English install), a class, and a place a tap opens", () => {
	const en = resolveView("en", diskReader());
	for (const k of NOTICE_KIND_NAMES) {
		const row = NOTICE_KINDS[k];
		expect([k, NOTICE_CLASSES.includes(row.cls)]).toEqual([k, true]);
		expect(pushTitle(k, "dotz").trim()).not.toBe("");
		expect([k, HANGUL.test(pushTitle(k, "dotz", en))]).toEqual([k, false]);
		expect(row.open({ name: "dotz", conv: "lane:x", id: "n1" })).not.toBe("");
	}
});

test("a sample of every notice kind makes a bell item and a phone notification of that kind's class and title", () => {
	const bell: Notice[] = [];
	onNoticeUnread(n => bell.push(n));
	onDecision(n => bell.push(n));
	for (const k of NOTICE_KIND_NAMES) {
		const s = SAMPLES[k];
		if (s.event) emit(s.event.kind === "out" ? "outbox" : "inbox", s.event);
		else s.run?.();
		const n = bell.findLast(s.find) ?? allNotices().find(s.find);
		expect([k, n !== undefined]).toEqual([k, true]);
		const m = k === "decision" ? decisionPush(n!) : ((s.event && classify(s.event)) ?? noticePush(n!));
		const row = NOTICE_KINDS[k];
		expect([k, m?.kind, m?.title.endsWith(webText(row.title, { name: "" }).trim())]).toEqual([k, row.cls, true]);
	}
});

test("a writer that names its kind is classed by it, and a kind the registry does not know falls back to the guess", () => {
	expect(classify({ ts: at(20), kind: "out", source: "gateway", target: "alert", text: `땃쥐: 보내지 못했어요 ${u}`, nk: "session-fail" })).toMatchObject({ kind: "alert" });
	expect(postClass("main", "[fail] 보내지 못했어요", { source: "gateway", nk: "alert" })).toBe("alert");
	expect(postClass("main", "[fail] 보내지 못했어요", { source: "gateway", nk: "no-such-kind" })).toBeUndefined();
	expect(noticePush({ id: "nk1", ts: at(21), updated: at(21), kind: "message", tone: "", title: "x", text: "본문", open: "main", at: at(21), read: false, nk: "alert" })).toMatchObject({ kind: "alert" });
});
