// Refresh tokens of a Google OAuth app in testing mode die 7 days after they were granted. The login keeper (bin/tokens.ts) asks the
// owner's Aside browser for the consent again on day 6, through the same background-tab flow as the first login (setup.ts
// youtube-auth --reuse with lib/pages.ts gcpConsentFlow), and stores the new refresh token. A production app is never touched.
// Two failed attempts in a row are reported as a failing check, which the YouTube app lists under its internal features.
import { existsSync, statSync } from "node:fs";
import { defaultLoopback, type Loopback, run as setupRun } from "../bin/setup.ts";
import { type Config, type Ctx, paths, readJson, type YoutubeOauth } from "./config.ts";
import { gcpConsentFlow, type PageResult, pageBody } from "./pages.ts";
import type { Aside } from "./studio.ts";
import { AuthError } from "./watchkit.ts";
import { accessToken } from "./youtube.ts";

export const RECONSENT_AFTER_DAYS = 6;
export const FAILS_BEFORE_NOTICE = 2;
const DAY_MS = 86_400_000;
const FLOW_WAIT_MS = 100_000;
const GRACE_MS = 30_000;

export type KeeperState = { reconsent_fails: number };
export type Reconsent = () => Promise<boolean>;

const oauthOf = (): YoutubeOauth | undefined => {
	try {
		return readJson<YoutubeOauth>(paths.ytOauth());
	} catch {
		return undefined;
	}
};

// An explicit youtube.oauth_mode wins; else a refresh token that carries an expiry (Google sends one only in testing mode) means testing.
export function testingMode(cfg: Config, oauth: YoutubeOauth | undefined): boolean {
	if (cfg.youtube?.oauth_mode) return cfg.youtube.oauth_mode === "testing";
	return Boolean(oauth?.refresh_expires_at);
}

function grantedAt(oauth: YoutubeOauth): number {
	const at = Date.parse(oauth.obtained_at ?? "");
	return Number.isFinite(at) ? at : statSync(paths.ytOauth()).mtimeMs;
}

export function reconsentDue(ctx: Ctx, cfg: Config): boolean {
	const oauth = existsSync(paths.ytOauth()) ? oauthOf() : undefined;
	if (!cfg.youtube || !oauth || !testingMode(cfg, oauth)) return false;
	return ctx.now().getTime() - grantedAt(oauth) >= RECONSENT_AFTER_DAYS * DAY_MS;
}

const NOTICE = "유튜브 로그인을 6일째에 다시 받지 못했어요. Aside에서 구글 계정에 로그인했는지 확인해 주세요";

// One run of the keeper for YouTube: a working token is just refreshed; a testing-mode token on day 6 (or already dead) is renewed.
export async function keepYoutube(ctx: Ctx, cfg: Config, prev: KeeperState | undefined, reconsent: Reconsent): Promise<{ state: KeeperState; failed?: string }> {
	if (!cfg.youtube || cfg.youtube.token_source) return { state: { reconsent_fails: 0 } };
	let renew = reconsentDue(ctx, cfg);
	if (!renew) {
		try {
			await accessToken(ctx);
		} catch (e) {
			if (!(e instanceof AuthError) || !testingMode(cfg, oauthOf())) throw e;
			renew = true;
		}
	}
	if (!renew) return { state: { reconsent_fails: 0 } };
	const ok = await reconsent().catch(() => false);
	if (ok) return { state: { reconsent_fails: 0 } };
	const fails = (prev?.reconsent_fails ?? 0) + 1;
	return { state: { reconsent_fails: fails }, ...(fails >= FAILS_BEFORE_NOTICE ? { failed: NOTICE } : {}) };
}

// The real renewal: setup.ts youtube-auth prints the consent URL, an `aside repl` page script clicks through it in a background tab.
export async function reconsentViaAside(ctx: Ctx, aside: Aside, deps: { loopback?: () => Loopback; waitMs?: number } = {}): Promise<boolean> {
	let abort!: (q: URLSearchParams) => void;
	const aborted = new Promise<URLSearchParams>(r => (abort = r));
	const base = (deps.loopback ?? defaultLoopback)();
	const lb: Loopback = { ...base, redirect: Promise.race([base.redirect, aborted]) };
	let flow: Promise<void> | undefined;
	const res = await setupRun(ctx, ["youtube-auth", "--reuse"], {
		loopback: () => lb,
		waitMs: deps.waitMs ?? FLOW_WAIT_MS,
		onLine: l => {
			if (!l.startsWith("open ")) return;
			flow = aside.repl(pageBody("youtube-reconsent", l.slice(5), gcpConsentFlow())).then(
				r => {
					const state = (r as PageResult | undefined)?.state;
					if (state !== "ok") abort(new URLSearchParams({ error: "aside" }));
					else void ctx.sleep(GRACE_MS).then(() => abort(new URLSearchParams({ error: "grace" })));
				},
				() => abort(new URLSearchParams({ error: "aside" })),
			);
		},
	});
	await flow;
	return res.code === 0;
}
