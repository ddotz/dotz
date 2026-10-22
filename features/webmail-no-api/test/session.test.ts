import { afterAll, expect, test } from "bun:test";
import { classifyList, keepalive } from "../lib/session.ts";
import { type Ctx } from "../lib/config.ts";
import { startFakeServer, mkMail } from "./fakeserver.ts";

const srv = startFakeServer([mkMail(2), mkMail(1)]);
const ctx: Ctx = { fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 0, sleep: async () => {}, log: () => {} };
afterAll(() => srv.close());

test("classifyList: array = ok, redirect/401/login page = logged out", () => {
	expect(classifyList(srv.spec, 200, JSON.stringify({ mails: [] })).kind).toBe("ok");
	expect(classifyList(srv.spec, 302, "").kind).toBe("loggedout");
	expect(classifyList(srv.spec, 401, "").kind).toBe("loggedout");
	expect(classifyList(srv.spec, 200, "<html><form>password</form></html>").kind).toBe("loggedout");
	expect(classifyList(srv.spec, 200, JSON.stringify({ nope: 1 })).kind).toBe("loggedout");
});

test("keepalive returns an etag, then 304 not-modified when nothing changed", async () => {
	const cookie = await srv.cookieHeader();
	const first = await keepalive(ctx, srv.spec, cookie, {});
	expect(first.status).toBe("ok");
	expect(first.etag).toBeTruthy();
	expect(Array.isArray((first.body as any).mails)).toBe(true);

	const second = await keepalive(ctx, srv.spec, cookie, { etag: first.etag });
	expect(second.status).toBe("notmodified");
});

test("keepalive sees a logged-out session", async () => {
	srv.setLoggedOut(true);
	const cookie = await srv.cookieHeader();
	const r = await keepalive(ctx, srv.spec, cookie, {});
	expect(r.status).toBe("loggedout");
	srv.setLoggedOut(false);
});
