import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { log } from "./config.ts";
import { json } from "./routes-util.ts";
import { localBrowser, type WebMode } from "./web-access.ts";

// web.access "local" (이 컴퓨터만) keeps a login: a one-time link, minted from the terminal with the hub token (hub/web-login-cli.ts), trades a
// short-lived single-use code for a 30-day `dotz_local` cookie. The cookie only counts while localBrowser() (hub/web-access.ts) also holds.
// Codes live in memory only (a restart kills open links); sessions are kept as sha256 in web-local-sessions.json (0600) so a restart keeps them.
// KNOWN RESIDUAL RISK: cookies are not port-isolated, so another service listening on 127.0.0.1 receives this cookie if the browser visits it.
// The cookie is HttpOnly + SameSite=Strict and only matches while the gateway is in local mode, but it is not a defense against that service.

const CODE_TTL_MS = 5 * 60_000;
const SESSION_TTL_S = 30 * 24 * 3600;
const MAX_CODES = 5;
const MAX_SESSIONS = 10;
const COOKIE = "dotz_local";
const DENIED_TEXT = "링크가 만료됐거나 이미 썼어요. 터미널에서 다시 받아 주세요.";
const LOGIN_HINT = "이 컴퓨터만 모드예요. 터미널에서 bun hub/web-login-cli.ts 를 실행해 로그인 링크를 받아 주세요.";
const TEXT = { "Content-Type": "text/plain; charset=utf-8" };

type Session = { hash: string; expires_at: number };
export type LinkContext = { mode: WebMode; port: number; tokenOk: boolean };

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

export function createLocalLogin(deps: { dir: string; now?: () => number }) {
	const now = deps.now ?? Date.now;
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

	/** Trades a code for a session token. Taking the code out of the map is synchronous, so a second redeem of it finds nothing. */
	const redeem = (code: string): string | undefined => {
		const h = sha256(code);
		const exp = codes.get(h);
		codes.delete(h);
		if (exp === undefined || exp <= now()) return undefined;
		const token = secret();
		sessions = [...sessions.filter(s => s.expires_at > now()), { hash: sha256(token), expires_at: now() + SESSION_TTL_S * 1000 }].slice(-MAX_SESSIONS);
		persist();
		return token;
	};

	const verify = (req: Request): boolean => {
		const token = (req.headers.get("cookie") ?? "").split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
		if (!token) return false;
		const h = sha256(token);
		return sessions.some(s => s.hash === h && s.expires_at > now());
	};

	const clear = (): void => {
		codes.clear();
		sessions = [];
		rmSync(file, { force: true });
	};

	const denied = (): Response => new Response(DENIED_TEXT, { status: 403, headers: { ...TEXT, "Cache-Control": "no-store" } });

	return {
		mint,
		redeem,
		verify,
		clear,
		/** The answer to an unauthenticated request while the mode is local: how to get a link. */
		hint: (): Response => new Response(LOGIN_HINT, { status: 403, headers: TEXT }),
		/** GET /local-login?code=, before the owner check. Every failure is the same answer, so nothing says which check failed. */
		page(req: Request, url: URL, mode: WebMode, peerIp: string | undefined): Response {
			const prefetch = (req.headers.get("sec-purpose") ?? "").toLowerCase().includes("prefetch");
			if (mode !== "local" || !localBrowser(req, peerIp) || prefetch) return denied();
			const token = redeem(url.searchParams.get("code") ?? "");
			if (!token) return denied();
			return new Response(null, {
				status: 303,
				headers: { Location: "/", "Set-Cookie": `${COOKIE}=${token}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Strict`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
			});
		},
		/** POST /api/web-access/login-link: only the hub token mints (a browser session cookie must not); the code is never logged. */
		loginLink(req: Request, url: URL, ctx: LinkContext): Response | undefined {
			if (url.pathname !== "/api/web-access/login-link") return undefined;
			if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
			if (!ctx.tokenOk) return new Response("forbidden", { status: 403 });
			if (ctx.mode !== "local") return json({ error: "이 컴퓨터만 모드일 때만 로그인 링크를 만들 수 있어요" }, 409);
			return json({ url: `http://127.0.0.1:${ctx.port}/local-login?code=${mint()}`, expires_at: new Date(now() + CODE_TTL_MS).toISOString() });
		},
	};
}

export type LocalLogin = ReturnType<typeof createLocalLogin>;
