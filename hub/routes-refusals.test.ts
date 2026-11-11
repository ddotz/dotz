import { afterAll, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { msg } from "./i18n.ts";
import { makeRoute } from "./routes.ts";

// What the web shows as it comes (web/js/01-notice-ko.js turns any English text into one generic line) is the catalog entry of the install language.
const env = setupEnv();
afterAll(env.cleanup);
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = async (method: string, path: string) => {
	const res = (await route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })))!;
	return { status: res.status, error: ((await res.json()) as { error: string }).error };
};

test("cancelling or sending a queued message that is already gone is a 404 with the catalog text", async () => {
	expect(await call("DELETE", "/api/queue/gone")).toEqual({ status: 404, error: msg().refuse.queueGone });
	expect(await call("POST", "/api/queue/gone/send")).toEqual({ status: 404, error: msg().refuse.queueGone });
});

test("an unknown or finished subagent is a 404 with the catalog text", async () => {
	expect(await call("GET", "/api/subagents/gone")).toEqual({ status: 404, error: msg().refuse.subagentGone });
});

test("mail routes in a process without mail answer 503 with the catalog text", async () => {
	for (const path of ["/api/mail/compose", "/api/mail/reconcile", "/api/mail"]) expect(await call("POST", path)).toEqual({ status: 503, error: msg().refuse.mailNotReady });
});
