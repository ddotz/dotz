import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import type { MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";

// A JSON body that cannot be parsed is refused with 400 and a short Korean error; an empty body still works as before (hub/routes-util.ts body).
const env = setupEnv();
afterAll(env.cleanup);

// Only wired so the mail routes answer; a broken body is refused before they touch it.
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as MailDeps });
const call = (method: string, path: string, body?: string) => route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body }) }));

const ROUTES: Array<[string, string]> = [
	["POST", "/api/notices/read"],
	["PUT", "/api/api-budget"],
	["PUT", "/api/machine"],
];

// Routes that read the body inside their own try/catch, or swallow a failed read: they must still answer like every other route.
const OWN_CATCH: Array<[string, string]> = [
	["POST", "/api/mail/compose"],
	["POST", "/api/mail"],
	["POST", "/api/mail/fyi"],
	["POST", "/api/mail/actions"],
	["POST", "/api/mail/some-mail/action"],
	["POST", "/api/orchestrator/abort"],
];

describe("malformed JSON body", () => {
	for (const [method, path] of ROUTES)
		test(`${method} ${path} answers 400 with a Korean error`, async () => {
			const r = await call(method, path, "{not json");
			expect(r.status).toBe(400);
			const { error } = (await r.json()) as { error: string };
			expect(error).toMatch(/[가-힣]/);
		});

	for (const [method, path] of OWN_CATCH)
		test(`${method} ${path} answers like the route-level refusal`, async () => {
			const expected = await (await call("POST", "/api/notices/read", "{not json")).json();
			const r = await call(method, path, "{not json");
			expect(r.status).toBe(400);
			expect(await r.json()).toEqual(expected);
		});

	test("an empty body is still read as no fields", async () => {
		expect((await call("POST", "/api/notices/read")).status).toBe(200);
		expect((await call("POST", "/api/notices/read", "")).status).toBe(200);
		expect((await call("POST", "/api/notices/read", "{}")).status).toBe(200);
	});
});
