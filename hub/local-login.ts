import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { log, NAME } from "./config.ts";
import { type Confirm, nativeConfirm } from "./local-login-dialog.ts";
import { LOGIN_PAGE_CSP, loginPage } from "./local-login-page.ts";
import { json } from "./routes-util.ts";
import { localBrowser, type WebMode } from "./web-access.ts";

// A browser on this computer logs in here, ending in a 30-day `dotz_local` cookie that only counts while localBrowser() (hub/web-access.ts) also holds and
// the gateway is in the mode it was issued in. The remote modes keep their own gates and cookies (tailscale identity, `dotz_dev`); nothing here serves them.
// 1. The login page (web.access "local", 이 컴퓨터만, only) (hub/local-login-page.ts): its button POSTs /local-login/request, the gateway (which runs as the owner) shows a native
//    confirmation with the same 4-digit number on the desktop (hub/local-login-dialog.ts), and the page polls /local-login/status; the browser
//    that holds the request id gets the cookie once, after the owner allowed it. One request at a time, a 3 s pause after a no.
// 2. A one-time link, in every mode: minted with the hub token by a request on this computer (the `dotz` command and the bot, hub/web-login-cli.ts,
//    POST /api/web-access/login-link), it trades a short-lived single-use code for the cookie.
// The cookie has no Secure flag: http://127.0.0.1 is plain HTTP, the traffic never leaves this computer.
// Codes and requests live in memory only (a restart kills them); sessions are kept as sha256 in web-local-sessions.json (0600) so a restart keeps them.
// KNOWN RESIDUAL RISK: cookies are not port-isolated, so another service listening on 127.0.0.1 receives this cookie if the browser visits it.
// The cookie is HttpOnly + SameSite=Strict and only matches a request on this gateway's mode, but it is not a defense against that service.

const CODE_TTL_MS = 5 * 60_000;
const SESSION_TTL_S = 30 * 24 * 3600;
const MAX_CODES = 5;
const MAX_SESSIONS = 10;
const COOKIE = "dotz_local";
const REQUEST_TTL_MS = 120_000;
const COOLDOWN_MS = 3000;
const DENIED_TEXT = "링크가 만료됐거나 이미 썼어요. 터미널에서 dotz를 다시 실행해 주세요.";
const LOGIN_HINT = "이 컴퓨터만 모드예요. 브라우저에서 이 주소를 열어 로그인해 주세요.";
const TEXT = { "Content-Type": "text/plain; charset=utf-8" };
const NO_STORE = { "Cache-Control": "no-store" };
const HTML = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": LOGIN_PAGE_CSP, ...NO_STORE };

// A session file from before `mode` existed holds only local-mode sessions.
type Session = { hash: string; expires_at: number; mode?: WebMode };
type Ask = { hash: string; expires_at: number; state: "pending" | "allowed" | "denied" | "unavailable" };
export type LinkContext = { port: number; tokenOk: boolean; local: boolean };

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");

function readSessions(file: string, nowMs: number): Session[] {
	try {
		const v = JSON.parse(readFileSync(file, "utf8")) as { sessions?: unknown };
		if (!Array.isArray(v.sessions)) return [];
		return v.sessions.filter((s): s is Session => typeof s?.hash === "string" && typeof s?.expires_at === "number" && s.expires_at > nowMs).slice(-MAX_SESSIONS);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`web-local-sessions.json unreadable, no local sessions: ${(e as Error).name}`);
		return [];
	}
}

export function createLocalLogin(deps: { dir: string; now?: () => number; confirm?: Confirm }) {
	const now = deps.now ?? Date.now;
	const confirm = deps.confirm ?? nativeConfirm;
	const file = join(deps.dir, "web-local-sessions.json");
	const codes = new Map<string, number>();
	let sessions = readSessions(file, now());

	function persist(): void {
		try {
			mkdirSync(deps.dir, { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, file);
		} catch (e) {
			log(`web-local-sessions.json not saved, sessions last until restart: ${(e as Error).name}`);
		}
	}

	const mint = (): string => {
		for (const [h, exp] of codes) if (exp <= now()) codes.delete(h);
		while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value as string);
		const code = secret();
		codes.set(sha256(code), now() + CODE_TTL_MS);
		return code;
	};

	const issue = (mode: WebMode): string => {
		const token = secret();
		sessions = [...sessions.filter(s => s.expires_at > now()), { hash: sha256(token), expires_at: now() + SESSION_TTL_S * 1000, mode }].slice(-MAX_SESSIONS);
		persist();
		return token;
	};

	/** Trades a code for a session token. Taking the code out of the map is synchronous, so a second redeem of it finds nothing. */
	const redeem = (code: string, mode: WebMode): string | undefined => {
		const h = sha256(code);
		const exp = codes.get(h);
		codes.delete(h);
		return exp === undefined || exp <= now() ? undefined : issue(mode);
	};

	const cookieHeaders = (token: string): Record<string, string> => ({ "Set-Cookie": `${COOKIE}=${token}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Strict`, ...NO_STORE, "Referrer-Policy": "no-referrer" });

	// The one request on the login page: asked, then answered by the dialog. `wait` is when the next one may start.
	let ask: Ask | undefined;
	let wait = 0;
	const drop = (): void => {
		if (ask && ask.expires_at <= now()) {
			if (ask.state === "pending") wait = Math.max(wait, ask.expires_at + COOLDOWN_MS);
			ask = undefined;
		}
	};
	const settle = (mine: Ask, answer: "allow" | "deny" | "unavailable"): void => {
		drop();
		if (ask !== mine) return;
		mine.state = answer === "allow" ? "allowed" : answer === "deny" ? "denied" : "unavailable";
		if (answer !== "allow") wait = now() + COOLDOWN_MS;
	};
	const answer = (body: object, status = 200, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...extra } });
	const refused = (): Response => answer({ error: "forbidden" }, 403);

	const verify = (req: Request, mode: WebMode): boolean => {
		const token = (req.headers.get("cookie") ?? "").split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
		if (!token) return false;
		const h = sha256(token);
		return sessions.some(s => s.hash === h && s.expires_at > now() && (s.mode ?? "local") === mode);
	};

	const clear = (): void => {
		codes.clear();
		sessions = [];
		ask = undefined;
		wait = 0;
		rmSync(file, { force: true });
	};

	/** At start: a mode edited while the gateway was off never went through clear(). */
	const keepMode = (mode: WebMode): void => {
		const kept = sessions.filter(s => (s.mode ?? "local") === mode);
		if (kept.length === sessions.length) return;
		sessions = kept;
		persist();
	};

	const denied = (): Response => new Response(DENIED_TEXT, { status: 403, headers: { ...TEXT, "Cache-Control": "no-store" } });

	return {
		mint,
		redeem,
		verify,
		clear,
		keepMode,
		/** The cookie headers of a new session, made the way the one-time login link makes one (mint, redeem): the first-run onboarding hands its browser this. */
		sessionHeaders: (): Record<string, string> => cookieHeaders(redeem(mint(), "local") as string),
		/** The answer to an unauthenticated request while the mode is local: the login page for a navigation of a browser on this computer, else a plain line. */
		hint(req: Request, peerIp: string | undefined): Response {
			const navigation = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html") && localBrowser(req, peerIp);
			return navigation ? new Response(loginPage(NAME), { status: 403, headers: HTML }) : new Response(LOGIN_HINT, { status: 403, headers: TEXT });
		},
		/** POST /local-login/request, before the owner check: starts the native confirmation (not awaited) and answers the id and the number shown in it. */
		request(req: Request, url: URL, mode: WebMode, peerIp: string | undefined): Response {
			if (mode !== "local" || !localBrowser(req, peerIp) || req.headers.get("origin") !== url.origin) return refused();
			drop();
			if (ask?.state === "pending") return answer({ error: "pending" }, 429);
			if (now() < wait) return answer({ error: "wait" }, 429);
			const id = secret();
			const number = String(randomInt(10_000)).padStart(4, "0");
			const mine: Ask = { hash: sha256(id), expires_at: now() + REQUEST_TTL_MS, state: "pending" };
			ask = mine;
			confirm(number).then(a => settle(mine, a), () => settle(mine, "unavailable"));
			return answer({ id, number });
		},
		/** GET /local-login/status?id=, before the owner check: the cookie goes to the holder of the id, once, after the owner allowed it. */
		status(req: Request, url: URL, mode: WebMode, peerIp: string | undefined): Response {
			if (mode !== "local" || !localBrowser(req, peerIp)) return refused();
			drop();
			const mine = ask && ask.hash === sha256(url.searchParams.get("id") ?? "") ? ask : undefined;
			if (!mine) return answer({ state: "expired" });
			if (mine.state !== "allowed") return answer({ state: mine.state });
			ask = undefined;
			return answer({ state: "allowed" }, 200, cookieHeaders(issue("local")));
		},
		/** GET /local-login?code=, before the owner check. Every failure is the same answer, so nothing says which check failed. */
		page(req: Request, url: URL, mode: WebMode, peerIp: string | undefined): Response {
			const prefetch = (req.headers.get("sec-purpose") ?? "").toLowerCase().includes("prefetch");
			if (!localBrowser(req, peerIp) || prefetch) return denied();
			const token = redeem(url.searchParams.get("code") ?? "", mode);
			if (!token) return denied();
			return new Response(null, { status: 303, headers: { Location: "/", ...cookieHeaders(token) } });
		},
		/** POST /api/web-access/login-link: only the hub token, on this computer, mints (a browser session cookie must not); the code is never logged. */
		loginLink(req: Request, url: URL, ctx: LinkContext): Response | undefined {
			if (url.pathname !== "/api/web-access/login-link") return undefined;
			if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
			if (!ctx.tokenOk || !ctx.local) return new Response("forbidden", { status: 403 });
			const res = json({ url: `http://127.0.0.1:${ctx.port}/local-login?code=${mint()}`, expires_at: new Date(now() + CODE_TTL_MS).toISOString() });
			res.headers.set("Cache-Control", "no-store");
			return res;
		},
	};
}

