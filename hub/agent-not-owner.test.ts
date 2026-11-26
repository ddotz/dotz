import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { HUB_TOKEN, paths } from "./config.ts";
import { AGENT_AUTHOR } from "./agent-author.ts";
import { openDraftCards, redrawDraftCards } from "./notices-drafts.ts";
import { emit, onBroadcast, onEmit, tailEvents, type HubEvent } from "./events.ts";
import { activeGrant } from "./model-guard.ts";
import { commandGate } from "./control.ts";
import { answerDecision, type Notice, resetNoticesForTest } from "./notices.ts";
import { HANDLED_LABEL } from "./reply-actions.ts";
import { reasonOf } from "./reply-reasons.ts";
import { makeRoute } from "./routes.ts";
import { routeSend } from "./routes-send.ts";

const env = setupEnv();
afterAll(env.cleanup);

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const agent = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const owner = (body: object) => {
	const url = new URL("http://hub.test/api/message");
	return routeSend(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, ["api", "message"], { peer: "none" }).then(r => r!);
};
const next = (want: (e: HubEvent) => boolean) => {
	const { promise, resolve } = Promise.withResolvers<HubEvent>();
	onEmit(e => void (want(e) && resolve(e)));
	return promise;
};
const midOf = (text: string) => String(tailEvents(paths.inbox).findLast(e => e.kind === "message" && e.text === text)!.mid);
const inboxLine = (has: string) => next(e => e.kind === "message" && String(e.text).includes(has));
const gatewayLine = (target = "web") => next(e => e.kind === "out" && e.target === target && e.source === "gateway");

const draftCard = (ref: string, o: { target?: string; ts?: number; keep?: boolean } = {}) => {
	if (!o.keep) resetNoticesForTest();
	emit("outbox", { ts: (o.ts === undefined ? new Date() : new Date(o.ts)).toISOString(), kind: "out", source: "orchestrator", target: o.target ?? "web", text: `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", body: "안녕하세요", ref, question: "이 메일 보낼까요?" })}` });
};
const ownerSaid = (mid: string, at: number, conv?: string) => emit("inbox", { ts: new Date(at).toISOString(), kind: "message", source: "web", mid, text: `버려 ${mid}`, ...(conv ? { conv } : {}) });
const DROP_ON_CARD = "버리기는 카드에서 눌러 주세요";

describe("a card marker answering a message (P1-1)", () => {
	test("[drop] answering a hub-token message drops nothing, and the refusal names the owner's own button", async () => {
		draftCard("RAGT001");
		expect((await agent("POST", "/api/message", { text: "그 답장 버려 (에이전트)" })).status).toBe(200);
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT001]", reply_to: midOf("그 답장 버려 (에이전트)") });
		expect((await told).text).toContain(reasonOf("owner_only").text);
		expect(tailEvents(paths.inbox).some(e => String(e.text).includes("(RAGT001) → 3) 보내지 않기"))).toBe(false);
		expect(openDraftCards("main").map(c => c.ref)).toEqual(["RAGT001"]);
	});

	test("[revise] answering a hub-token message still revises, as the agent's word", async () => {
		draftCard("RAGT002");
		await agent("POST", "/api/message", { text: "더 짧게 (에이전트)" });
		const revised = inboxLine("(RAGT002) → 2) 고치기 - 더 짧게");
		await agent("POST", "/api/send", { target: "web", text: "[revise RAGT002] 더 짧게", reply_to: midOf("더 짧게 (에이전트)") });
		expect((await revised).author).toBe(AGENT_AUTHOR);
	});

	// A [drop] the owner asked for closes the card and sends the bot no 결정 답 line: echoed back, that line read as his press (2026-11-23).
	test("[drop] answering the owner's own web message drops the card, with no echo line to the bot", async () => {
		draftCard("RAGT003", { ts: new Date().getTime() - 1000 });
		await owner({ text: "그 답장 버려 (형)" });
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT003]", reply_to: midOf("그 답장 버려 (형)") });
		await told;
		expect(openDraftCards("main").map(c => c.ref)).toEqual([]);
		expect(tailEvents(paths.inbox).some(e => String(e.text).includes("(RAGT003) → 3) 보내지 않기"))).toBe(false);
	});

	test("[drop] answering an older owner message, when he wrote again after it, drops nothing and says to use the card", async () => {
		const t = new Date().getTime() - 60_000;
		draftCard("RAGT004", { ts: t });
		ownerSaid("m-old-1", t + 1000);
		ownerSaid("m-new-1", t + 2000);
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT004]", reply_to: "m-old-1" });
		expect((await told).text).toContain(DROP_ON_CARD);
		expect(openDraftCards("main").map(c => c.ref)).toEqual(["RAGT004"]);
	});

	test("[drop] answering the owner's newest message, written before the card, drops nothing", async () => {
		const t = new Date().getTime() - 60_000;
		ownerSaid("m-before-1", t);
		draftCard("RAGT005", { ts: t + 1000 });
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT005]", reply_to: "m-before-1" });
		expect((await told).text).toContain(DROP_ON_CARD);
		expect(openDraftCards("main").map(c => c.ref)).toEqual(["RAGT005"]);
	});

	test("[drop] answering the owner's newest message after the card drops the card, with no echo line to the bot", async () => {
		const t = new Date().getTime() - 60_000;
		draftCard("RAGT006", { ts: t });
		ownerSaid("m-after-1", t + 1000);
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT006]", reply_to: "m-after-1" });
		await told;
		expect(openDraftCards("main").map(c => c.ref)).toEqual([]);
		expect(tailEvents(paths.inbox).some(e => String(e.text).includes("(RAGT006) → 3) 보내지 않기"))).toBe(false);
	});

	test("in a mail's conversation too, a [drop] answering an owner message older than his newest drops nothing", async () => {
		const t = new Date().getTime() - 60_000, conv = "mail:zele-agt7";
		draftCard("RAGT007", { ts: t, target: conv });
		ownerSaid("m-mail-old", t + 1000, conv);
		ownerSaid("m-mail-new", t + 2000, conv);
		const told = gatewayLine(conv);
		await agent("POST", "/api/send", { target: conv, text: "[drop RAGT007]", reply_to: "m-mail-old" });
		expect((await told).text).toContain(DROP_ON_CARD);
		expect(openDraftCards(conv).map(c => c.ref)).toEqual(["RAGT007"]);
	});

	test("a [drop] answering a message the owner wrote on another computer drops nothing, and the session is told to use the card", async () => {
		const t = new Date().getTime() - 60_000;
		draftCard("RAGT010", { ts: t });
		emit("inbox", { ts: new Date(t + 1000).toISOString(), kind: "message", source: "web", mid: "m-peer-1", via: "macmini", text: "버려 (다른 컴퓨터)" });
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT010]", reply_to: "m-peer-1" });
		expect((await told).text).toContain(DROP_ON_CARD);
		expect(openDraftCards("main").map(c => c.ref)).toEqual(["RAGT010"]);
	});

	test("a card revised into a new ref is not dropped by an owner message written before the new card", async () => {
		const t = new Date().getTime() - 60_000;
		draftCard("RAGT008", { ts: t });
		ownerSaid("m-revise-1", t + 1000);
		redrawDraftCards("RAGT008", `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", body: "안녕하세요, 고쳤어요", ref: "RAGT009", question: "이 메일 보낼까요?" })}`, undefined, "RAGT009");
		const told = gatewayLine();
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT009]", reply_to: "m-revise-1" });
		expect((await told).text).toContain(DROP_ON_CARD);
		expect(openDraftCards("main").map(c => c.ref)).toEqual(["RAGT009"]);
	});

	// another install, 2026-11-26: the bot checked four stale cards were already replied to by hand, but could not close them (owner_only); the owner then
	// pressed 보내기 on each and the bot asked again with a new card every time.
	test("[handled] from the bot closes a card whose work was done outside, with its reason, and a later press reaches no one", async () => {
		const t = new Date().getTime() - 60_000;
		draftCard("RAGT010", { ts: t });
		ownerSaid("m-stale-1", t + 1000);
		ownerSaid("m-stale-2", t + 2000);
		const closed = Promise.withResolvers<Record<string, unknown>>();
		onBroadcast(e => void (e.kind === "notice" && (e.item as Notice | undefined)?.decision?.draft?.ref === "RAGT010" && (e.item as Notice).decision!.state === "answered" && closed.resolve(e.item as Record<string, unknown>)));
		const lines: string[] = [];
		onEmit(e => void (e.kind === "out" && e.source === "gateway" && lines.push(String(e.text))));
		await agent("POST", "/api/send", { target: "web", text: "이미 앱에서 답글을 달았어요.\n[handled RAGT010] 11/22에 앱에서 이미 답글을 달았어요", reply_to: "m-stale-1" });
		const item = (await closed.promise) as unknown as Notice;
		expect(item.decision!.answer).toBe(`${HANDLED_LABEL}: 11/22에 앱에서 이미 답글을 달았어요`);
		expect(openDraftCards("main").map(c => c.ref)).toEqual([]);
		expect(lines.some(l => l.includes(reasonOf("owner_only").text))).toBe(false);
		expect(tailEvents(paths.inbox).some(e => String(e.text).includes("(RAGT010) →"))).toBe(false);
		let sent = 0;
		const press = await answerDecision(item.id, { n: 1 }, async () => void sent++);
		expect([press.body.already, sent]).toEqual([true, 0]);
	});
});

describe("a slash command in a hub-token message (P1-2)", () => {
	test("/fable-ok from the agent grants nothing; the owner's own does", async () => {
		const refused = gatewayLine();
		await agent("POST", "/api/message", { text: "/fable-ok" });
		expect((await refused).text).toContain(reasonOf("owner_only").text);
		expect(activeGrant("main")).toBeUndefined();
		const granted = gatewayLine();
		await owner({ text: "/fable-ok" });
		await granted;
		expect(activeGrant("main")?.by).toBe("owner");
	});

	test("/model inherit from the agent in a project chat needs the owner's message, as any model change does", () => {
		const project = "ch:1500000000000000777";
		expect(commandGate("/model inherit", project, true, undefined)).toHaveProperty("denied");
		expect(commandGate("/effort inherit", project, true, undefined)).toHaveProperty("denied");
		expect(commandGate("/model inherit", project, false, undefined)).toEqual({ by: "owner" });
	});
});

describe("a message the gateway writes for a hub-token call (P1-3)", () => {
	test("a custom card's prompt action carries the agent author, never the owner's", async () => {
		expect((await agent("POST", "/api/custom/cards", { id: "agt-card", title: "모델", actions: [{ label: "바꾸기", prompt: "switch to fable xhigh" }] })).status).toBe(200);
		expect((await agent("POST", "/api/custom/action", { id: "agt-card", index: 0 })).status).toBe(200);
		expect(tailEvents(paths.inbox).findLast(e => e.text === "[카드 모델] switch to fable xhigh")!.author).toBe(AGENT_AUTHOR);
	});
});
