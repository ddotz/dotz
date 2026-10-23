// Test fixtures shared by the feature tests: a temp DOTZ_DIR with a full config and secrets, a temp watch state folder and
// a fake Ctx (fetch keyed by "METHOD origin+path", fake exec, fixed clock, sleep that resolves at once). No network, no timers.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type Ctx, defaultConfig, paths, writeJson } from "../lib/config.ts";

export const NOW = "2030-06-15T12:00:00.000Z";
export const CHANNEL = "UC0123456789abcdef";
export const YT = "https://www.googleapis.com/youtube/v3";
export const IG = "https://graph.instagram.com/v23.0";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type Call = { method: string; url: string; headers: Record<string, string>; body: string };
export type Handler = (call: Call, n: number) => unknown;
export type FakeCtx = Ctx & { calls: Call[]; sleeps: number[]; execs: string[][]; routes: Record<string, Handler> };
export type TestEnv = { dir: string; stateDir: string; cleanup: () => void };

export function setupEnv(mutate?: (c: Config) => void): TestEnv {
	const dir = mkdtempSync(join(tmpdir(), "dz-sns-"));
	const before = process.env.DOTZ_DIR;
	process.env.DOTZ_DIR = dir;
	const cfg: Config = {
		...defaultConfig(),
		youtube: { channel_id: CHANNEL, base_language: "ko", languages: ["en", "ja"], privacy: "private", upload_via: "api", audited: true },
		instagram: { user_id: "17841", username: "owner_ig", post_via: "api" },
	};
	mutate?.(cfg);
	writeJson(paths.config(), cfg);
	mkdirSync(paths.inbox(), { recursive: true });
	writeJson(paths.ytOauth(), { client_id: "cid", client_secret: "csecret", refresh_token: "rtok" }, true);
	writeJson(paths.ytAccess(), { access_token: "yt-access", expires_at: "2031-01-01T00:00:00.000Z" }, true);
	writeJson(paths.instagram(), { access_token: "ig-token", user_id: "17841", username: "owner_ig", obtained_at: "2030-06-14T00:00:00.000Z", expires_at: "2030-08-13T00:00:00.000Z" }, true);
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { recursive: true });
	return {
		dir,
		stateDir,
		cleanup: () => {
			rmSync(dir, { recursive: true, force: true });
			if (before === undefined) delete process.env.DOTZ_DIR;
			else process.env.DOTZ_DIR = before;
		},
	};
}

export const readState = (env: TestEnv) => JSON.parse(readFileSync(join(env.stateDir, "state.json"), "utf8")) as { fails: number; data?: any };

export function fakeCtx(env: TestEnv, o: { now?: string; routes?: Record<string, Handler>; exec?: Ctx["exec"]; noState?: boolean } = {}): FakeCtx {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const execs: string[][] = [];
	const counts = new Map<string, number>();
	const routes = o.routes ?? {};
	const now = new Date(o.now ?? NOW);
	return {
		calls,
		sleeps,
		execs,
		routes,
		now: () => now,
		sleep: async ms => {
			sleeps.push(ms);
		},
		exec: async (argv, opts) => {
			execs.push(argv);
			if (!o.exec) throw new Error("exec was not expected");
			return o.exec(argv, opts);
		},
		env: o.noState ? {} : { DOTZ_WATCH_STATE_DIR: env.stateDir },
		fetch: async (url, init) => {
			const u = new URL(url);
			const method = (init?.method ?? "GET").toUpperCase();
			const call: Call = { method, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body === undefined || init.body === null ? "" : String(init.body) };
			calls.push(call);
			const key = `${method} ${u.origin}${u.pathname}`;
			const handler = routes[key];
			if (!handler) return new Response(`unexpected ${key}`, { status: 418 });
			const n = counts.get(key) ?? 0;
			counts.set(key, n + 1);
			const out = handler(call, n);
			return out instanceof Response ? out : Response.json(out);
		},
	};
}

export const ytThread = (id: string, by: string, byChannel: string, text: string, at: string, o: { videoId?: string; replyBy?: string; replyText?: string } = {}) => ({
	snippet: { videoId: o.videoId ?? "v1", topLevelComment: { id, snippet: { authorDisplayName: by, authorChannelId: { value: byChannel }, textDisplay: text, publishedAt: at } } },
	replies: o.replyBy ? { comments: [{ snippet: { authorChannelId: { value: o.replyBy }, textDisplay: o.replyText ?? "thanks" } }] } : undefined,
});

export const calls = (ctx: FakeCtx, part: string) => ctx.calls.filter(c => c.url.includes(part));

export function dropVideo(env: TestEnv, name: string, content = "VIDEO"): string {
	const file = join(paths.inbox(), name);
	writeFileSync(file, content);
	const old = new Date("2026-01-01T00:00:00Z");
	utimesSync(file, old, old);
	return file;
}
