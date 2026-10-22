import { expect, test } from "bun:test";
import { defaultConfig, type Ctx } from "../lib/config.ts";
import { initialState, pollOnce, postToGateway } from "../lib/watchkit.ts";
import { startFakeServer, mkMail } from "./fakeserver.ts";

const config = defaultConfig("fake");
const ctxFor = (srv: ReturnType<typeof startFakeServer>): Ctx => ({ fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 1_700_000_000_000, sleep: async () => {}, log: () => {} });
const noRecover = async () => false;

test("first run seeds silently, then reports only genuinely new mail", async () => {
	const srv = startFakeServer([mkMail(2), mkMail(1)]);
	try {
		const ctx = ctxFor(srv);
		let s = initialState();

		let r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.lines).toEqual([]);
		expect(r.state.seeded).toBe(true);
		s = r.state;

		r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.lines).toEqual([]);
		expect(r.note).toContain("not modified");
		s = r.state;

		srv.addMail(mkMail(3, "hello"));
		r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.lines.length).toBe(1);
		expect(r.lines[0]).toContain("mail 3");
		expect(r.lines[0]).toContain("hello");
		s = r.state;

		r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.lines).toEqual([]);
	} finally {
		srv.close();
	}
});

test("new mail goes to the gateway as a woken mail conversation; only a mail it did not take keeps its line", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const ctx = ctxFor(srv);
		const s = (await pollOnce(ctx, srv.spec, config, initialState(), noRecover)).state;
		srv.addMail(mkMail(2, "budget"));
		srv.addMail(mkMail(3, "meeting"));
		const r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.mails.map((m) => m.id)).toEqual(["2", "3"]);

		const calls: { method: string; path: string; body: any }[] = [];
		const gw = async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			if ((body as any).id === "3") throw new Error("HTTP 404");
			return { ok: true };
		};
		const left = await postToGateway(gw, "fake", r, () => {});
		expect(calls.map((c) => [c.method, c.path, c.body.source, c.body.id, c.body.wake])).toEqual([
			["POST", "/api/mail", "fake", "2", true],
			["POST", "/api/mail", "fake", "3", true],
		]);
		expect(calls[0].body.subject).toContain("budget");
		expect(left.length).toBe(1);
		expect(left[0]).toContain("mail 3");

		const down = await postToGateway(async () => { throw new Error("게이트웨이에 연결하지 못했어요"); }, "fake", r, () => {});
		expect(down).toEqual(r.lines);
	} finally {
		srv.close();
	}
});

test("an old mail sliding back into the window is not reported again", async () => {
	const srv = startFakeServer([mkMail(5), mkMail(4)]);
	try {
		const ctx = ctxFor(srv);
		let s = (await pollOnce(ctx, srv.spec, config, initialState(), noRecover)).state;
		srv.setMails([mkMail(6, "new"), mkMail(5), mkMail(2, "old-returning")]);
		const r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.lines.length).toBe(1);
		expect(r.lines[0]).toContain("mail 6");
	} finally {
		srv.close();
	}
});

test("recovers from a dropped login once, then continues", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const ctx = ctxFor(srv);
		let s = (await pollOnce(ctx, srv.spec, config, initialState(), noRecover)).state;
		srv.setLoggedOut(true);
		const recover = async () => {
			srv.setLoggedOut(false);
			return true;
		};
		const r = await pollOnce(ctx, srv.spec, config, s, recover);
		expect(r.fail).toBeUndefined();
		expect(r.state.loggedOut).toBe(false);
	} finally {
		srv.close();
	}
});

test("asks the owner once when recovery fails, then stays silent", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const ctx = ctxFor(srv);
		let s = (await pollOnce(ctx, srv.spec, config, initialState(), noRecover)).state;
		srv.setLoggedOut(true);

		let r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.fail).toBe("DOTZ_FAIL webmail-login");
		expect(r.state.asked).toBe(true);
		s = r.state;

		r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.fail).toBeUndefined();
		expect(r.lines).toEqual([]);
	} finally {
		srv.close();
	}
});

test("a transient network error is absorbed until three in a row", async () => {
	const srv = startFakeServer([mkMail(1)]);
	const ctx: Ctx = { ...ctxFor(srv), fetch: (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch };
	try {
		let s = initialState();
		let r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.fail).toBeUndefined();
		s = r.state;
		r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.fail).toBeUndefined();
		s = r.state;
		r = await pollOnce(ctx, srv.spec, config, s, noRecover);
		expect(r.fail).toBe("DOTZ_FAIL network");
	} finally {
		srv.close();
	}
});
