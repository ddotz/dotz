import { afterAll, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { runCommand, setGatewayRestart } from "./control.ts";
import type { MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";

const env = setupEnv();
afterAll(env.cleanup);

const asked: ({ auto?: boolean } | undefined)[] = [];
const route = makeRoute({ busyNow: () => [], restartGateway: o => (asked.push(o), "gateway restarting"), restartGatewayNow: () => "", mailDeps: () => ({}) as MailDeps });
const post = (body?: string) => route(new Request("http://hub.test/api/gateway/restart", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body }) }));

test("an agent's restart request may be deferred; one sent with now: true (a setup the owner waits on) never is", async () => {
	asked.length = 0;
	expect((await post()).status).toBe(200);
	expect((await post("{}")).status).toBe(200);
	expect((await post(JSON.stringify({ now: true }))).status).toBe(200);
	expect(asked).toEqual([{ auto: true }, { auto: true }, { auto: false }]);
});

test("the owner's /restart gateway asks for a restart that is never deferred", async () => {
	const owner: unknown[][] = [];
	setGatewayRestart((...a: unknown[]) => (owner.push(a), "gateway restarting"));
	await runCommand("/restart gateway");
	expect(owner).toEqual([[]]);
});
