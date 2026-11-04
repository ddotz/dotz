import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { HUB_TOKEN, PORT } from "./config.ts";
import { createLocalLogin } from "./local-login.ts";
import { ALLOW, makeRoute, webAccess } from "./routes.ts";

// 이 컴퓨터만 로그인 링크 on the real route: a link minted with the hub token becomes a cookie, and every check of localBrowser() still applies to both
// the redeeming and the cookie. Unit cases (expiry, caps, an unreadable file) use createLocalLogin with an injected clock.
const DATA = process.env.DOTZ_DIR!;
const FILE = join(DATA, "web-local-sessions.json");
const PEER_FILE = join(DATA, "secrets", "peer-token");
const PEER = "peer-token-for-the-test-0123456789";
const OWNER = "owner@example.com";
const BASE = `http://127.0.0.1:${PORT}`;
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const owner = { "x-dotz-token": HUB_TOKEN };
const at = (ip: string) => ({ requestIP: () => ({ address: ip, family: "IPv4", port: 50000 }) }) as unknown as Server<unknown>;
type Hit = { method?: string; headers?: Record<string, string>; base?: string; ip?: string };
const hit = (path: string, o: Hit = {}) => route(new Request(`${o.base ?? BASE}${path}`, { method: o.method ?? "GET", headers: o.headers }), at(o.ip ?? "127.0.0.1"));
const status = (path: string, o: Hit = {}) => hit(path, o).then(r => r.status);
const mint = async () => ((await hit("/api/web-access/login-link", { method: "POST", headers: owner })).json() as Promise<{ url: string; expires_at: string }>);
const linkPath = async () => `/local-login${new URL((await mint()).url).search}`;
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;
const session = async () => cookieOf(await hit(await linkPath()));
const setMode = (mode: string) => webAccess.change({ mode });
const logText = () => (existsSync(join(DATA, "hub.log")) ? readFileSync(join(DATA, "hub.log"), "utf8") : "");
const DENIED = "링크가 만료됐거나 이미 썼어요. 터미널에서 다시 받아 주세요.";

// Not a browser on this computer: each must refuse both a code and a valid cookie. [headers, base, peer ip]
const NOT_LOCAL: [Record<string, string>, string?, string?][] = [
	[{}, undefined, "192.168.0.7"],
	[{}, "http://dotz.test"],
	[{}, "http://rebind.evil.com:7420"],
	[{ "x-forwarded-for": "203.0.113.9" }],
	[{ forwarded: "for=203.0.113.9" }],
	[{ "cf-connecting-ip": "203.0.113.9" }],
	[{ "tailscale-user-login": "someone@example.com" }],
	[{ origin: "https://evil.com" }],
	[{ origin: "http://localhost:7420" }],
	[{ "sec-fetch-site": "cross-site" }],
	[{ "sec-fetch-site": "same-site" }],
];

beforeAll(async () => {
	await webAccess.change({ mode: "local" });
});
afterAll(async () => {
	await webAccess.change({ mode: "tailscale" });
	rmSync(join(DATA, "web-access.json"), { force: true });
	rmSync(PEER_FILE, { force: true });
	ALLOW.delete(OWNER);
});

describe("이 컴퓨터만 로그인 링크", () => {
	test("a link minted with the token becomes a 303 with the cookie, the cookie opens the API, a restart keeps it", async () => {
		const m = await mint();
		expect(new URL(m.url).origin).toBe(BASE);
		const r = await hit(`/local-login${new URL(m.url).search}`);
		expect([r.status, r.headers.get("location"), r.headers.get("cache-control"), r.headers.get("referrer-policy")]).toEqual([303, "/", "no-store", "no-referrer"]);
		expect(r.headers.get("set-cookie")).toMatch(/^dotz_local=[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/);
		const cookie = cookieOf(r);
		expect(await status("/api/state", { headers: { cookie } })).toBe(200);
		expect(createLocalLogin({ dir: DATA }).verify(new Request(BASE, { headers: { cookie } }))).toBe(true);
	});

	test("no header and no cookie from the loopback is 403 and says how to get a link", async () => {
		const r = await hit("/api/state");
		expect([r.status, r.headers.get("content-type")]).toEqual([403, "text/plain; charset=utf-8"]);
		expect(await r.text()).toBe("이 컴퓨터만 모드예요. 터미널에서 bun hub/web-login-cli.ts 를 실행해 로그인 링크를 받아 주세요.");
		expect(await status("/api/state", { headers: { cookie: "dotz_local=" } })).toBe(403);
		expect(await status("/api/state", { headers: { cookie: "dotz_local=not-a-session" } })).toBe(403);
	});

	test("a code works once: the second use is 403", async () => {
		const path = await linkPath();
		expect(await status(path)).toBe(303);
		const again = await hit(path);
		expect([again.status, await again.text()]).toEqual([403, DENIED]);
		expect(again.headers.get("set-cookie")).toBeNull();
	});

	test("a wrong or missing code is 403", async () => {
		await mint();
		for (const q of ["?code=nope", "?code=", "", "?code=" + "A".repeat(43)]) expect(await status(`/local-login${q}`)).toBe(403);
	});

	test("a request from a different Origin is refused for the cookie and for redeeming, and the code stays valid", async () => {
		const cookie = await session();
		const path = await linkPath();
		const evil = { origin: "https://evil.com" };
		expect(await status("/api/state", { headers: { ...evil, cookie } })).toBe(403);
		expect(await status(path, { headers: evil })).toBe(403);
		expect(await status("/api/state", { headers: { cookie } })).toBe(200);
		expect(await status(path)).toBe(303);
	});

	test("anything that is not a browser on this computer is refused, for a code (it stays valid) and for a valid cookie", async () => {
		const cookie = await session();
		const path = await linkPath();
		for (const [headers, base, ip] of NOT_LOCAL) {
			const o = { base, ip };
			expect([headers, base, ip, await status(path, { ...o, headers })]).toEqual([headers, base, ip, 403]);
			expect([headers, base, ip, await status("/api/state", { ...o, headers: { ...headers, cookie } })]).toEqual([headers, base, ip, 403]);
		}
		expect(await status(path)).toBe(303);
	});

	test("a prefetch does not use the code up", async () => {
		const path = await linkPath();
		expect(await status(path, { headers: { "sec-purpose": "prefetch;prerender" } })).toBe(403);
		expect(await status(path)).toBe(303);
	});

	test("only the token mints: a session cookie cannot, a stranger cannot, outside local mode it is 409", async () => {
		const cookie = await session();
		const mintWith = (headers: Record<string, string>) => status("/api/web-access/login-link", { method: "POST", headers });
		expect(await mintWith({ cookie })).toBe(403);
		expect(await mintWith({})).toBe(403);
		expect(await mintWith(owner)).toBe(200);
		await setMode("tailscale");
		expect(await mintWith(owner)).toBe(409);
		await setMode("local");
	});

	test("a peer request can neither mint a link nor redeem a code", async () => {
		mkdirSync(join(DATA, "secrets"), { recursive: true });
		writeFileSync(PEER_FILE, PEER);
		const peer = { "x-dotz-peer": PEER, "tailscale-user-login": OWNER };
		expect(await status("/api/peer-info", { headers: peer })).toBe(200);
		const path = await linkPath();
		expect(await status(path, { headers: peer })).toBe(403);
		expect(await status("/api/web-access/login-link", { method: "POST", headers: { ...peer, ...owner } })).toBe(403);
		expect(await status(path)).toBe(303);
	});

	test("leaving local mode voids the cookie for good: switching to Tailscale and back needs a new link", async () => {
		const cookie = await session();
		const path = await linkPath();
		expect(existsSync(FILE)).toBe(true);
		await setMode("tailscale");
		expect(existsSync(FILE)).toBe(false);
		expect(await status("/api/state", { headers: { cookie } })).toBe(403);
		expect(await status(path)).toBe(403);
		await setMode("local");
		expect(await status("/api/state", { headers: { cookie } })).toBe(403);
		expect(await status(path)).toBe(403);
		expect(await status("/api/state", { headers: { cookie: await session() } })).toBe(200);
	});

	test("the other modes are unchanged: the token and a Tailscale login get in outside local mode, a stranger gets a plain forbidden", async () => {
		ALLOW.add(OWNER);
		expect(await status("/api/state", { headers: owner })).toBe(200);
		await setMode("tailscale");
		expect(await status("/api/state", { headers: owner })).toBe(200);
		expect(await status("/api/state", { headers: { "tailscale-user-login": OWNER } })).toBe(200);
		const stranger = await hit("/api/state");
		expect([stranger.status, await stranger.text()]).toEqual([403, "forbidden"]);
		await setMode("local");
		expect(await status("/api/state", { headers: owner })).toBe(200);
	});

	test("a forged Tailscale login of the allowed owner does not get in while the mode is local", async () => {
		ALLOW.add(OWNER);
		expect(await status("/api/state", { headers: { "tailscale-user-login": OWNER } })).toBe(403);
	});

	test("the sessions file is 0600 and holds neither a code nor a session token; neither is in the log", async () => {
		const m = await mint();
		const code = new URL(m.url).searchParams.get("code")!;
		const cookie = cookieOf(await hit(`/local-login?code=${code}`));
		const token = cookie.slice("dotz_local=".length);
		expect(statSync(FILE).mode & 0o777).toBe(0o600);
		const text = readFileSync(FILE, "utf8");
		const log = logText();
		for (const secret of [code, token]) {
			expect(text).not.toContain(secret);
			expect(log).not.toContain(secret);
		}
		expect(JSON.parse(text).sessions[0]).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), expires_at: expect.any(Number) });
	});
});

describe("createLocalLogin", () => {
	const tmp = mkdtempSync(join(tmpdir(), "local-login-"));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));
	const withCookie = (token: string) => new Request(BASE, { headers: { cookie: `dotz_local=${token}` } });
	let t = 1_000_000;
	const make = (dir: string) => createLocalLogin({ dir, now: () => t });

	test("a code expires after 5 minutes", () => {
		const ll = make(join(tmp, "a"));
		const fresh = ll.mint();
		const stale = ll.mint();
		t += 5 * 60_000 - 1;
		expect(ll.redeem(fresh)).toBeString();
		t += 2;
		expect(ll.redeem(stale)).toBeUndefined();
	});

	test("a session lasts 30 days from the login, without sliding", () => {
		const ll = make(join(tmp, "b"));
		const token = ll.redeem(ll.mint())!;
		t += 30 * 24 * 3600_000 - 1;
		expect(ll.verify(withCookie(token))).toBe(true);
		expect(ll.verify(withCookie(token))).toBe(true);
		t += 2;
		expect(ll.verify(withCookie(token))).toBe(false);
		expect(make(join(tmp, "b")).verify(withCookie(token))).toBe(false);
	});

	test("at most 5 codes and 10 sessions are kept, the oldest dropped", () => {
		const ll = make(join(tmp, "c"));
		const codes = Array.from({ length: 6 }, () => ll.mint());
		expect(ll.redeem(codes[0]!)).toBeUndefined();
		expect(ll.redeem(codes[5]!)).toBeString();
		const tokens = Array.from({ length: 11 }, () => ll.redeem(ll.mint())!);
		expect(ll.verify(withCookie(tokens[0]!))).toBe(false);
		expect(ll.verify(withCookie(tokens[1]!))).toBe(true);
		expect(make(join(tmp, "c")).verify(withCookie(tokens[10]!))).toBe(true);
	});

	test("an unreadable sessions file means no sessions, never a throw", () => {
		const dir = join(tmp, "d");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "web-local-sessions.json"), "{ not json");
		const ll = make(dir);
		expect(ll.verify(withCookie("anything"))).toBe(false);
		expect(ll.redeem(ll.mint())).toBeString();
	});
});
