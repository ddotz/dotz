// Shared contract of the YouTube + Instagram feature (DESIGN.md): paths, the owner's config, secrets and the injected
// context every script runs with. Pure fs; never imports hub/config.ts (that one loads the gateway config at import time).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const snsDir = () => join(dataDir(), "custom", "sns");
export const secretsDir = () => join(dataDir(), "secrets");
export const REPO_FEATURE = join(import.meta.dir, "..");

export const paths = {
	config: () => join(snsDir(), "config.json"),
	tone: () => join(snsDir(), "tone.md"),
	jobs: () => join(snsDir(), "jobs"),
	inbox: () => join(snsDir(), "inbox"),
	backup: () => join(snsDir(), "backup"),
	cache: () => join(snsDir(), "cache"),
	quota: () => join(snsDir(), "cache", "quota.json"),
	stats: () => join(snsDir(), "cache", "stats.json"),
	videos: () => join(snsDir(), "cache", "videos.json"),
	igDm: () => join(snsDir(), "cache", "ig-dm.json"),
	ytOauth: () => join(secretsDir(), "youtube-oauth.json"),
	ytAccess: () => join(secretsDir(), "youtube-access.json"),
	instagram: () => join(secretsDir(), "instagram.json"),
};

export type Lang = string; // BCP-47 short code: "en", "ja", "es", "zh-Hans" ...
export type Config = {
	version: 1;
	youtube?: { channel_id: string; title?: string; base_language: Lang; languages: Lang[]; privacy: "private" | "unlisted" | "public"; upload_via: "api" | "aside" };
	instagram?: { user_id: string; username: string; post_via: "api" | "aside" };
	timezone: string;
	posting_times: string[]; // "HH:MM" in timezone
	approval: "each" | "batch";
	quiet_hours?: { from: string; to: string };
	inbox_dir: string;
	quota: { daily_budget: number };
	channel?: string; // "ch:<id>"
};

export type YoutubeOauth = { client_id: string; client_secret: string; refresh_token: string };
export type YoutubeAccess = { access_token: string; expires_at: string };
export type InstagramSecret = { access_token: string; user_id: string; username?: string; obtained_at: string; expires_at?: string };

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function defaultConfig(): Config {
	return { version: 1, timezone: "Asia/Seoul", posting_times: ["18:00"], approval: "each", quiet_hours: { from: "00:00", to: "08:00" }, inbox_dir: paths.inbox(), quota: { daily_budget: 9000 } };
}

// Boundary check of a config read from disk or built by setup; returns the problem in Korean (owner-facing) or undefined.
export function validateConfig(c: any): string | undefined {
	if (!c || typeof c !== "object") return "설정이 JSON 객체가 아니에요";
	if (c.version !== 1) return "version은 1이어야 해요";
	if (!c.youtube && !c.instagram) return "유튜브나 인스타 중 하나는 연결해야 해요";
	if (c.youtube) {
		if (!/^UC[\w-]{10,}$/.test(String(c.youtube.channel_id ?? ""))) return "유튜브 채널 id(UC...)가 올바르지 않아요";
		if (!LANG.test(String(c.youtube.base_language ?? ""))) return "기본 언어 코드가 올바르지 않아요";
		if (!Array.isArray(c.youtube.languages) || !c.youtube.languages.every((l: unknown) => LANG.test(String(l)))) return "언어 목록이 올바르지 않아요";
		if (!["private", "unlisted", "public"].includes(c.youtube.privacy)) return "공개 범위는 private, unlisted, public 중 하나예요";
		if (!["api", "aside"].includes(c.youtube.upload_via)) return "유튜브 올리는 방식은 api 또는 aside예요";
	}
	if (c.instagram) {
		if (!String(c.instagram.user_id ?? "").trim() || !String(c.instagram.username ?? "").trim()) return "인스타 계정 정보가 비어 있어요";
		if (!["api", "aside"].includes(c.instagram.post_via)) return "인스타 올리는 방식은 api 또는 aside예요";
	}
	try {
		new Intl.DateTimeFormat("en", { timeZone: c.timezone });
	} catch {
		return `시간대 ${c.timezone}를 모르겠어요`;
	}
	if (!Array.isArray(c.posting_times) || !c.posting_times.length || !c.posting_times.every((t: unknown) => HHMM.test(String(t)))) return "올리는 시각은 HH:MM 목록이에요";
	if (!["each", "batch"].includes(c.approval)) return "승인 방식은 each 또는 batch예요";
	if (c.quiet_hours && !(HHMM.test(c.quiet_hours.from) && HHMM.test(c.quiet_hours.to))) return "조용한 시간은 HH:MM이에요";
	if (typeof c.inbox_dir !== "string" || !c.inbox_dir.startsWith("/")) return "올릴 영상 폴더는 절대 경로예요";
	if (!(Number(c.quota?.daily_budget) >= 100 && Number(c.quota?.daily_budget) <= 1_000_000)) return "하루 쿼터 예산은 100 이상이에요";
	if (c.channel !== undefined && !/^ch:\d+$/.test(String(c.channel))) return "채널은 ch:<숫자>예요";
	return undefined;
}

export function readJson<T>(file: string): T | undefined {
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

// Atomic write; `secret` files get 0600 and a 0700 parent.
export function writeJson(file: string, value: unknown, secret = false): void {
	mkdirSync(dirname(file), { recursive: true, ...(secret ? { mode: 0o700 } : {}) });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, secret ? { mode: 0o600 } : undefined);
	if (secret) chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

export class SetupError extends Error {}

export function loadConfig(): Config {
	let c: unknown;
	try {
		c = readJson<Config>(paths.config());
	} catch {
		throw new SetupError("config.json is not valid JSON");
	}
	if (!c) throw new SetupError("not set up yet (no config.json)");
	const bad = validateConfig(c);
	if (bad) throw new SetupError(bad);
	return c as Config;
}

// Injected effects: tests pass fakes, scripts pass the real ones (realCtx). No module touches the network or a child
// process except through these.
export type ExecResult = { code: number; stdout: string; stderr: string };
export type Ctx = {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	exec: (argv: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<ExecResult>;
	env: Record<string, string | undefined>;
};

const FETCH_TIMEOUT_MS = 20_000;
export function realCtx(): Ctx {
	return {
		fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
		now: () => new Date(),
		sleep: ms => new Promise(r => setTimeout(r, ms)),
		exec: async (argv, opts) => {
			const p = Bun.spawn(argv, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
			const t = setTimeout(() => p.kill("SIGKILL"), opts?.timeoutMs ?? 60_000);
			const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
			const code = await p.exited;
			clearTimeout(t);
			return { code, stdout, stderr };
		},
		env: process.env,
	};
}
