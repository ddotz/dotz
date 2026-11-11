import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { emit } from "./events.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { makeRoute } from "./routes.ts";

// POST /api/message: what the composer sends is stored once, and nothing is stored for an empty message.
const env = setupEnv();
afterAll(env.cleanup);

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string, body?: object) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
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
		const r = await call("POST", "/api/message", { text: "이미 완료됨", decision: first.id, cid: "c-dec" });
		expect(r.status).toBe(200);
		expect(ds().map(n => [n.id === first.id, n.decision!.state, n.decision!.answer])).toEqual(expect.arrayContaining([[true, "answered", "이미 완료됨"], [false, "open", undefined]]));
		resetNoticesForTest();
	});
	test("a message of spaces only is refused and nothing is stored", async () => {
		const r = await call("POST", "/api/message", { text: "   " });
		expect(r.status).toBe(400);
		expect(typeof ((await r.json()) as { error?: string }).error).toBe("string");
		expect(await lines("   ")).toBe(0);
	});
});
