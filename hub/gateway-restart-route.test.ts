import { afterAll, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { runCommand, setGatewayRestart } from "./control.ts";
import { ownerForward } from "./entry-check.ts";
import type { MailDeps } from "./mail.ts";
import { createRestartGate } from "./restart.ts";
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

test("settings → 업데이트 → 재시작: the owner's call is logged with him as the requester, an agent's own call with the same token is not", async () => {
	const lines: string[] = [];
	const gate = createRestartGate({ busy: () => ["orchestrator"], collecting: () => false, startedAt: Date.now() - 3600e3, minGapMs: 5 * 60e3, noticeAfterMs: 20 * 60e3, notice: () => undefined, log: text => void lines.push(text), exit: () => undefined });
	const settings = makeRoute({ busyNow: () => [], restartGateway: o => gate.request(o), restartGatewayNow: () => "", mailDeps: () => ({}) as MailDeps });
	const call = () => new Request("http://hub.test/api/update/restart", { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: "{}" });
	expect((await settings(call())).status).toBe(200);
	expect((await settings(ownerForward(call()))).status).toBe(200);
	expect(lines).toEqual(["gateway restart requested; waiting for: orchestrator", "gateway restart requested by owner; joins the waiting one"]);
});
