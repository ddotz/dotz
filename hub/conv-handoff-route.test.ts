import { afterAll, expect, test } from "bun:test";
import { HUB_TOKEN } from "./config.ts";
import { convs } from "./convsessions.ts";
import "./outbound.ts";
import { MAIN } from "./session-key.ts";
import { makeRoute } from "./routes.ts";

// dotz_conv send from main through the real route (hub/routes.ts): the label the handed prompt carries decides where the session's final
// answer goes (hub/prompts.ts). Without back it is posted in the conversation; back: true hands it back to main.
// The sessions only hold the prompt (no omo process starts).
process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => delete process.env.DOTZ_NO_ORCHESTRATOR);
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as never });
const send = (key: string, body: object) => route(new Request(`http://hub.test/api/conv-sessions/${encodeURIComponent(key)}/send`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));
const last = (key: string) => convs.get(key)!.queue.queued().at(-1)!;

test("send from main without back: the prompt is the conversation's own, answered in its primary target", async () => {
	convs.ensure("ch:77");
	const r = await send("ch:77", { text: "이거 확인해 줘" });
	expect(await r.json()).toEqual({ ok: true, to: "ch:77", answers_in: "ch:77" });
	expect(last("ch:77")).toMatchObject({ text: "[main session] 이거 확인해 줘", target: "ch:77" });
	expect(last("ch:77")).not.toHaveProperty("from");
});

test("send from main with back: true: the prompt is marked as main's work, so its answer goes back to main", async () => {
	convs.ensure("ch:78");
	const r = await send("ch:78", { text: "결과는 나한테", back: true });
	expect(await r.json()).toEqual({ ok: true, to: "ch:78", answers_in: MAIN });
	expect(last("ch:78")).toMatchObject({ text: "[main session] 결과는 나한테", target: "ch:78", from: MAIN });
});
