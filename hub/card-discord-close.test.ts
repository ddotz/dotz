// A card on Discord follows its notice: a choice card turns its buttons off the moment it closes anywhere (ignored, answered on the web, expired),
// not only when a button is pressed; a failed scheduled run's card, made by the gateway with no post, goes to Discord as that same notice.
// Discord itself is faked: the send ledger and the button switch are spied, so no request leaves the test.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as discord from "./discord.ts";
import { askComponentsFor } from "./askbuttons.ts";
import { discordGatewayAnswer, discordPicks } from "./approval-wire.ts";
import { emit } from "./events.ts";
import { inboxText } from "./intake.ts";
import { allNotices, answerDecision, ignoreNotice, reopenNotices, unignoreNotice } from "./notices.ts";
import { settleExpiredQuestions } from "./notices-answers.ts";
import { out, sends } from "./outbound.ts";
import { advance } from "./runtime/test-clock.ts";
import { FAIL_AFTER_MS, fireSchedule, sweepRuns } from "./schedule-fire.ts";
import { addSchedule, runNow, startSchedules } from "./schedule.ts";

let posted = 0;
const submit = spyOn(sends, "submit").mockImplementation(async () => ({ delivered: true, ids: [`m${++posted}`] }));
const off = spyOn(discord, "disableButtons").mockImplementation(async () => {});
const on = spyOn(discord, "enableButtons").mockImplementation(async () => {});
const enabled = discord.status.enabled;
beforeAll(() => {
	discord.status.enabled = true;
	startSchedules((s, group, runs) => fireSchedule(s, group, runs, { emit, deliver: () => {}, inboxText, fallback: () => "web" }));
});
afterAll(() => {
	discord.status.enabled = enabled;
	submit.mockRestore();
	off.mockRestore();
	on.mockRestore();
});

const card = (title: string) => `[ask] ${title}\n\n**1) 지금 하기**\n바로 해요\n**2) 내일 하기**\n내일 아침에 해요`;
const cardOf = (title: string) => allNotices().find(n => n.decision?.state === "open" && n.title.includes(title));
// The Discord message of each post, in order: the id the faked ledger gave it.
const lastId = () => `m${posted}`;

test("a choice card's Discord buttons turn off when it is ignored, answered on the web or expires, with no press", async () => {
	for (const [title, close] of [
		["sample 배포를 할까요", (id: string) => void ignoreNotice(id)],
		["sample 정리를 할까요", (id: string) => void answerDecision(id, { n: 1 }, async () => undefined)],
		["sample 백업을 할까요", () => void settleExpiredQuestions(new Date(Date.now() + 100 * 3_600_000).toISOString())],
	] as const) {
		off.mockClear();
		await out("chat", card(title));
		const n = cardOf(title)!, id = lastId();
		expect(n.decision!.card).toMatchObject({ target: "chat", ids: [id] });
		close(n.id);
		await Bun.sleep(0);
		expect(off.mock.calls).toEqual([["chat", id]]);
	}
});

test("a card that opens again, an ignore taken back or an answer put back, gets its Discord buttons back", async () => {
	on.mockClear();
	await out("chat", card("sample 재개를 할까요"));
	const n = cardOf("sample 재개를 할까요")!, id = lastId();
	ignoreNotice(n.id);
	expect(on.mock.calls).toEqual([]);
	unignoreNotice(n.id);
	expect(on.mock.calls).toEqual([["chat", id]]);
	on.mockClear();
	await answerDecision(n.id, { n: 1 }, async () => undefined);
	expect(on.mock.calls).toEqual([]);
	reopenNotices([n.id]);
	expect(on.mock.calls).toEqual([["chat", id]]);
	// A card that was never closed is not "opened again": reopening it switches nothing.
	on.mockClear();
	reopenNotices([n.id]);
	expect(on.mock.calls).toEqual([]);
});

test("one message with two cards keeps its buttons until both are closed", async () => {
	off.mockClear();
	await out("chat", "[ask] 두 가지를 정해 주세요\n\n결정: sample 첫째\n**1) 예**\n해요\n**2) 아니요**\n안 해요\n\n결정: sample 둘째\n**1) 예**\n해요\n**2) 아니요**\n안 해요");
	const id = lastId();
	ignoreNotice(cardOf("sample 첫째")!.id);
	expect(off.mock.calls).toEqual([]);
	ignoreNotice(cardOf("sample 둘째")!.id);
	expect(off.mock.calls).toEqual([["chat", id]]);
});

test("a failed run's card goes to Discord once as its own notice, and its button answers it with no model turn", async () => {
	submit.mockClear();
	off.mockClear();
	const before = allNotices().length;
	const s = addSchedule({ name: "sample-9 점검", kind: "task", text: "sample-9 상태 보고해", in_minutes: 600, every_minutes: 1440 });
	runNow(s.id);
	sweepRuns(() => true, "web");
	sweepRuns(() => false, "web");
	await advance(FAIL_AFTER_MS);
	sweepRuns(() => false, "web");
	await Bun.sleep(0);
	const n = cardOf("sample-9 점검")!;
	expect(n.decision!.to).toStartWith("schedule:");
	// One notice for the run (its row became the card): the post made none beside it.
	expect(allNotices().length).toBe(before + 1);
	expect(submit.mock.calls).toHaveLength(1);
	const [target, text] = submit.mock.calls[0]!;
	expect(target).toBe("chat");
	expect(n.decision!.card).toMatchObject({ target: "chat", ids: [lastId()] });
	const labels = (askComponentsFor(target, text) as { components: { label?: string }[] }[]).flatMap(r => r.components.map(b => b.label));
	expect(labels.slice(0, 2)).toEqual(n.decision!.options.map(o => o.label));
	// 그만두기 pressed on Discord: the card closes as on the web, and its buttons turn off.
	const stop = n.decision!.options[1]!;
	const picks = discordPicks(target, "main", [{ q: n.title, n: stop.n, label: stop.label }], text);
	expect(await discordGatewayAnswer(target, "main", `${stop.n}) ${stop.label}`, picks)).toEqual({});
	expect(allNotices().find(x => x.id === n.id)!.decision!.state).toBe("answered");
	expect(off.mock.calls).toEqual([["chat", lastId()]]);
});
