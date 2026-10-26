// A newly onboarded site is its own 메일 app instance (docs/custom-plugins.md "Registering a mail reader as a mail instance"): one row in
// 모니터링 with its own name, its own watches, and its own 연결 끊김 state while the site is logged out. The gateway is a fake that runs the
// real instance registry (hub/app-off.ts createApp) on this test's data dir; the mail site is the fake server.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchStatusLike } from "../../../hub/watch-status.ts";
import { defaultConfig, type Ctx } from "../lib/config.ts";
import { appInstance, runOnboard, type Io } from "../lib/onboard.ts";
import type { CapturedRequest } from "../lib/capture.ts";
import { initialState, pollOnce, type WatchState } from "../lib/watchkit.ts";
import { mkMail, startFakeServer } from "./fakeserver.ts";

const prevDir = process.env.DOTZ_DIR;
let dir = "";
let createApp: typeof import("../../../hub/app-off.ts").createApp;
let ownedWatches: typeof import("../../../hub/app-features.ts").ownedWatches;
let withConnection: typeof import("../../../hub/integrations.ts").withConnection;
beforeAll(async () => {
	// The registry modules load hub/config.ts: they must see the preload's data dir, whatever another webmail test file left in DOTZ_DIR.
	process.env.DOTZ_DIR = join(process.env.DOTZ_TEST_DIR!, "data");
	({ createApp } = await import("../../../hub/app-off.ts"));
	({ ownedWatches } = await import("../../../hub/app-features.ts"));
	({ withConnection } = await import("../../../hub/integrations.ts"));
	dir = mkdtempSync(join(tmpdir(), "wm-instance-"));
	process.env.DOTZ_DIR = dir;
});
afterAll(() => {
	process.env.DOTZ_DIR = prevDir;
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => rmSync(join(dir, "custom", "apps.json"), { force: true }));
const apps = () => JSON.parse(readFileSync(join(dir, "custom", "apps.json"), "utf8"));

async function recordFrom(srv: ReturnType<typeof startFakeServer>): Promise<CapturedRequest[]> {
	const get = async (path: string): Promise<CapturedRequest> => {
		const r = await fetch(srv.origin + path, { headers: { cookie: "session=good" } });
		return { url: srv.origin + path, method: "GET", status: r.status, contentType: r.headers.get("content-type") ?? "", responseBody: await r.text() };
	};
	return [await get("/mail/mboxes/100/mails"), await get("/mail/mails/2")];
}

// The gateway: POST /api/apps runs the real registry (a SettingsError keeps its HTTP status, as lib/gateway.ts liveGateway reports it), every
// other call is recorded. `down` = the gateway is not running.
function fakeIo(srv: ReturnType<typeof startFakeServer>, gw: { down?: boolean; calls: { path: string; body: any }[] }): Io {
	const ctx: Ctx = { fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 1_700_000_000_000, sleep: async () => {}, log: () => {} };
	return {
		ctx,
		mailElsewhere: () => undefined,
		asideReady: async () => true,
		loginState: async () => "in",
		login: async () => "in",
		record: () => recordFrom(srv),
		gateway: async (method, path, body) => {
			if (gw.down) throw new Error("게이트웨이에 연결하지 못했어요 (게이트웨이가 켜져 있나요?)");
			gw.calls.push({ path, body });
			if (method === "POST" && path === "/api/apps") return { ok: true, ...createApp(dir, body as never) };
			return {};
		},
		progress: async () => {},
	};
}

test("onboarding registers the site once as its own mail instance; a rerun adds none", async () => {
	const srv = startFakeServer([mkMail(2), mkMail(1)]);
	try {
		const gw = { calls: [] as { path: string; body: any }[] };
		const r = await runOnboard(fakeIo(srv, gw), { site: "work", url: `${srv.origin}/mail/`, label: "회사 메일" });
		expect(r.status).toBe("done");
		expect(apps()).toEqual({ "mail-work": { app: "mail", label: "회사 메일", filter: { source: "work", watches: ["webmail-work"], data: ["custom/webmail/work"] } } });
		expect(r.message).toContain("회사 메일");

		const again = await runOnboard(fakeIo(srv, gw), { site: "work", restart: true, url: `${srv.origin}/mail/` });
		expect(again.status).toBe("done");
		expect(Object.keys(apps())).toEqual(["mail-work"]);
		expect(gw.calls.filter((c) => c.path === "/api/apps")).toHaveLength(2);
	} finally {
		srv.close();
	}
});

test("a site onboarded before instances existed gets its instance on the next run", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const gw = { calls: [] as { path: string; body: any }[] };
		await runOnboard(fakeIo(srv, gw), { site: "old", url: `${srv.origin}/mail/` });
		const f = join(dir, "custom", "webmail", "old", "onboard.json");
		const s = JSON.parse(readFileSync(f, "utf8"));
		await Bun.write(f, JSON.stringify({ ...s, done: s.done.filter((d: string) => d !== "app") }));
		rmSync(join(dir, "custom", "apps.json"), { force: true });
		const r = await runOnboard(fakeIo(srv, gw), { site: "old" });
		expect(r.status).toBe("done");
		expect(apps()["mail-old"]).toMatchObject({ app: "mail", label: "old 메일", filter: { source: "old" } });
	} finally {
		srv.close();
	}
});

test("with the gateway down the run stops at the instance step, says so, and the next run registers it", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		const gw = { calls: [] as { path: string; body: any }[], down: false };
		const io = fakeIo(srv, gw);
		await runOnboard(io, { site: "down", url: `${srv.origin}/mail/` });
		const f = join(dir, "custom", "webmail", "down", "onboard.json");
		const s = JSON.parse(readFileSync(f, "utf8"));
		await Bun.write(f, JSON.stringify({ ...s, done: s.done.filter((d: string) => d !== "app") }));
		rmSync(join(dir, "custom", "apps.json"), { force: true });

		gw.down = true;
		let r = await runOnboard(io, { site: "down" });
		expect(r.status).toBe("failed");
		expect(r.step).toBe("app");
		expect(r.message).toContain("게이트웨이");
		expect(r.message).toContain("다시 실행");

		gw.down = false;
		r = await runOnboard(io, { site: "down" });
		expect(r.status).toBe("done");
		expect(apps()["mail-down"].filter.source).toBe("down");
	} finally {
		srv.close();
	}
});

test("an https site's instance owns its login keeper too", () => {
	const srv = startFakeServer([]);
	try {
		const spec = { ...srv.spec, site: "corp", origin: "https://mail.example.test" };
		expect(appInstance("corp", "회사 메일", spec, defaultConfig("corp")).filter.watches).toEqual(["webmail-corp", "webmail-corp-login"]);
	} finally {
		srv.close();
	}
});

// hub/watch.ts on one run of a check: a failing run counts up (its `DOTZ_FAIL <kind>` is the kind, the first failure is failSince), a passing run
// resets. Not imported: that module runs the watches of the gateway's own data dir.
function afterRun(prev: WatchStatusLike, out: { fail?: string; lines: string[] }, at: number): WatchStatusLike {
	if (!out.fail) return { name: prev.name, state: { fails: 0, last: out.lines.join("\n") } };
	return { name: prev.name, state: { fails: prev.state.fails + 1, failSince: prev.state.failSince ?? at, kind: /^DOTZ_FAIL (\S+)/.exec(out.fail)?.[1], last: out.fail } };
}

test("a logged-out site shows 연결 끊김 in its own row, not in the default 메일 row, and comes back when the login does", async () => {
	const srv = startFakeServer([mkMail(2), mkMail(1)]);
	try {
		const gw = { calls: [] as { path: string; body: any }[] };
		const io = fakeIo(srv, gw);
		expect((await runOnboard(io, { site: "kdb", url: `${srv.origin}/mail/`, label: "회사 메일" })).status).toBe("done");
		const name = gw.calls.find((c) => c.path === "/api/watches")!.body.name as string;

		const config = defaultConfig("kdb");
		let st: WatchState = initialState();
		let watch: WatchStatusLike = { name, state: { fails: 0 } };
		const run = async (at: number) => {
			const r = await pollOnce(io.ctx, srv.spec, config, st, async () => false);
			st = r.state;
			watch = afterRun(watch, r, at);
		};
		const row = () => {
			const own = ownedWatches(dir, [watch]);
			return { mine: withConnection({ key: "mail-kdb", own: own.get("mail-kdb") ?? [] }, [watch], "Asia/Seoul"), dflt: withConnection({ key: "mail", own: own.get("mail") ?? [] }, [watch], "Asia/Seoul") };
		};

		await run(Date.parse("2026-10-23T12:00:00Z"));
		expect(row().mine.state).toBe("connected");

		srv.setLoggedOut(true);
		await run(Date.parse("2026-10-23T12:29:00Z"));
		await run(Date.parse("2026-10-23T12:34:00Z"));
		expect(watch.state.fails).toBe(2);
		const down = row();
		expect(down.mine).toMatchObject({ state: "disconnected", since: "2026-10-23T12:29:00.000Z" });
		expect(down.mine.hint).toBe("연결 끊김 · 10월 23일 21:29부터 · 다시 로그인 필요");
		expect(down.dflt.state).toBe("connected");

		srv.setLoggedOut(false);
		await run(Date.parse("2026-10-23T13:00:00Z"));
		expect(row().mine.state).toBe("connected");
	} finally {
		srv.close();
	}
});
