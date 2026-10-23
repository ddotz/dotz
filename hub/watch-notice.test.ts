import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { emit } from "./events.ts";
import { keepWatchNewest, listNotices, NOTICE_CAP, setOrchestratorAvailable, setWatchLabelResolver, WATCH_DAYS, WATCH_KEEP } from "./notices.ts";
import { rawFence, watchLine, watchReasonKo } from "./watchtext.ts";
import { addWatch, allWatches, relabelWatches, removeWatch } from "./watch.ts";
import { clearChannel, setupChannel, watchLabel, watchWakeEvent } from "./workchannels.ts";

setWatchLabelResolver(watchLabel);
const CH = "1562723146669490227";
const CH2 = "1562723146669490228";
const NAME = "까르띠에-재고-구매";
// The whole store, not the first page: the notice store is shared with every test file in the run, and unread ones from earlier files fill a 100-item page.
const noticesFor = (title: string) => listNotices(NOTICE_CAP).items.filter(n => n.kind === "watch" && n.title === title);

afterAll(() => {
	setOrchestratorAvailable(() => true);
	clearChannel(CH);
	clearChannel(CH2);
});

test("reasons of the watch runner read as Korean and unknown ones pass through", () => {
	expect(watchReasonKo("output changed")).toBe("결과가 바뀌었어요");
	expect(watchReasonKo("matched /재고/")).toBe("찾던 내용이 나왔어요");
	expect(watchReasonKo("match")).toBe("찾던 내용이 나왔어요");
	expect(watchReasonKo("fail")).toBe("점검에 실패했어요");
	expect(watchReasonKo("recovered")).toBe("다시 정상이에요");
	expect(watchReasonKo("failed 3 times in a row (exit 1)")).toBe("3번 연속 실패했어요");
	expect(watchReasonKo("바뀌었어요")).toBe("바뀌었어요");
	expect(watchLine("재고 감시", "output changed", "cartier_mails=1")).toBe("재고 감시: 결과가 바뀌었어요\n```원문\ncartier_mails=1\n```");
	expect(watchLine("재고 감시", "output changed", "cartier_mails=1", { raw: false })).toBe("재고 감시: 결과가 바뀌었어요");
	expect(watchLine("재고 감시", "output changed", " ")).toBe("재고 감시: 결과가 바뀌었어요");
});

test("channel monitors are named by the channel, and two Korean channels never share a key", () => {
	const a = setupChannel({ channel: `ch:${CH}`, purpose: "재고 확인", monitors: [{ command: "echo cartier_mails=0" }, { command: "echo cartier_mails=1" }] }, NAME, "");
	const b = setupChannel({ channel: `ch:${CH2}`, purpose: "다른 일", monitors: [{ command: "echo 1", label: "메일 감시" }] }, "다른-채널", "");
	expect(new Set([...a.monitors, ...b.monitors]).size).toBe(3);
	expect(a.monitors[1]).toMatch(/^ch-[a-z0-9-]+$/);
	expect(watchLabel(a.monitors[0]!)).toBe(`${NAME} 감시 1`);
	expect(watchLabel(a.monitors[1]!)).toBe(`${NAME} 감시 2`);
	expect(watchLabel(b.monitors[0]!)).toBe("메일 감시");
	expect(watchLabel("not-a-watch")).toBe("not a watch");
});

test("a channel monitor event routed to the orchestrator makes no notice while the orchestrator is up", () => {
	const name = allWatches().find(w => w.channels?.includes(CH) && watchLabel(w.name) === `${NAME} 감시 2`)!;
	setOrchestratorAvailable(() => true);
	emit("inbox", watchWakeEvent(name, "output changed", "cartier_mails=1"));
	expect(noticesFor(`${NAME} 감시 2`)).toHaveLength(0);
});

test("with the orchestrator unavailable the same event is a Korean notice titled by the channel", () => {
	const w = allWatches().find(x => x.channels?.includes(CH) && watchLabel(x.name) === `${NAME} 감시 2`)!;
	setOrchestratorAvailable(() => false);
	try {
		emit("inbox", watchWakeEvent(w, "output changed", "cartier_mails=1"));
	} finally {
		setOrchestratorAvailable(() => true);
	}
	const [n] = noticesFor(`${NAME} 감시 2`);
	expect(n).toMatchObject({ kind: "watch", open: "alert", text: `${NAME} 감시 2: 결과가 바뀌었어요\n${rawFence("cartier_mails=1")}` });
});

test("events routed to alert or chat, or an orchestrator event without a channel, keep their notice", () => {
	const base = allWatches().find(x => x.channels?.includes(CH))!;
	emit("inbox", watchWakeEvent({ ...base, name: "plain-alert", to: "alert" }, "output changed", "a=1"));
	emit("inbox", watchWakeEvent({ ...base, name: "plain-chat", to: "chat" }, "match", "b=2"));
	emit("inbox", watchWakeEvent({ ...base, name: "no-channel", channels: undefined }, "fail", "c=3"));
	expect(noticesFor("plain alert")[0]!.text).toBe(`plain alert: 결과가 바뀌었어요\n${rawFence("a=1")}`);
	expect(noticesFor("plain chat")[0]!.text).toBe(`plain chat: 찾던 내용이 나왔어요\n${rawFence("b=2")}`);
	expect(noticesFor("no channel")[0]!.text).toBe(`no channel: 점검에 실패했어요\n${rawFence("c=3")}`);
});

test("a notice stored with the raw watch name and English reason renders with the label and Korean", () => {
	const w = allWatches().find(x => x.channels?.includes(CH) && watchLabel(x.name) === `${NAME} 감시 1`)!;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target: "ch:123", text: `[${w.name}] output changed\ncartier_mails=1` });
	const shown = listNotices(NOTICE_CAP).items.find(n => n.kind === "watch" && n.title === `${NAME} 감시 1`);
	expect(shown?.text).toBe(`${NAME} 감시 1: 결과가 바뀌었어요`);
});

test("cleanup removes the test watches", () => {
	for (const w of allWatches().filter(x => x.channels?.includes(CH) || x.channels?.includes(CH2))) removeWatch(w.id);
	expect(allWatches().some(x => x.channels?.includes(CH))).toBe(false);
});

test("a watch added without a label is named in Korean once, and a key-shaped label is replaced at boot", () => {
	const a = addWatch({ name: "sample-stock-check", command: "echo a=1" }, "");
	const b = addWatch({ name: "ch-9-3", command: "echo a=1" }, "");
	const c = addWatch({ name: "sample-keep", command: "echo a=1", label: "sample keep" }, "");
	try {
		expect(a.label).toBe("sample 재고 확인");
		expect(b.label).toBe("프로젝트 감시 3");
		expect(relabelWatches(() => "샘플")).toBe(1);
		expect(allWatches().find(w => w.id === c.id)!.label).toBe("샘플 sample keep");
		expect(watchLabel("ch-9-3")).toBe("프로젝트 감시 3");
		expect(watchLabel("ch ch 2")).toBe("프로젝트 감시 2");
	} finally {
		for (const w of [a, b, c]) removeWatch(w.id);
	}
});

const ago = (ms: number) => new Date(Date.parse(now()) - ms).toISOString();
const report = (label: string, ts: string, text: string) => emit("inbox", { ts, kind: "watch", watch: "sample-prune", label, to: "alert", reason: "output changed", text });

const aged = (title: string, ms: number, state?: string) => ({ kind: "watch", title, updated: ago(ms), ...(state ? { decision: { state } } : {}) });

test(`each watch keeps its newest ${WATCH_KEEP} reports and only those, the other watches and kinds are left alone`, () => {
	const mine = Array.from({ length: WATCH_KEEP + 10 }, (_, i) => aged("정리 시험 가", (i + 1) * 60_000));
	const other = [aged("정리 시험 나", 1000), { kind: "message", title: "정리 시험 가", updated: ago(1) }];
	const kept = keepWatchNewest([...other, ...mine], Date.parse(now()));
	const keptMine = kept.filter(n => n.kind === "watch" && n.title === "정리 시험 가");
	expect(keptMine).toHaveLength(WATCH_KEEP);
	expect(keptMine).toEqual(mine.slice(0, WATCH_KEEP));
	expect(kept).toHaveLength(WATCH_KEEP + 2);
});

test("a report older than the age limit is dropped, a fresh one stays, an open decision is never dropped", () => {
	const old = aged("정리 시험 다", (WATCH_DAYS + 1) * 86_400_000);
	const fresh = aged("정리 시험 다", 3_600_000);
	const open = aged("정리 시험 다", (WATCH_DAYS + 2) * 86_400_000, "open");
	expect(keepWatchNewest([old, fresh, open], Date.parse(now()))).toEqual([fresh, open]);
});

test("a report written through the hub is kept at the newest 50 per watch", () => {
	for (let i = 0; i < WATCH_KEEP + 5; i++) report("정리 시험 라", ago((WATCH_KEEP + 5 - i) * 1000), "Item " + i);
	expect(listNotices(300).items.filter(n => n.kind === "watch" && n.title === "정리 시험 라").length).toBeLessThanOrEqual(WATCH_KEEP);
});
