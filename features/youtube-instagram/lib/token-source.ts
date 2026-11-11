// External token source (docs/youtube-instagram.md): a user who keeps the long-lived Instagram token or the YouTube token somewhere the
// gateway cannot reach (the macOS keychain, another app's file) names a file or a command in config.json (`token_source`). The login keeper
// (bin/tokens.ts) reads it and updates the dotz copy in the secrets folder one way; nothing is ever written back. The source is read as the
// gateway user, so a keychain-backed one is a file that a script run in the owner's own session keeps up to date.
// Instagram follows the rules of the old keeper: look only when the dotz copy is due (older than 7 days or expiring within 20 days, and
// at least 24 h old), take a token only after GET /me accepted it for the same account, and count failed runs; the 2nd in a row is the notice.
// With a source the dotz copy is not refreshed by dotz itself (bin/tokens.ts): the source's owner refreshes, a source that stays behind is a failure.
// Secrets are never printed: errors name the step, not the content.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, type Ctx, type InstagramSecret, paths, readJson, type TokenSource, type YoutubeAccess, type YoutubeOauth, writeJson } from "./config.ts";
import { clearPublishMissing } from "./ig-publish.ts";
import { me, refreshDue } from "./instagram.ts";
import { AuthError, TokenSourceError, TransientError } from "./watchkit.ts";
import { accessToken } from "./youtube.ts";

export const FAILS_BEFORE_NOTICE = 2;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 64 * 1024;

export type SyncResult = { synced: boolean };
type Parsed = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const iso = (v: unknown): string | undefined => {
	const s = str(v);
	return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined;
};

async function readRaw(ctx: Ctx, label: string, src: TokenSource): Promise<string> {
	if (src.command) {
		let r: Awaited<ReturnType<Ctx["exec"]>>;
		try {
			r = await ctx.exec(src.command, { timeoutMs: COMMAND_TIMEOUT_MS });
		} catch {
			throw new TokenSourceError(`${label} 토큰 원본 명령을 실행하지 못했어요`);
		}
		if (r.code !== 0) throw new TokenSourceError(`${label} 토큰 원본 명령이 ${r.code}로 끝났어요`);
		return r.stdout;
	}
	const file = (src.file ?? "").replace(/^~(?=\/)/, ctx.env.HOME || homedir());
	if (!file || !existsSync(file)) throw new TokenSourceError(`${label} 토큰 원본 파일이 없어요`);
	try {
		const text = readFileSync(file, "utf8");
		if (text.length > MAX_SOURCE_BYTES) throw new Error("large");
		return text;
	} catch {
		throw new TokenSourceError(`${label} 토큰 원본 파일을 읽지 못했어요`);
	}
}

// JSON object or (for Instagram) a bare token on one line.
function parse(raw: string, label: string, bare: boolean): Parsed {
	const t = raw.trim();
	if (t.startsWith("{")) {
		try {
			const v = JSON.parse(t);
			if (v && typeof v === "object" && !Array.isArray(v)) return v as Parsed;
		} catch {}
		throw new TokenSourceError(`${label} 토큰 원본이 올바른 JSON이 아니에요`);
	}
	if (bare && t && !/\s/.test(t)) return { access_token: t };
	throw new TokenSourceError(`${label} 토큰 원본에서 토큰을 찾지 못했어요`);
}

// The failed-run counter lives next to the watch state.
const memoFile = (ctx: Ctx, platform: string) => (ctx.env.DOTZ_WATCH_STATE_DIR ? join(ctx.env.DOTZ_WATCH_STATE_DIR, `token-source-${platform}.json`) : undefined);
function readFails(ctx: Ctx, platform: string): number {
	const f = memoFile(ctx, platform);
	try {
		return (f ? Number(readJson<{ fails?: number }>(f)?.fails) : 0) || 0;
	} catch {
		return 0;
	}
}
function writeFails(ctx: Ctx, platform: string, fails: number): void {
	const f = memoFile(ctx, platform);
	if (f) writeJson(f, { fails });
}

// Runs one sync; a TokenSourceError is counted and thrown from the 2nd failed run in a row, a success resets the count. Network trouble
// (TransientError) is neither: it passes through for the watch runner to absorb.
async function counted(ctx: Ctx, platform: string, body: () => Promise<SyncResult>): Promise<SyncResult> {
	const before = readFails(ctx, platform);
	try {
		const result = await body();
		if (before) writeFails(ctx, platform, 0);
		return result;
	} catch (e) {
		if (!(e instanceof TokenSourceError)) throw e;
		writeFails(ctx, platform, before + 1);
		if (before + 1 >= FAILS_BEFORE_NOTICE) throw e;
		return { synced: false };
	}
}

export function syncInstagramSource(ctx: Ctx, cfg: Config): Promise<SyncResult> {
	const src = cfg.instagram?.token_source;
	if (!src || !cfg.instagram) return Promise.resolve({ synced: false });
	const account = cfg.instagram;
	return counted(ctx, "instagram", async () => {
		const cur = readJson<InstagramSecret>(paths.instagram());
		if (cur && !refreshDue(cur, ctx.now())) return { synced: false };
		const p = parse(await readRaw(ctx, "인스타", src), "인스타", true);
		const token = str(p.access_token) ?? str(p.token);
		if (!token) throw new TokenSourceError("인스타 토큰 원본에서 토큰을 찾지 못했어요");
		const issued = iso(p.obtained_at) ?? iso(p.refreshedAt);
		if (cur && (token === cur.access_token || (issued && Date.parse(issued) <= Date.parse(cur.obtained_at)))) throw new TokenSourceError("인스타 토큰 원본이 아직 갱신되지 않았어요");
		let who: Awaited<ReturnType<typeof me>>;
		try {
			who = await me(ctx, token);
		} catch (e) {
			if (e instanceof AuthError) throw new TokenSourceError("인스타 토큰 원본의 토큰을 인스타가 받아 주지 않아요");
			if (e instanceof TransientError) throw e;
			throw new TokenSourceError("인스타 토큰 원본의 토큰을 확인하지 못했어요");
		}
		if (who.user_id !== account.user_id) throw new TokenSourceError("인스타 토큰 원본이 연결한 계정의 토큰이 아니에요");
		const expires = iso(p.expires_at) ?? iso(p.expiresAt);
		writeJson(paths.instagram(), { access_token: token, user_id: who.user_id, username: who.username, obtained_at: issued ?? ctx.now().toISOString(), ...(expires ? { expires_at: expires } : {}) } satisfies InstagramSecret, true);
		clearPublishMissing(); // a new token may carry instagram_business_content_publish
		return { synced: true };
	});
}

export function syncYoutubeSource(ctx: Ctx, cfg: Config): Promise<SyncResult> {
	const src = cfg.youtube?.token_source;
	if (!src) return Promise.resolve({ synced: false });
	return counted(ctx, "youtube", async () => {
		const p = parse(await readRaw(ctx, "유튜브", src), "유튜브", false);
		const refresh = str(p.refresh_token);
		if (!refresh) throw new TokenSourceError("유튜브 토큰 원본에서 refresh_token을 찾지 못했어요");
		const prev = readJson<YoutubeOauth>(paths.ytOauth());
		if (refresh === prev?.refresh_token) return { synced: false };
		const client_id = str(p.client_id) ?? prev?.client_id;
		const client_secret = str(p.client_secret) ?? prev?.client_secret;
		if (!client_id || !client_secret) throw new TokenSourceError("유튜브 토큰 원본에 client_id와 client_secret이 없어요");
		const prevAccess = readJson<YoutubeAccess>(paths.ytAccess());
		const restore = () => {
			if (prev) writeJson(paths.ytOauth(), prev, true);
			else rmSync(paths.ytOauth(), { force: true });
			if (prevAccess) writeJson(paths.ytAccess(), prevAccess, true);
			else rmSync(paths.ytAccess(), { force: true });
		};
		writeJson(paths.ytOauth(), { client_id, client_secret, refresh_token: refresh } satisfies YoutubeOauth, true);
		rmSync(paths.ytAccess(), { force: true });
		try {
			await accessToken(ctx); // a real exchange: the new refresh token has to work before it stays
		} catch (e) {
			restore();
			if (e instanceof AuthError) throw new TokenSourceError("유튜브 토큰 원본의 토큰을 구글이 받아 주지 않아요");
			if (e instanceof TransientError) throw e;
			throw new TokenSourceError("유튜브 토큰 원본의 토큰을 확인하지 못했어요");
		}
		return { synced: true };
	});
}
