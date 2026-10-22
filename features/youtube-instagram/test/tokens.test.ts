// tokens watch: silent while both logins are fine; refreshes the Instagram token by the 7-day / 20-day rule and the YouTube
// access token when the cache ran out; rejected logins become DOTZ_FAIL lines. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { run } from "../bin/tokens.ts";
import { type InstagramSecret, paths, writeJson } from "../lib/config.ts";
import { fakeCtx, IG, setupEnv, type TestEnv, TOKEN_URL } from "./helpers.ts";

const REFRESH = `GET https://graph.instagram.com/refresh_access_token`;
const TOKEN = `POST ${TOKEN_URL}`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const igSecret = (obtained: string, expires: string): InstagramSecret => ({ access_token: "ig-token", user_id: "17841", username: "owner_ig", obtained_at: obtained, expires_at: expires });
const mode = (file: string) => statSync(file).mode & 0o777;

test("silent and call-free while both tokens are fine", async () => {
	const ctx = fakeCtx(env);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
});

test("an Instagram token older than 7 days is refreshed and stored 0600", async () => {
	writeJson(paths.instagram(), igSecret("2030-06-01T00:00:00.000Z", "2030-07-31T00:00:00.000Z"), true);
	const ctx = fakeCtx(env, { routes: { [REFRESH]: () => ({ access_token: "ig-new", expires_in: 5184000 }) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(1);
	const q = new URL(ctx.calls[0].url).searchParams;
	expect(q.get("grant_type")).toBe("ig_refresh_token");
	expect(q.get("access_token")).toBe("ig-token");
	expect(ctx.calls[0].headers.authorization).toBeUndefined();
	const stored = JSON.parse(readFileSync(paths.instagram(), "utf8")) as InstagramSecret;
	expect(stored.access_token).toBe("ig-new");
	expect(stored.obtained_at).toBe("2030-06-15T12:00:00.000Z");
	expect(stored.expires_at).toBe("2030-08-14T12:00:00.000Z");
	expect(mode(paths.instagram())).toBe(0o600);
});

test("a token expiring within 20 days is refreshed, but not before it is 24 hours old", async () => {
	const ctx = fakeCtx(env, { routes: { [REFRESH]: () => ({ access_token: "ig-new", expires_in: 5184000 }) } });
	writeJson(paths.instagram(), igSecret("2030-06-13T00:00:00.000Z", "2030-06-25T00:00:00.000Z"), true);
	await run(ctx, []);
	expect(ctx.calls).toHaveLength(1);
	writeJson(paths.instagram(), igSecret("2030-06-15T06:00:00.000Z", "2030-06-25T00:00:00.000Z"), true);
	await run(ctx, []);
	expect(ctx.calls).toHaveLength(1);
});

test("an expired YouTube access token is refreshed with the refresh token in the body, cached 0600 and reused", async () => {
	rmSync(paths.ytAccess());
	const ctx = fakeCtx(env, { routes: { [TOKEN]: () => ({ access_token: "yt-new", expires_in: 3600 }) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls[0].url).toBe(TOKEN_URL);
	const body = new URLSearchParams(ctx.calls[0].body);
	expect(body.get("grant_type")).toBe("refresh_token");
	expect(body.get("refresh_token")).toBe("rtok");
	expect(JSON.parse(readFileSync(paths.ytAccess(), "utf8")).access_token).toBe("yt-new");
	expect(mode(paths.ytAccess())).toBe(0o600);
	await run(ctx, []);
	expect(ctx.calls).toHaveLength(1);
});

test("invalid_grant prints DOTZ_FAIL youtube-auth, a 401 from Instagram prints instagram-auth", async () => {
	rmSync(paths.ytAccess());
	const yt = await run(fakeCtx(env, { routes: { [TOKEN]: () => Response.json({ error: "invalid_grant" }, { status: 400 }) } }), []);
	expect(yt.code).toBe(1);
	expect(yt.lines[0]).toBe("DOTZ_FAIL youtube-auth");
	env.cleanup();
	env = setupEnv();
	writeJson(paths.instagram(), igSecret("2030-06-01T00:00:00.000Z", "2030-07-31T00:00:00.000Z"), true);
	const ig = await run(fakeCtx(env, { routes: { [REFRESH]: () => new Response("{}", { status: 401 }) } }), []);
	expect(ig.lines[0]).toBe("DOTZ_FAIL instagram-auth");
});

test("a transient failure is absorbed twice and reported on the 3rd failed run", async () => {
	writeJson(paths.instagram(), igSecret("2030-06-01T00:00:00.000Z", "2030-07-31T00:00:00.000Z"), true);
	const ctx = fakeCtx(env, { routes: { [REFRESH]: () => new Response("{}", { status: 503 }) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect((await run(ctx, [])).lines[0]).toBe("DOTZ_FAIL network");
});

test("missing config prints DOTZ_FAIL setup", async () => {
	rmSync(paths.config());
	expect((await run(fakeCtx(env), [])).lines[0]).toBe("DOTZ_FAIL setup");
	expect(IG).toContain("graph.instagram.com");
});
