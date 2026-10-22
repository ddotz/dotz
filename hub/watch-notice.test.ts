import { afterAll, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { listNotices, setOrchestratorAvailable, setWatchLabelResolver } from "./notices.ts";
import { watchLine, watchReasonKo } from "./watchtext.ts";
import { allWatches, removeWatch } from "./watch.ts";
import { clearChannel, setupChannel, watchLabel, watchWakeEvent } from "./workchannels.ts";

setWatchLabelResolver(watchLabel);
const CH = "1562723146669490227";
const CH2 = "1562723146669490228";
const NAME = "까르띠에-재고-구매";
const noticesFor = (title: string) => listNotices().items.filter(n => n.kind === "watch" && n.title === title);

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
	expect(watchLine("재고 감시", "output changed", "cartier_mails=1")).toBe("재고 감시: 결과가 바뀌었어요\ncartier_mails=1");
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
	expect(watchLabel("not-a-watch")).toBe("not-a-watch");
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
	expect(n).toMatchObject({ kind: "watch", open: "alert", text: `${NAME} 감시 2: 결과가 바뀌었어요\ncartier_mails=1` });
});

test("events routed to alert or chat, or an orchestrator event without a channel, keep their notice", () => {
	const base = allWatches().find(x => x.channels?.includes(CH))!;
	emit("inbox", watchWakeEvent({ ...base, name: "plain-alert", to: "alert" }, "output changed", "a=1"));
	emit("inbox", watchWakeEvent({ ...base, name: "plain-chat", to: "chat" }, "match", "b=2"));
	emit("inbox", watchWakeEvent({ ...base, name: "no-channel", channels: undefined }, "fail", "c=3"));
	expect(noticesFor("plain-alert")[0]!.text).toBe("plain-alert: 결과가 바뀌었어요\na=1");
	expect(noticesFor("plain-chat")[0]!.text).toBe("plain-chat: 찾던 내용이 나왔어요\nb=2");
	expect(noticesFor("no-channel")[0]!.text).toBe("no-channel: 점검에 실패했어요\nc=3");
});

test("a notice stored with the raw watch name and English reason renders with the label and Korean", () => {
	const w = allWatches().find(x => x.channels?.includes(CH) && watchLabel(x.name) === `${NAME} 감시 1`)!;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "gateway", target: "ch:123", text: `[${w.name}] output changed\ncartier_mails=1` });
	const shown = listNotices().items.find(n => n.kind === "watch" && n.title === `${NAME} 감시 1`);
	expect(shown?.text).toBe(`${NAME} 감시 1: 결과가 바뀌었어요\ncartier_mails=1`);
});

test("cleanup removes the test watches", () => {
	for (const w of allWatches().filter(x => x.channels?.includes(CH) || x.channels?.includes(CH2))) removeWatch(w.id);
	expect(allWatches().some(x => x.channels?.includes(CH))).toBe(false);
});
