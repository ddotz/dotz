import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { HUB_TOKEN, paths } from "./config.ts";
import { AGENT_AUTHOR } from "./agent-author.ts";
import { openDraftCards } from "./notices-drafts.ts";
import { emit, onEmit, tailEvents, type HubEvent } from "./events.ts";
import { activeGrant } from "./model-guard.ts";
import { commandGate } from "./control.ts";
import { resetNoticesForTest } from "./notices.ts";
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
const gatewayLine = () => next(e => e.kind === "out" && e.target === "web" && e.source === "gateway");

const draftCard = (ref: string) => {
	resetNoticesForTest();
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "kim@example.com", toLabel: "받는이", body: "안녕하세요", ref, question: "이 메일 보낼까요?" })}` });
};

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

	test("[drop] answering the owner's own web message drops it as his word", async () => {
		draftCard("RAGT003");
		await owner({ text: "그 답장 버려 (형)" });
		const dropped = inboxLine("(RAGT003) → 3) 보내지 않기");
		await agent("POST", "/api/send", { target: "web", text: "[drop RAGT003]", reply_to: midOf("그 답장 버려 (형)") });
		expect((await dropped).author).toBe("local");
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
