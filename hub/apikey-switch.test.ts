import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE, HUB_TOKEN } from "./config.ts";
import { API_KEY_OFF, apiKeyBan } from "./apikey-policy.ts";
import type { MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";
import { routeSettings } from "./routes-settings.ts";

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as MailDeps });
const PATH = "/api/guard/allow-api-key";
const original = readFileSync(CONFIG_FILE, "utf8");
const disk = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { guard?: { allow_api_key?: unknown } };
const setAllow = (v: boolean) => {
	const c = JSON.parse(original);
	c.guard = { ...c.guard, allow_api_key: v };
	writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
};
const asAgent = (body: unknown) =>
	route(new Request(`http://hub.test${PATH}`, { method: "PUT", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));
const asOwner = async (method: string, body?: unknown) => {
	const url = new URL(`http://hub.test${PATH}`);
	return (await routeSettings(new Request(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean)))!;
};

beforeEach(() => setAllow(false));
afterAll(() => writeFileSync(CONFIG_FILE, original));

describe("N9: the API-key master switch is the owner's alone", () => {
	test("an agent with the hub token is refused (403) and guard.allow_api_key stays false", async () => {
		const r = await asAgent({ allow: true, confirm: true });
		expect(r.status).toBe(403);
		expect(disk().guard?.allow_api_key).toBe(false);
		expect(apiKeyBan()).toBe(API_KEY_OFF);
	});
	test("an agent cannot turn it off either", async () => {
		setAllow(true);
		const r = await asAgent({ allow: false });
		expect(r.status).toBe(403);
		expect(disk().guard?.allow_api_key).toBe(true);
	});
	test("the owner's enable without confirm: true is refused and keys stay off", async () => {
		const r = await asOwner("PUT", { allow: true });
		expect(r.status).toBe(400);
		expect((await r.json()).confirm_required).toBe(true);
		expect(disk().guard?.allow_api_key).toBe(false);
	});
	test("the owner's confirmed enable is written and lifts the API_KEY_OFF ban; GET reads it back", async () => {
		const r = await asOwner("PUT", { allow: true, confirm: true });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ allow: true });
		expect(disk().guard?.allow_api_key).toBe(true);
		expect(apiKeyBan()).not.toBe(API_KEY_OFF);
		expect(await (await asOwner("GET")).json()).toEqual({ allow: true });
	});
	test("the owner turns it off without a confirm, and the other config keys stay", async () => {
		setAllow(true);
		const before = disk() as Record<string, unknown>;
		const r = await asOwner("PUT", { allow: false });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ allow: false });
		expect(disk()).toEqual({ ...before, guard: { ...(before.guard as object), allow_api_key: false } });
		expect(apiKeyBan()).toBe(API_KEY_OFF);
	});
	test("a body without a boolean allow is refused and nothing changes", async () => {
		const r = await asOwner("PUT", { allow: "yes", confirm: true });
		expect(r.status).toBe(400);
		expect(disk().guard?.allow_api_key).toBe(false);
	});
});
