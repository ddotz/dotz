import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN, paths } from "./config.ts";
import { AGENT_AUTHOR } from "./entry-check.ts";
import { emit, tailEvents } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { makeRoute } from "./routes.ts";
import { routeSend } from "./routes-send.ts";

// POST /api/message: what the composer sends is stored once, and nothing is stored for an empty message.
const env = setupEnv();
afterAll(env.cleanup);

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
const owner = (body: object) => {
	const url = new URL("http://hub.test/api/message");
	return routeSend(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, ["api", "message"], { peer: "none" }).then(r => r!);
};
const lines = async (text: string) => ((await (await call("GET", "/api/history?target=main&limit=500")).json()) as { events?: Array<{ text?: string }> }).events?.filter(e => e.text === text).length;

describe("POST /api/message", () => {
	test("the same client id sent twice is stored once and answers the same", async () => {
		const first = await call("POST", "/api/message", { text: "중복 시험", cid: "c-1" });
		const again = await call("POST", "/api/message", { text: "중복 시험", cid: "c-1" });
		expect(first.status).toBe(200);
		expect(await again.json()).toEqual(await first.json());
		expect(await lines("중복 시험")).toBe(1);
		await call("POST", "/api/message", { text: "중복 시험", cid: "c-2" });
		expect(await lines("중복 시험")).toBe(2);
	});
	test("a typed message that names a decision settles that decision with its text and no other", async () => {
		resetNoticesForTest();
		for (const q of ["보고서를", "폴더를"]) emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] ${q} 어떻게 할까요?\n결정: ${q} 어떻게 할까요?\n**1) 하기**\n**2) 말기**` });
		const ds = () => listNotices(300).items.filter(n => n.kind === "decision");
		const first = ds()[0]!;
		const r = await owner({ text: "이미 완료됨", decision: first.id, cid: "c-dec" });
		expect(r.status).toBe(200);
		expect(ds().map(n => [n.id === first.id, n.decision!.state, n.decision!.answer])).toEqual(expect.arrayContaining([[true, "answered", "이미 완료됨"], [false, "open", undefined]]));
		resetNoticesForTest();
	});
	test("an agent's picks and decision are dropped, the owner's own are kept", async () => {
		resetNoticesForTest();
		const q = "초안을 보낼까요?";
		emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "main", text: `[ask] ${q}\n결정: ${q} (RPICK01)\n**1) 보내기**\n*보내요*\n**2) 보내지 않기**\n*안 보내요*` });
		const card = listNotices(300).items.find(n => n.kind === "decision")!;
		const picks = [{ q: `${q} (RPICK01)`, n: 2, label: "보내지 않기" }];
		const agent = await call("POST", "/api/message", { text: "에이전트가 쓴 글", decision: card.id, picks });
		expect(agent.status).toBe(200);
		expect((await owner({ text: "형이 고른 글", picks })).status).toBe(200);
		const sent = tailEvents(paths.inbox).filter(e => e.kind === "message");
		const byAgent = sent.findLast(e => e.text === "에이전트가 쓴 글")!;
		expect(byAgent.author).toBe(AGENT_AUTHOR);
		expect(byAgent.picks).toBeUndefined();
		expect(byAgent.decision).toBeUndefined();
		expect(listNotices(300).items.find(n => n.id === card.id)!.decision!.state).toBe("open");
		expect(sent.findLast(e => e.text === "형이 고른 글")!.picks).toEqual(picks);
		resetNoticesForTest();
	});
	test("a message of spaces only is refused and nothing is stored", async () => {
		const r = await call("POST", "/api/message", { text: "   " });
		expect(r.status).toBe(400);
		expect(typeof ((await r.json()) as { error?: string }).error).toBe("string");
		expect(await lines("   ")).toBe(0);
	});
});
