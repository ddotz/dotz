// Login keeper for a Google app in testing mode: the refresh token is renewed through the Aside consent flow on day 6, never for a
// production app, and two failed renewals in a row become a failing check. The flow itself runs against a fake loopback and a
// fake page. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { run } from "../bin/tokens.ts";
import { paths, readJson, writeJson, type YoutubeOauth } from "../lib/config.ts";
import { reconsentDue, reconsentViaAside } from "../lib/reconsent.ts";
import { CHANNEL, fakeCtx, NOW, readState, setupEnv, type TestEnv, TOKEN_URL, YT } from "./helpers.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();
const grant = (o: Partial<YoutubeOauth>) => writeJson(paths.ytOauth(), { client_id: "cid", client_secret: "csecret", refresh_token: "rtok", ...o }, true);
const testing = (days: number): Partial<YoutubeOauth> => ({ obtained_at: ago(days), refresh_expires_at: new Date(Date.parse(ago(days)) + 7 * DAY).toISOString() });

let env: TestEnv;
beforeEach(() => {
	env = setupEnv(c => {
		delete c.instagram;
	});
});
afterEach(() => env.cleanup());

function counter(result: boolean) {
	const c = { calls: 0, fn: async () => (c.calls++, result) };
	return c;
}

test("a testing-mode token is renewed from day 6 on, not before", async () => {
	for (const [days, due] of [[5, false], [6, true], [6.9, true]] as const) {
		grant(testing(days));
		const r = counter(true);
		expect((await run(fakeCtx(env), ["login"], r.fn)).code).toBe(0);
		expect(r.calls).toBe(due ? 1 : 0);
	}
});

test("a production app is never renewed, whatever the token age", async () => {
	grant({ obtained_at: ago(30) });
	const none = counter(true);
	await run(fakeCtx(env), ["login"], none.fn);
	env.cleanup();
	env = setupEnv(c => {
		delete c.instagram;
		c.youtube!.oauth_mode = "production";
	});
	grant(testing(6));
	const explicit = counter(true);
	await run(fakeCtx(env), ["login"], explicit.fn);
	expect([none.calls, explicit.calls]).toEqual([0, 0]);
});

test("the config flag marks a testing app whose token carries no expiry, and the file age stands in for a missing grant time", async () => {
	env.cleanup();
	env = setupEnv(c => {
		delete c.instagram;
		c.youtube!.oauth_mode = "testing";
	});
	grant({ obtained_at: ago(6) });
	expect(reconsentDue(fakeCtx(env), (readJson(paths.config()) as any))).toBe(true);
	const touch = (days: number) => utimesSync(paths.ytOauth(), new Date(ago(days)), new Date(ago(days)));
	grant({});
	touch(1);
	expect(reconsentDue(fakeCtx(env), (readJson(paths.config()) as any))).toBe(false);
	touch(6);
	expect(reconsentDue(fakeCtx(env), (readJson(paths.config()) as any))).toBe(true);
});

test("two failed renewals in a row fail the check with a Korean notice; a success clears the count", async () => {
	grant(testing(6));
	const bad = counter(false);
	const first = await run(fakeCtx(env), ["login"], bad.fn);
	expect(first).toEqual({ lines: [], code: 0 });
	expect(readState(env).data).toEqual({ reconsent_fails: 1 });
	const second = await run(fakeCtx(env), ["login"], bad.fn);
	expect(second.code).toBe(1);
	expect(second.lines[0]).toBe("DOTZ_FAIL auth");
	expect(second.lines[1]).toContain("6일째");
	expect(readState(env).data).toEqual({ reconsent_fails: 2 });
	const good = counter(true);
	expect((await run(fakeCtx(env), ["login"], good.fn)).code).toBe(0);
	expect(readState(env).data).toEqual({ reconsent_fails: 0 });
});

test("a refresh token that is already dead is renewed too, in testing mode only", async () => {
	grant(testing(3));
	const dead = (ctx: ReturnType<typeof fakeCtx>) => {
		writeJson(paths.ytAccess(), { access_token: "old", expires_at: "2000-01-01T00:00:00.000Z" }, true);
		ctx.routes[`POST ${TOKEN_URL}`] = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
		return ctx;
	};
	const r = counter(true);
	expect((await run(dead(fakeCtx(env)), ["login"], r.fn)).code).toBe(0);
	expect(r.calls).toBe(1);
	grant({ obtained_at: ago(3) });
	const p = counter(true);
	const res = await run(dead(fakeCtx(env)), ["login"], p.fn);
	expect(res.lines[0]).toBe("DOTZ_FAIL youtube-auth");
	expect(p.calls).toBe(0);
});

function flow(ctx: ReturnType<typeof fakeCtx>, page: { state: string }) {
	let resolve!: (q: URLSearchParams) => void;
	const redirect = new Promise<URLSearchParams>(r => (resolve = r));
	const urls: string[] = [];
	const aside = {
		repl: async (body: string) => {
			const url = /openTab\("([^"]+accounts\.google\.com[^"]+)"\)/.exec(body)![1]!;
			urls.push(url);
			if (page.state === "ok") resolve(new URLSearchParams({ code: "CODE1", state: new URL(url).searchParams.get("state")! }));
			return page;
		},
	};
	ctx.routes[`POST ${TOKEN_URL}`] = call => (call.body.includes("authorization_code") ? { refresh_token: "NEW-RT", refresh_token_expires_in: 604800, access_token: "a1", expires_in: 3600 } : { access_token: "a2", expires_in: 3600 });
	ctx.routes[`GET ${YT}/channels`] = () => ({ items: [{ id: CHANNEL, snippet: { title: "Channel" } }] });
	return { aside, urls, loopback: () => ({ port: 4242, redirect, close: () => {} }) };
}

test("the renewal opens the consent page in a background tab, exchanges the code and stores the new token with its dates", async () => {
	grant(testing(6));
	const ctx = fakeCtx(env);
	const f = flow(ctx, { state: "ok" });
	expect(await reconsentViaAside(ctx, f.aside, { loopback: f.loopback, waitMs: 1000 })).toBe(true);
	expect(f.urls).toHaveLength(1);
	expect(new URL(f.urls[0]!).searchParams.get("prompt")).toBe("consent");
	expect(readJson<YoutubeOauth>(paths.ytOauth())).toMatchObject({ client_id: "cid", client_secret: "csecret", refresh_token: "NEW-RT", obtained_at: NOW, refresh_expires_at: new Date(Date.parse(NOW) + 7 * DAY).toISOString() });
});

test("a login page in the consent flow fails the renewal at once and keeps the old token", async () => {
	grant(testing(6));
	const ctx = fakeCtx(env);
	const f = flow(ctx, { state: "owner" });
	expect(await reconsentViaAside(ctx, f.aside, { loopback: f.loopback, waitMs: 60_000 })).toBe(false);
	expect(readJson<YoutubeOauth>(paths.ytOauth())?.refresh_token).toBe("rtok");
});
