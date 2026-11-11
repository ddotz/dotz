// Instagram DMs, read only: the Conversations API answers parsed, only moved conversations are read again, a missing permission is
// remembered and not retried at once, and with the feature off nothing is requested. Fake fetch only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run } from "../bin/ig-dm.ts";
import { paths, readJson, writeJson } from "../lib/config.ts";
import { clearDms, PERMISSION_LINE, readDms, syncDms } from "../lib/ig-dm.ts";
import { calls, fakeCtx, IG, setupEnv, type TestEnv } from "./helpers.ts";

const LIST = `GET ${IG}/me/conversations`;
const OWN = { id: "17841", username: "owner_ig" };
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const messages = {
	messages: {
		data: [
			{ id: "m3", message: "", created_time: "2030-06-15T11:30:00+0000", from: { id: "9", username: "fan" }, to: { data: [{ id: "17841", username: "owner_ig" }] }, attachments: { data: [{ mime_type: "image/jpeg", image_data: { url: "x" } }] } },
			{ id: "m2", message: "곧 올릴게요", created_time: "2030-06-15T11:10:00+0000", from: { id: "17841", username: "owner_ig" }, to: { data: [{ id: "9", username: "fan" }] } },
			{ id: "m1", message: "안녕하세요 <b>문의</b>", created_time: "2030-06-15T11:00:00+0000", from: { id: "9", username: "fan" }, to: { data: [{ id: "17841", username: "owner_ig" }] } },
		],
	},
};

test("syncDms parses a conversation: peer, own messages, attachments, oldest first", async () => {
	const ctx = fakeCtx(env, { routes: { [LIST]: () => ({ data: [{ id: "c1", updated_time: "2030-06-15T11:30:00+0000" }] }), [`GET ${IG}/c1`]: () => messages } });
	expect(await syncDms(ctx, { enabled: () => true, own: OWN })).toEqual({ perm: "ok", fetched: 1 });
	const q = new URL(ctx.calls[0].url).searchParams;
	expect(q.get("platform")).toBe("instagram");
	expect(new URL(ctx.calls[1].url).searchParams.get("fields")).toContain("message");
	expect(ctx.calls.every(c => c.method === "GET")).toBe(true);

	const conv = readDms().convs.c1!;
	expect(conv.peer).toBe("fan");
	expect(conv.messages.map(m => [m.id, m.mine, m.text, m.attach])).toEqual([
		["m1", false, "안녕하세요 <b>문의</b>", []],
		["m2", true, "곧 올릴게요", []],
		["m3", false, "", ["image"]],
	]);
	expect(conv.last).toBe("(사진)");
	expect(conv.lastAt).toBe(Date.parse("2030-06-15T11:30:00+0000"));
});

test("a conversation is read again only when its updated_time moved", async () => {
	const ctx = fakeCtx(env, { routes: { [LIST]: () => ({ data: [{ id: "c1", updated_time: "2030-06-15T11:30:00+0000" }, { id: "c2", updated_time: "2030-06-15T10:00:00+0000" }] }), [`GET ${IG}/c1`]: () => messages, [`GET ${IG}/c2`]: () => ({ messages: { data: [] } }) } });
	expect((await syncDms(ctx, { enabled: () => true, own: OWN })).fetched).toBe(2);
	expect((await syncDms(ctx, { enabled: () => true, own: OWN })).fetched).toBe(0);
	expect(calls(ctx, "/me/conversations")).toHaveLength(2);
	expect(calls(ctx, "/c1")).toHaveLength(1);
	ctx.routes[LIST] = () => ({ data: [{ id: "c1", updated_time: "2030-06-15T12:00:00+0000" }, { id: "c2", updated_time: "2030-06-15T10:00:00+0000" }] });
	expect((await syncDms(ctx, { enabled: () => true, own: OWN })).fetched).toBe(1);
	expect(calls(ctx, "/c1")).toHaveLength(2);
	expect(calls(ctx, "/c2")).toHaveLength(1);
});

test("a missing permission is stored with the Korean line and not asked again for a few hours", async () => {
	const denied = () => new Response(JSON.stringify({ error: { code: 10, type: "OAuthException", message: "requires instagram_business_manage_messages" } }), { status: 400 });
	const ctx = fakeCtx(env, { routes: { [LIST]: denied } });
	expect(await syncDms(ctx, { enabled: () => true, own: OWN })).toEqual({ perm: "missing", fetched: 0 });
	expect(readDms().perm).toBe("missing");
	expect(readDms().error).toBe(PERMISSION_LINE);
	expect(PERMISSION_LINE).toContain("instagram_business_manage_messages");

	expect(await syncDms(ctx, { enabled: () => true, own: OWN })).toEqual({ skipped: "recheck-later", perm: "missing", fetched: 0 });
	expect(calls(ctx, "/me/conversations")).toHaveLength(1);

	const later = fakeCtx(env, { now: "2030-06-15T19:00:00.000Z", routes: { [LIST]: () => ({ data: [] }) } });
	expect((await syncDms(later, { enabled: () => true, own: OWN })).perm).toBe("ok");
	const renewed = fakeCtx(env, { routes: { [LIST]: denied } });
	await syncDms(renewed, { enabled: () => true, own: OWN });
	writeJson(paths.instagram(), { ...readJson<object>(paths.instagram()), obtained_at: "2030-06-15T12:01:00.000Z" }, true);
	const afterToken = fakeCtx(env, { routes: { [LIST]: () => ({ data: [] }) } });
	expect((await syncDms(afterToken, { enabled: () => true, own: OWN })).perm).toBe("ok");
});

test("other API errors are not taken for a missing permission", async () => {
	const ctx = fakeCtx(env, { routes: { [LIST]: () => new Response(JSON.stringify({ error: { code: 100, type: "GraphMethodException" } }), { status: 400 }) } });
	await expect(syncDms(ctx, { enabled: () => true, own: OWN })).rejects.toThrow();
	expect(readDms().perm).toBe("unknown");
});

test("with the feature off the watch requests nothing and the stored DMs are deleted", async () => {
	const on = fakeCtx(env, { routes: { [LIST]: () => ({ data: [{ id: "c1", updated_time: "2030-06-15T11:30:00+0000" }] }), [`GET ${IG}/c1`]: () => messages } });
	await syncDms(on, { enabled: () => true, own: OWN });
	expect(Object.keys(readDms().convs)).toEqual(["c1"]);

	const off = fakeCtx(env);
	expect(await run(off, [], () => false)).toEqual({ lines: [], code: 0 });
	expect(off.calls).toHaveLength(0);
	expect(readDms().convs).toEqual({});

	clearDms();
	const watching = fakeCtx(env, { routes: { [LIST]: () => ({ data: [] }) } });
	expect(await run(watching, [], () => true)).toEqual({ lines: [], code: 0 });
	expect(watching.calls).toHaveLength(1);
});
