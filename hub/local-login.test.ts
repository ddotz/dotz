import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { HUB_TOKEN, PORT } from "./config.ts";
import { type DialogAnswer, dialogAnswer, dialogCommand, dialogFinder, MAC_SCRIPT } from "./local-login-dialog.ts";
import { loginPage } from "./local-login-page.ts";
import { createLocalLogin } from "./local-login.ts";
import { ALLOW, localLogin, makeRoute, setLoginConfirm, webAccess } from "./routes.ts";

// 이 컴퓨터만 로그인 링크 on the real route: a link minted with the hub token becomes a cookie, and every check of localBrowser() still applies to both
// the redeeming and the cookie. Unit cases (expiry, caps, an unreadable file) use createLocalLogin with an injected clock.
const DATA = process.env.DOTZ_DIR!;
const FILE = join(DATA, "web-local-sessions.json");
const PEER_FILE = join(DATA, "secrets", "peer-token");
const PEER = "peer-token-for-the-test-0123456789";
const OWNER = "owner@example.com";
const BASE = `http://127.0.0.1:${PORT}`;
const TS = "mini.tailnet.ts.net";
const route = makeRoute({ tailnetName: async () => TS, busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
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
const DENIED = "링크가 만료됐거나 이미 썼어요. 터미널에서 dotz를 다시 실행해 주세요.";
const HINT = "이 컴퓨터만 모드예요. 브라우저에서 이 주소를 열어 로그인해 주세요.";

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

// The login page's confirmation dialog is a fake whose answer the test gives: `answer` settles the latest dialog and returns once the route has seen it.
const asked: string[] = [];
let settleDialog: (a: DialogAnswer) => void = () => {};
const answer = async (a: DialogAnswer): Promise<void> => {
	settleDialog(a);
	await Promise.resolve();
};

beforeAll(async () => {
	setLoginConfirm(number => {
		asked.push(number);
		return new Promise<DialogAnswer>(resolve => {
			settleDialog = resolve;
		});
	});
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
		expect(createLocalLogin({ dir: DATA }).verify(new Request(BASE, { headers: { cookie } }), "local")).toBe(true);
	});

	test("no header and no cookie from the loopback is 403 and says how to get a link", async () => {
		const r = await hit("/api/state");
		expect([r.status, r.headers.get("content-type")]).toEqual([403, "text/plain; charset=utf-8"]);
		expect(await r.text()).toBe(HINT);
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

	test("only the token mints: a session cookie cannot, a stranger cannot, a request that came through a proxy cannot", async () => {
		const cookie = await session();
		const mintWith = (headers: Record<string, string>) => status("/api/web-access/login-link", { method: "POST", headers });
		expect(await mintWith({ cookie })).toBe(403);
		expect(await mintWith({})).toBe(403);
		expect(await mintWith(owner)).toBe(200);
		await setMode("tailscale");
		expect(await mintWith(owner)).toBe(200);
		expect(await mintWith({ ...owner, "x-forwarded-for": "100.64.0.9" })).toBe(403);
		expect(await status("/api/web-access/login-link", { method: "POST", headers: owner, base: "https://box.example.ts.net" })).toBe(403);
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
		expect(await status("/api/state", { headers: { "tailscale-user-login": OWNER, host: TS } })).toBe(200);
		expect(await status("/api/state", { headers: { "tailscale-user-login": OWNER } })).toBe(403);
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
		expect(JSON.parse(text).sessions[0]).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), expires_at: expect.any(Number), mode: "local" });
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
		expect(ll.redeem(fresh, "local")).toBeString();
		t += 2;
		expect(ll.redeem(stale, "local")).toBeUndefined();
	});

	test("a session lasts 30 days from the login, without sliding", () => {
		const ll = make(join(tmp, "b"));
		const token = ll.redeem(ll.mint(), "local")!;
		t += 30 * 24 * 3600_000 - 1;
		expect(ll.verify(withCookie(token), "local")).toBe(true);
		expect(ll.verify(withCookie(token), "local")).toBe(true);
		t += 2;
		expect(ll.verify(withCookie(token), "local")).toBe(false);
		expect(make(join(tmp, "b")).verify(withCookie(token), "local")).toBe(false);
	});

	test("at most 5 codes and 10 sessions are kept, the oldest dropped", () => {
		const ll = make(join(tmp, "c"));
		const codes = Array.from({ length: 6 }, () => ll.mint());
		expect(ll.redeem(codes[0]!, "local")).toBeUndefined();
		expect(ll.redeem(codes[5]!, "local")).toBeString();
		const tokens = Array.from({ length: 11 }, () => ll.redeem(ll.mint(), "local")!);
		expect(ll.verify(withCookie(tokens[0]!), "local")).toBe(false);
		expect(ll.verify(withCookie(tokens[1]!), "local")).toBe(true);
		expect(make(join(tmp, "c")).verify(withCookie(tokens[10]!), "local")).toBe(true);
	});

	test("an unreadable sessions file means no sessions, never a throw", () => {
		const dir = join(tmp, "d");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "web-local-sessions.json"), "{ not json");
		const ll = make(dir);
		expect(ll.verify(withCookie("anything"), "local")).toBe(false);
		expect(ll.redeem(ll.mint(), "local")).toBeString();
	});
});

describe("이 컴퓨터만 로그인 페이지의 확인 창", () => {
	const html = { accept: "text/html" };
	const sameOrigin = (base = BASE) => ({ origin: base });
	const ask = (o: Hit = {}) => hit("/local-login/request", { method: "POST", ...o, headers: { ...sameOrigin(o.base), ...o.headers } });
	const poll = (id: string, o: Hit = {}) => hit(`/local-login/status?id=${encodeURIComponent(id)}`, o);
	const begin = async () => ((await ask()).json() as Promise<{ id: string; number: string }>);
	const stateOf = async (id: string, o: Hit = {}) => ((await poll(id, o)).json() as Promise<{ state: string }>).then(b => b.state);
	beforeEach(() => {
		localLogin.clear();
		asked.length = 0;
	});

	test("allow: pending, then the cookie once to the browser that asked, and it opens the API", async () => {
		const r = await ask();
		expect([r.status, r.headers.get("cache-control")]).toEqual([200, "no-store"]);
		const { id, number } = (await r.json()) as { id: string; number: string };
		expect(id).toMatch(/^[\w-]{43}$/);
		expect(number).toMatch(/^\d{4}$/);
		expect(asked).toEqual([number]);
		expect(await stateOf(id)).toBe("pending");
		await answer("allow");
		const done = await poll(id);
		expect([done.status, done.headers.get("cache-control"), done.headers.get("referrer-policy")]).toEqual([200, "no-store", "no-referrer"]);
		expect(done.headers.get("set-cookie")).toMatch(/^dotz_local=[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/);
		expect(await done.json()).toEqual({ state: "allowed" });
		expect(await status("/api/state", { headers: { cookie: cookieOf(done) } })).toBe(200);
		const again = await poll(id);
		expect([await again.json(), again.headers.get("set-cookie")]).toEqual([{ state: "expired" }, null]);
	});

	test("the cookie goes only to the holder of the id", async () => {
		const { id } = await begin();
		await answer("allow");
		for (const wrong of ["", "nope", "A".repeat(43)]) {
			const r = await poll(wrong);
			expect([await r.json(), r.headers.get("set-cookie")]).toEqual([{ state: "expired" }, null]);
		}
		expect((await poll(id)).headers.get("set-cookie")).toBeString();
	});

	test("a no and an unavailable dialog are told to the page", async () => {
		const first = await begin();
		await answer("deny");
		expect(await stateOf(first.id)).toBe("denied");
		localLogin.clear();
		const second = await begin();
		await answer("unavailable");
		expect(await stateOf(second.id)).toBe("unavailable");
		expect((await poll(second.id)).headers.get("set-cookie")).toBeNull();
	});

	test("only a browser on this computer, in local mode, from its own origin, reaches the dialog", async () => {
		for (const [headers, base, ip] of NOT_LOCAL) {
			const o = { base, ip, headers };
			expect([headers, base, ip, await status("/local-login/request", { ...o, method: "POST", headers: { ...sameOrigin(base), ...headers } })]).toEqual([headers, base, ip, 403]);
			expect([headers, base, ip, await status("/local-login/status?id=x", o)]).toEqual([headers, base, ip, 403]);
		}
		expect(await status("/local-login/request", { method: "POST" })).toBe(403);
		expect(await status("/local-login/request", { method: "POST", headers: { origin: "https://evil.com" } })).toBe(403);
		expect(await status("/local-login/request", { method: "POST", headers: { origin: "null" } })).toBe(403);
		await setMode("tailscale");
		expect(await status("/local-login/request", { method: "POST", headers: sameOrigin() })).toBe(403);
		expect(await status("/local-login/status?id=x")).toBe(403);
		await setMode("local");
		expect(asked).toEqual([]);
	});

	test("a status read may come without an Origin, a peer request never reaches the dialog", async () => {
		const { id } = await begin();
		expect(await status(`/local-login/status?id=${id}`)).toBe(200);
		mkdirSync(join(DATA, "secrets"), { recursive: true });
		writeFileSync(PEER_FILE, PEER);
		const peer = { "x-dotz-peer": PEER, "tailscale-user-login": OWNER, ...sameOrigin() };
		expect(await status("/local-login/request", { method: "POST", headers: peer })).not.toBe(200);
		expect(await status(`/local-login/status?id=${id}`, { headers: peer })).not.toBe(200);
		expect(asked).toHaveLength(1);
	});

	test("the login page is for a navigation of a browser on this computer only", async () => {
		const r = await hit("/", { headers: html });
		expect([r.status, r.headers.get("content-type"), r.headers.get("cache-control")]).toEqual([403, "text/html; charset=utf-8", "no-store"]);
		expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
		const page = await r.text();
		expect(page).toContain("<button");
		for (const word of ["터미널", "토큰", "쿠키", "bun "]) expect(page).not.toContain(word);
		for (const [headers, base, ip] of [[html, "http://dotz.test"], [html, "http://rebind.evil.com:7420"], [html, undefined, "192.168.0.7"], [{ ...html, "x-forwarded-for": "203.0.113.9" }], [{ accept: "application/json" }], [{}]] as [Record<string, string>, string?, string?][]) {
			const plain = await hit("/", { headers, base, ip });
			expect([headers, base, ip, plain.status, plain.headers.get("content-type"), await plain.text()]).toEqual([headers, base, ip, 403, "text/plain; charset=utf-8", HINT]);
		}
		const post = await hit("/api/state", { method: "POST", headers: html });
		expect(post.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	});

	test("the page escapes the assistant's name", () => {
		const page = loginPage("<script>alert(1)</script>");
		expect(page).not.toContain("<script>alert(1)");
		expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt; 로그인");
	});
});

describe("local-login-dialog", () => {
	const HOSTILE = '"; do shell script "x';
	const none = () => null;

	test("the number and the name are argv items on macOS, never part of the script", () => {
		const argv = dialogCommand("darwin", "4821", HOSTILE, none);
		expect(argv).toEqual(["osascript", "-e", MAC_SCRIPT, "4821", HOSTILE]);
		expect(MAC_SCRIPT).not.toContain("4821");
		expect(MAC_SCRIPT).not.toContain("shell script");
	});

	test("on Linux zenity wins over kdialog, the name stays inside its own item, and no shell is involved", () => {
		const zenity = dialogCommand("linux", "4821", HOSTILE, bin => bin);
		expect(zenity?.[0]).toBe("zenity");
		expect(zenity).toContain(`--title=${HOSTILE} 로그인`);
		expect(zenity?.filter(a => a.includes("shell script"))).toHaveLength(1);
		expect(zenity?.filter(a => a.includes("4821"))).toHaveLength(1);
		const kdialog = dialogCommand("linux", "4821", HOSTILE, bin => (bin === "kdialog" ? bin : null));
		expect(kdialog?.[0]).toBe("kdialog");
		expect(kdialog).toContain(`${HOSTILE} 로그인`);
		expect(dialogCommand("linux", "4821", HOSTILE, none)).toBeUndefined();
		expect(dialogCommand("win32", "4821", HOSTILE, bin => bin)).toBeUndefined();
	});

	test("Linux without a display has no dialog to offer, so the page says unavailable instead of denied", () => {
		const which = (bin: string) => bin;
		expect(dialogCommand("linux", "4821", "n", dialogFinder("linux", {}, which))).toBeUndefined();
		expect(dialogCommand("linux", "4821", "n", dialogFinder("linux", { WAYLAND_DISPLAY: "wayland-0" }, which))?.[0]).toBe("zenity");
		expect(dialogCommand("darwin", "4821", "n", dialogFinder("darwin", {}, which))?.[0]).toBe("osascript");
	});

	test("what the exit means: a no and a cancel deny, anything else is unavailable", () => {
		const cases: [NodeJS.Platform, number | null, string, string, DialogAnswer][] = [
			["darwin", 0, "허용\n", "", "allow"],
			["darwin", 0, "거부\n", "", "deny"],
			["darwin", 0, "timeout\n", "", "deny"],
			["darwin", 1, "", "execution error: User canceled. (-128)", "deny"],
			["darwin", 1, "", "execution error: No user interaction allowed. (-1713)", "unavailable"],
			["linux", 0, "", "", "allow"],
			["linux", 1, "", "", "deny"],
			["linux", 5, "", "", "deny"],
			["linux", 127, "", "", "unavailable"],
			["linux", null, "", "", "unavailable"],
		];
		for (const [platform, code, out, err, want] of cases) expect([platform, code, dialogAnswer(platform, code, out, err)]).toEqual([platform, code, want]);
	});
});

describe("createLocalLogin requests", () => {
	const tmp = mkdtempSync(join(tmpdir(), "local-login-ask-"));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));
	let t = 5_000_000;
	let settle: (a: DialogAnswer) => void = () => {};
	let dialogs = 0;
	const ll = createLocalLogin({
		dir: tmp,
		now: () => t,
		confirm: () => {
			dialogs++;
			return new Promise<DialogAnswer>(resolve => {
				settle = resolve;
			});
		},
	});
	const call = (path: string, method = "GET") => {
		const req = new Request(`${BASE}${path}`, { method, headers: { origin: BASE } });
		const url = new URL(req.url);
		return method === "POST" ? ll.request(req, url, "local", "127.0.0.1") : ll.status(req, url, "local", "127.0.0.1");
	};
	const begin = () => call("/local-login/request", "POST");
	const stateOf = async (id: string) => ((await call(`/local-login/status?id=${id}`).json()) as { state: string }).state;
	const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;
	const answerNow = async (a: DialogAnswer) => {
		settle(a);
		await Promise.resolve();
	};

	test("only one request waits at a time; the second is 429 and does not open another dialog", async () => {
		const first = await begin();
		expect(first.status).toBe(200);
		const second = await begin();
		expect([second.status, await second.json()]).toEqual([429, { error: "pending" }]);
		expect(dialogs).toBe(1);
		await answerNow("allow");
		expect(await stateOf(await idOf(first))).toBe("allowed");
		ll.clear();
	});

	test("after a no a new request waits 3 seconds", async () => {
		const id = await idOf(await begin());
		await answerNow("deny");
		expect(await stateOf(id)).toBe("denied");
		const before = dialogs;
		const early = await begin();
		expect([early.status, await early.json()]).toEqual([429, { error: "wait" }]);
		t += 2999;
		expect((await begin()).status).toBe(429);
		t += 1;
		expect((await begin()).status).toBe(200);
		expect(dialogs).toBe(before + 1);
		ll.clear();
	});

	test("a request expires after 120 seconds, a late answer gets no cookie, and the next request waits 3 seconds from the expiry", async () => {
		const id = await idOf(await begin());
		t += 119_999;
		expect(await stateOf(id)).toBe("pending");
		t += 1;
		expect(await stateOf(id)).toBe("expired");
		await answerNow("allow");
		const late = call(`/local-login/status?id=${id}`);
		expect([await late.json(), late.headers.get("set-cookie")]).toEqual([{ state: "expired" }, null]);
		expect((await begin()).status).toBe(429);
		t += 3000;
		expect((await begin()).status).toBe(200);
		ll.clear();
	});

	test("a rejected dialog is unavailable", async () => {
		const broken = createLocalLogin({ dir: tmp, now: () => t, confirm: () => Promise.reject(new Error("spawn failed")) });
		const req = new Request(`${BASE}/local-login/request`, { method: "POST", headers: { origin: BASE } });
		const id = await idOf(broken.request(req, new URL(req.url), "local", "127.0.0.1"));
		await Promise.resolve();
		const probe = new Request(`${BASE}/local-login/status?id=${id}`);
		const r = broken.status(probe, new URL(probe.url), "local", "127.0.0.1");
		expect(await r.json()).toEqual({ state: "unavailable" });
	});
});

// `dotz` (hub/dotz-command.ts): the one-time link gets a browser on this computer in whatever mode the gateway is in; nothing else changed for anyone else.
describe("로컬 진입 (모든 모드)", () => {
	const FAKE = join(DATA, "fake-cloudflared.sh");
	const HOST = "dotz.example.com";
	const previousBin = process.env.DOTZ_CLOUDFLARED_BIN;
	const enter = async (mode: string) => {
		if (mode !== "cloudflare") return setMode(mode);
		writeFileSync(FAKE, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
		process.env.DOTZ_CLOUDFLARED_BIN = FAKE;
		await webAccess.change({ mode, hostname: HOST, token: "tunnel-token-for-the-test-0123456789" });
	};
	afterAll(async () => {
		await webAccess.change({ mode: "local", hostname: "", token: "" });
		if (previousBin === undefined) delete process.env.DOTZ_CLOUDFLARED_BIN;
		else process.env.DOTZ_CLOUDFLARED_BIN = previousBin;
	});

	for (const mode of ["tailscale", "cloudflare", "local"]) {
		describe(mode, () => {
			beforeAll(() => enter(mode));
			beforeEach(() => ALLOW.delete(OWNER));

			test("no open loopback: without a token or a cookie nothing gets in", async () => {
				expect(await status("/api/state")).not.toBe(200);
				expect(await status("/local-login?code=wrong")).toBe(403);
				expect(await status("/local-login")).toBe(403);
			});

			test("a loopback request with a valid token becomes a session, and the token is single use", async () => {
				const path = await linkPath();
				const first = await hit(path);
				expect([first.status, first.headers.get("location")]).toEqual([303, "/"]);
				const cookie = cookieOf(first);
				expect(first.headers.get("set-cookie")).toContain("HttpOnly");
				expect(first.headers.get("set-cookie")).toContain("SameSite=Strict");
				expect(await status("/api/state", { headers: { cookie } })).toBe(200);
				expect(await status(path)).toBe(403);
			});

			test("a request through a tunnel, a proxy or a rebound name redeems nothing and does not burn the token", async () => {
				const path = await linkPath();
				for (const header of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded", "x-real-ip", "cf-connecting-ip", "cf-ray", "tailscale-user-login", "via", "true-client-ip"]) expect(await status(path, { headers: { [header]: "203.0.113.9" } })).toBe(403);
				for (const base of ["https://box.example.ts.net", `https://${HOST}`, `http://rebind.example.com:${PORT}`, "http://127.0.0.1.nip.io"]) expect(await status(path, { base })).toBe(403);
				expect(await status(path, { ip: "100.64.0.9" })).toBe(403);
				expect(await status(path)).toBe(303);
			});

			test("the session counts only for a genuine local request", async () => {
				const cookie = await session();
				expect(await status("/api/state", { headers: { cookie, "x-forwarded-for": "203.0.113.9" } })).not.toBe(200);
				expect(await status("/api/state", { headers: { cookie, "cf-ray": "abc" } })).not.toBe(200);
				expect(await status("/api/state", { headers: { cookie }, base: `https://${HOST}` })).not.toBe(200);
				expect(await status("/api/state", { headers: { cookie }, ip: "100.64.0.9" })).not.toBe(200);
				expect(await status("/api/state", { headers: { cookie, origin: "https://evil.example" } })).not.toBe(200);
				expect(await status("/api/state", { headers: { cookie, "sec-fetch-site": "cross-site" } })).not.toBe(200);
			});
		});
	}

	test("a mode change voids every loopback session and token, not only those of local mode", async () => {
		await setMode("tailscale");
		const cookie = await session();
		const path = await linkPath();
		await enter("cloudflare");
		expect(await status("/api/state", { headers: { cookie } })).not.toBe(200);
		expect(await status(path)).toBe(403);
		await setMode("tailscale");
		expect(await status("/api/state", { headers: { cookie } })).toBe(403);
	});

	test("outside local mode the login page's dialog stays closed: only the hub token opens loopback", async () => {
		await setMode("tailscale");
		asked.length = 0;
		const r = await status("/local-login/request", { method: "POST", headers: { origin: BASE } });
		expect(r).toBe(403);
		expect(asked).toEqual([]);
	});

	test("an expired token is refused, and a session of another mode (or of an older file) does not count", () => {
		const dir = mkdtempSync(join(tmpdir(), "dotz-loopback-"));
		let clock = 1_000_000;
		const login = createLocalLogin({ dir, now: () => clock });
		const request = (code: string) => new Request(`${BASE}/local-login?code=${code}`);
		const url = (code: string) => new URL(request(code).url);
		const code = login.mint();
		clock += 5 * 60_000;
		expect(login.page(request(code), url(code), "tailscale", "127.0.0.1").status).toBe(403);

		const good = login.mint();
		const answered = login.page(request(good), url(good), "tailscale", "127.0.0.1");
		const cookie = cookieOf(answered);
		const browser = new Request(`${BASE}/`, { headers: { cookie } });
		expect([login.verify(browser, "tailscale"), login.verify(browser, "cloudflare"), login.verify(browser, "local")]).toEqual([true, false, false]);

		const hash = JSON.parse(readFileSync(join(dir, "web-local-sessions.json"), "utf8")).sessions[0].hash;
		writeFileSync(join(dir, "web-local-sessions.json"), JSON.stringify({ sessions: [{ hash, expires_at: clock + 1000 }] }));
		const older = createLocalLogin({ dir, now: () => clock });
		expect([older.verify(browser, "tailscale"), older.verify(browser, "local")]).toEqual([false, true]);
		older.keepMode("tailscale");
		expect(createLocalLogin({ dir, now: () => clock }).verify(browser, "local")).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});
