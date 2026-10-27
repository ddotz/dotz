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

// The gateway alerts after two failures in a row and shows the app as disconnected while the watch fails (hub/watch.ts, hub/watch-status.ts):
// a watch that went quiet (exit 0) after its first logged-out poll was never alerted and read as connected for the whole outage.
test("keeps failing every poll while logged out, tries the recovery once", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const ctx = ctxFor(srv);
		let s = (await pollOnce(ctx, srv.spec, config, initialState(), noRecover)).state;
		srv.setLoggedOut(true);
		let tries = 0;
		const recover = async () => (tries++, false);

		let r = await pollOnce(ctx, srv.spec, config, s, recover);
		expect(r.fail).toBe("DOTZ_FAIL webmail-login");
		s = r.state;

		r = await pollOnce(ctx, srv.spec, config, s, recover);
		expect(r.fail).toBe("DOTZ_FAIL webmail-login");
		expect(r.state.loggedOut).toBe(true);
		expect(r.lines).toEqual([]);
		expect(tries).toBe(1);

		srv.setLoggedOut(false);
		r = await pollOnce(ctx, srv.spec, config, r.state, recover);
		expect(r.fail).toBeUndefined();
		expect(r.state.loggedOut).toBe(false);
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

test("a logged-out poll the owner approved signs in again (second factor included), even after the silent recover was spent", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const ctx = ctxFor(srv);
		const seeded = (await pollOnce(ctx, srv.spec, config, initialState(), noRecover)).state;
		srv.setLoggedOut(true);
		const down = await pollOnce(ctx, srv.spec, config, seeded, noRecover);
		expect([down.fail, down.state.recoverTried]).toEqual(["DOTZ_FAIL webmail-login", true]);
		const still = await pollOnce(ctx, srv.spec, config, down.state, noRecover);
		expect(still.note).toBe("logged out, waiting");
		let signIns = 0;
		const refused = await pollOnce(ctx, srv.spec, config, still.state, noRecover, async () => (signIns++, false));
		expect([refused.fail, refused.note, signIns]).toEqual(["DOTZ_FAIL webmail-login", "logged out, approved sign-in failed", 1]);
		srv.addMail(mkMail(2, "after login"));
		const back = await pollOnce(ctx, srv.spec, config, refused.state, noRecover, async () => (signIns++, srv.setLoggedOut(false), true));
		expect([back.fail, back.state.loggedOut, signIns]).toEqual([undefined, false, 2]);
		expect(back.mails.map((m) => m.id)).toEqual(["2"]);
	} finally {
		srv.close();
	}
});
