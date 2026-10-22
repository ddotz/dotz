// ig-comments watch: baseline of comment counts on the first run, comments fetched only for media whose count changed,
// owner comments and replied ones skipped, failure absorption, auth, quiet hours and setup failures. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/ig-comments.ts";
import { paths, writeJson } from "../lib/config.ts";
import { calls, fakeCtx, IG, readState, setupEnv, type TestEnv } from "./helpers.ts";

const MEDIA = `GET ${IG}/me/media`;
const COMMENTS = `GET ${IG}/m1/comments`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const media = (count: number) => ({ data: [{ id: "m1", comments_count: count, timestamp: "2030-06-01T00:00:00+0000" }, { id: "m2", comments_count: 0, timestamp: "2030-06-02T00:00:00+0000" }] });
const comment = (id: string, username: string, at: string, text = "hello", replyBy?: string) => ({ id, text, username, timestamp: at, replies: replyBy ? { data: [{ username: replyBy, text: "ok" }] } : undefined });

test("first run records counts and the time, fetches no comments, prints nothing", async () => {
	const ctx = fakeCtx(env, { routes: { [MEDIA]: () => media(1) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(1);
	expect(ctx.calls[0].headers.authorization).toBe("Bearer ig-token");
	expect(ctx.calls[0].url).not.toContain("ig-token");
	expect(readState(env).data.counts).toEqual({ m1: 1, m2: 0 });
});

test("second run reads only changed media and prints new comments without an owner reply, once", async () => {
	const ctx = fakeCtx(env, { routes: { [MEDIA]: () => media(1) } });
	await run(ctx, []);
	ctx.routes[MEDIA] = () => media(5);
	ctx.routes[COMMENTS] = () => ({
		data: [
			comment("k1", "fan0", "2030-06-15T11:00:00+0000", "old"),
			comment("k2", "fan1", "2030-06-15T12:10:00+0000", "first!"),
			comment("k3", "OWNER_IG", "2030-06-15T12:20:00+0000", "mine"),
			comment("k4", "fan2", "2030-06-15T12:30:00+0000", "answered", "owner_ig"),
			comment("k5", "fan3", "2030-06-15T12:40:00+0000", "multi\nline"),
		],
	});
	expect(await run(ctx, [])).toEqual({ lines: ["ig-comment k2 media=m1 by=fan1: first!", "ig-comment k5 media=m1 by=fan3: multi line"], code: 0 });
	expect(calls(ctx, "/m2/")).toHaveLength(0);
	const before = ctx.calls.length;
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls.length).toBe(before + 1);
});

test("a transient failure is absorbed twice and reported on the 3rd failed run", async () => {
	const ctx = fakeCtx(env, { routes: { [MEDIA]: () => media(1) } });
	await run(ctx, []);
	ctx.routes[MEDIA] = () => new Response("{}", { status: 500 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	const third = await run(ctx, []);
	expect(third.lines[0]).toBe("DOTZ_FAIL network");
	expect(third.code).toBe(1);
});

test("OAuthException 190 prints DOTZ_FAIL instagram-auth at once", async () => {
	const ctx = fakeCtx(env, { routes: { [MEDIA]: () => Response.json({ error: { code: 190, type: "OAuthException" } }, { status: 400 }) } });
	const res = await run(ctx, []);
	expect(res.code).toBe(1);
	expect(res.lines[0]).toBe("DOTZ_FAIL instagram-auth");
});

test("quiet hours are silent and touch nothing", async () => {
	const ctx = fakeCtx(env, { now: "2030-06-15T16:00:00Z", routes: { [MEDIA]: () => media(1) } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
	expect(existsSync(join(env.stateDir, "state.json"))).toBe(false);
});

test("missing config or an unconnected account prints DOTZ_FAIL setup", async () => {
	const ctx = fakeCtx(env);
	rmSync(paths.config());
	expect((await run(ctx, [])).lines[0]).toBe("DOTZ_FAIL setup");
	writeJson(paths.config(), { version: 1, youtube: { channel_id: "UC0123456789abcdef", base_language: "ko", languages: [], privacy: "private", upload_via: "api" }, timezone: "Asia/Seoul", posting_times: ["18:00"], approval: "each", inbox_dir: paths.inbox(), quota: { daily_budget: 9000 } });
	const res = await run(ctx, []);
	expect(res.lines[0]).toBe("DOTZ_FAIL setup");
	expect(res.code).toBe(1);
});
