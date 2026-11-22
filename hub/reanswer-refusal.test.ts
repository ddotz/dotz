// An owner message answers once (owner 11-18: "아까 와야하는 메시지가 누락되서 오네"): a 08:52 request answered at 09:17 got a second
// dotz_send reply_to it at 10:47, which he read as a lost answer arriving late. The real /api/send refuses a reply to an answered message.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { cfg, HUB_TOKEN } from "./config.ts";
import { queue } from "./outbound.ts";
import { makeRoute } from "./routes.ts";

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const dotzSend = async (text: string, reply_to?: string) =>
	(await route(new Request("http://127.0.0.1/api/send", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: JSON.stringify({ target: "web", text, session: "main", ...(reply_to ? { reply_to } : {}) }) }))).json() as Promise<{ delivered?: boolean; reason?: string }>;
const ownerTurn = (id: string) => {
	queue.deliver(`owner message ${id}`, { target: "web", replyTo: id, owner: true });
	queue.onPrompt(`owner message ${id}`);
};
const saved = Reflect.get(cfg, "output_language");

beforeAll(() => {
	Reflect.set(cfg, "output_language", "off");
	process.env.DOTZ_NO_ORCHESTRATOR = "1";
});
afterAll(() => {
	Reflect.set(cfg, "output_language", saved);
	delete process.env.DOTZ_NO_ORCHESTRATOR;
});
beforeEach(() => queue.settleTurn());

test("a later turn's dotz_send replying to a message already answered is refused, and its own request's answer still goes", async () => {
	queue.markAnswered("old11111");
	ownerTurn("new22222");
	const again = await dotzSend("알림 문제를 고쳐서 설치본에도 받아 뒀어요.", "old11111");
	expect(again.delivered).toBe(false);
	expect(again.reason).toContain("already answered");
	expect((await dotzSend("하네스 세션은 지금 형 답을 기다려요.", "new22222")).delivered).toBe(true);
});

test("news about an answered matter goes out as a new message", async () => {
	queue.markAnswered("old33333");
	ownerTurn("new44444");
	expect((await dotzSend("알림 수정이 설치본에 반영됐어요.")).delivered).toBe(true);
});
