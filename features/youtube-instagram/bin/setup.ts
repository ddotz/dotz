// First-run setup of the YouTube + Instagram feature (DESIGN.md): `youtube-auth`, `instagram-token`, `apply`, `status`.
// run(ctx, args) returns {lines, code}; main prints each line as it is produced (youtube-auth must show its consent URL
// before it waits). Gateway calls go through ctx.fetch with the hub token; secrets are never printed or put in argv.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, type Ctx, dataDir, defaultConfig, HHMM, type InstagramSecret, paths, readJson, realCtx, secretsDir, snsDir, validateConfig, writeJson, type YoutubeOauth } from "../lib/config.ts";
import { me } from "../lib/instagram.ts";
import { AuthError, TransientError } from "../lib/watchkit.ts";
import { accessToken, myChannel } from "../lib/youtube.ts";

export type Loopback = { port: number; redirect: Promise<URLSearchParams>; close: () => void };
export type SetupDeps = { onLine?: (line: string) => void; loopback?: () => Loopback; waitMs?: number };
export type Result = { lines: string[]; code: number };

const BIN = import.meta.dir;
const CARD_ID = "sns-channels";
const PROJECT_NAME = "유튜브·인스타 관리";
const PROJECT_NOTE = "유튜브와 인스타 올리기, 댓글, 통계를 맡아요";
const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const DEFAULT_WAIT_MS = 10 * 60_000;
const DEFAULT_PORT = 7420;

class Fail extends Error {}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const home = (p: string) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const b64url = (b: Buffer) => b.toString("base64url");
const csv = (v: string) => v.split(",").map(s => s.trim()).filter(Boolean);

function parseArgs(args: string[]): { cmd: string; flags: Map<string, string | true> } {
	const flags = new Map<string, string | true>();
	for (let i = 1; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith("--")) throw new Fail(`DOTZ_FAIL setup 알 수 없는 인자 ${a}`);
		const next = args[i + 1];
		if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), true);
		else {
			flags.set(a.slice(2), next);
			i++;
		}
	}
	return { cmd: args[0] ?? "", flags };
}

function readSecretFile<T>(file: string, what: string): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		throw new Fail(`DOTZ_FAIL setup ${what} 파일을 읽지 못했어요`);
	}
}

function defaultLoopback(): Loopback {
	let resolve!: (p: URLSearchParams) => void;
	const redirect = new Promise<URLSearchParams>(r => (resolve = r));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const q = new URL(req.url).searchParams;
			if (!q.has("code") && !q.has("error")) return new Response("not found", { status: 404 });
			resolve(q);
			return new Response("<meta charset=utf-8><p>연결됐어요. 이 창은 닫아도 돼요.", { headers: { "content-type": "text/html; charset=utf-8" } });
		},
	});
	return { port: server.port!, redirect, close: () => void server.stop(true) };
}

async function youtubeAuth(ctx: Ctx, flags: Map<string, string | true>, deps: SetupDeps, out: (l: string) => void): Promise<void> {
	const file = flags.get("client");
	if (typeof file !== "string") throw new Fail("DOTZ_FAIL setup --client <json 파일>이 필요해요");
	const raw = readSecretFile<any>(file, "클라이언트");
	const c = raw?.installed ?? raw?.web ?? raw;
	if (typeof c?.client_id !== "string" || typeof c?.client_secret !== "string" || !c.client_id || !c.client_secret) throw new Fail("DOTZ_FAIL setup 클라이언트 파일에 client_id, client_secret이 없어요");

	const verifier = b64url(randomBytes(32));
	const state = b64url(randomBytes(16));
	const lb = (deps.loopback ?? defaultLoopback)();
	const redirectUri = `http://127.0.0.1:${lb.port}`;
	try {
		const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" });
		out(`open https://accounts.google.com/o/oauth2/v2/auth?${q}`);
		const got = await Promise.race([lb.redirect, ctx.sleep(deps.waitMs ?? DEFAULT_WAIT_MS).then(() => undefined)]);
		if (!got) throw new Fail("DOTZ_FAIL youtube-auth timeout");
		if (got.get("error")) throw new Fail("DOTZ_FAIL youtube-auth denied");
		if (got.get("state") !== state) throw new Fail("DOTZ_FAIL youtube-auth state");
		const code = got.get("code");
		if (!code) throw new Fail("DOTZ_FAIL youtube-auth code");
		const res = await ctx.fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
		});
		const body = (await res.json().catch(() => ({}))) as { refresh_token?: string };
		if (!res.ok || !body.refresh_token) throw new Fail(`DOTZ_FAIL youtube-auth token ${res.status}`);
		const secret: YoutubeOauth = { client_id: c.client_id, client_secret: c.client_secret, refresh_token: body.refresh_token };
		writeJson(paths.ytOauth(), secret, true);
		rmSync(paths.ytAccess(), { force: true });
	} finally {
		lb.close();
	}
	const ch = await myChannel(ctx);
	out(`youtube-connected ${ch.id} ${ch.title}`);
}

async function instagramToken(ctx: Ctx, flags: Map<string, string | true>, out: (l: string) => void): Promise<void> {
	const file = flags.get("from");
	if (typeof file !== "string") throw new Fail("DOTZ_FAIL setup --from <json 파일>이 필요해요");
	const token = readSecretFile<{ access_token?: string }>(file, "토큰").access_token;
	if (typeof token !== "string" || !token) throw new Fail("DOTZ_FAIL setup 토큰 파일에 access_token이 없어요");
	const acc = await me(ctx, token);
	const secret: InstagramSecret = { access_token: token, user_id: acc.user_id, username: acc.username, obtained_at: ctx.now().toISOString() };
	writeJson(paths.instagram(), secret, true);
	out(`instagram-connected ${acc.user_id} ${acc.username}`);
}

// ---- gateway ---------------------------------------------------------------------------------------------------------

function gatewayBase(ctx: Ctx): string {
	let port = Number(ctx.env.DOTZ_PORT);
	if (!port) port = Number(readJson<{ web?: { port?: number } }>(join(dataDir(), "config.json"))?.web?.port) || DEFAULT_PORT;
	return `http://127.0.0.1:${port}`;
}

async function gateway(ctx: Ctx, method: string, path: string, body?: unknown): Promise<any> {
	const tokenFile = join(secretsDir(), "hub-token");
	if (!existsSync(tokenFile)) throw new Fail("DOTZ_FAIL gateway no-token");
	const headers: Record<string, string> = { "x-dotz-token": readFileSync(tokenFile, "utf8").trim() };
	if (body !== undefined) headers["content-type"] = "application/json";
	let res: Response;
	try {
		res = await ctx.fetch(`${gatewayBase(ctx)}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
	} catch {
		throw new Fail("DOTZ_FAIL gateway unreachable");
	}
	if (!res.ok) throw new Fail(`DOTZ_FAIL gateway ${res.status}`);
	return res.json().catch(() => ({}));
}

// ---- apply -----------------------------------------------------------------------------------------------------------

type Accounts = { youtube?: { id: string; title: string }; instagram?: { user_id: string; username: string } };

async function accountsFor(ctx: Ctx, f: Map<string, string | true>): Promise<Accounts> {
	const str = (k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : undefined);
	const out: Accounts = {};
	if (f.get("dry-run")) {
		const ch = str("yt-channel"), user = str("ig-user");
		if (ch) out.youtube = { id: ch, title: str("yt-title") ?? ch };
		if (user) out.instagram = { user_id: user, username: str("ig-username") ?? user };
		if (f.get("youtube") && !ch) throw new Fail("DOTZ_FAIL setup --dry-run에는 --yt-channel이 필요해요");
		if (f.get("instagram") && !user) throw new Fail("DOTZ_FAIL setup --dry-run에는 --ig-user가 필요해요");
		return out;
	}
	const explicit = Boolean(f.get("youtube") || f.get("instagram"));
	if (f.get("youtube") || (!explicit && existsSync(paths.ytOauth()))) {
		if (!existsSync(paths.ytOauth())) throw new Fail("DOTZ_FAIL setup 유튜브가 아직 연결되지 않았어요 (youtube-auth 먼저)");
		out.youtube = await myChannel(ctx, await accessToken(ctx));
	}
	if (f.get("instagram") || (!explicit && existsSync(paths.instagram()))) {
		if (!existsSync(paths.instagram())) throw new Fail("DOTZ_FAIL setup 인스타가 아직 연결되지 않았어요 (instagram-token 먼저)");
		const a = await me(ctx);
		out.instagram = { user_id: a.user_id, username: a.username };
	}
	return out;
}

function buildConfig(f: Map<string, string | true>, acc: Accounts): Config {
	const str = (k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : undefined);
	const prev = readJson<Config>(paths.config());
	const c: Config = prev && !validateConfig(prev) ? { ...prev } : defaultConfig();
	if (acc.youtube) {
		const y = c.youtube;
		c.youtube = { channel_id: acc.youtube.id, title: acc.youtube.title, base_language: y?.base_language ?? "ko", languages: y?.languages ?? [], privacy: y?.privacy ?? "private", upload_via: y?.upload_via ?? "api" };
	}
	if (acc.instagram) c.instagram = { user_id: acc.instagram.user_id, username: acc.instagram.username, post_via: c.instagram?.post_via ?? "api" };
	if (c.youtube) {
		if (str("languages")) c.youtube.languages = str("languages") === "off" ? [] : csv(str("languages")!);
		if (str("base")) c.youtube.base_language = str("base")!;
		if (str("privacy")) c.youtube.privacy = str("privacy") as any;
		if (str("youtube-via")) c.youtube.upload_via = str("youtube-via") as any;
	}
	if (c.instagram && str("instagram-via")) c.instagram.post_via = str("instagram-via") as any;
	if (str("times")) c.posting_times = csv(str("times")!);
	if (str("approval")) c.approval = str("approval") as any;
	if (str("timezone")) c.timezone = str("timezone")!;
	const quiet = str("quiet");
	if (quiet === "off") delete c.quiet_hours;
	else if (quiet) {
		const m = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(quiet);
		if (!m || !HHMM.test(m[1]!) || !HHMM.test(m[2]!)) throw new Fail("DOTZ_FAIL setup --quiet는 HH:MM-HH:MM 또는 off예요");
		c.quiet_hours = { from: m[1]!, to: m[2]! };
	}
	if (str("inbox")) c.inbox_dir = str("inbox")!.replace(/^~(?=\/|$)/, homedir());
	if (str("budget")) c.quota = { daily_budget: Number(str("budget")) };
	if (str("channel")) c.channel = str("channel");
	return c;
}

const TONE_TEMPLATE = `# 답글 말투

댓글에 답할 때 따라 할 말투예요. 아래에 실제로 쓴 답글을 몇 개 붙여 두면 그대로 닮아가요.

- 말투: (예: 친근한 해요체, 이모지는 가끔)
- 꼭 지킬 것: (예: 광고성 댓글에는 답하지 않아요)

## 예시 답글

1.
2.
3.
`;

function cardSpec(): object {
	return {
		title: "유튜브·인스타",
		note: "구독자와 팔로워, 답 기다리는 초안이에요",
		view: "kv",
		command: `bun ${shq(join(BIN, "card.ts"))}`,
		every_minutes: 60,
		timeout_seconds: 20,
		actions: [
			{ label: "댓글 지금 확인", prompt: "유튜브와 인스타의 새 댓글을 지금 확인하고, 답글 초안을 보여 주세요." },
			{ label: "영상 올리는 법", prompt: "올릴 영상을 어디에 두고 어떤 순서로 올리는지 이 채널 설정에 맞춰 알려 주세요." },
		],
	};
}

function mergePins(channel?: string): void {
	const file = join(dataDir(), "custom", "pins.json");
	let pins: Record<string, any> = {};
	if (existsSync(file)) {
		try {
			pins = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			throw new Fail("DOTZ_FAIL setup pins.json을 읽지 못했어요 (JSON 오류)");
		}
		if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw new Fail("DOTZ_FAIL setup pins.json은 JSON 객체여야 해요");
	}
	const mine = { name: PROJECT_NAME, path: snsDir(), ...(channel ? { channel: channel.slice(3) } : {}), note: PROJECT_NOTE };
	const projects: any[] = Array.isArray(pins.projects) ? pins.projects : [];
	const i = projects.findIndex(p => p?.name === PROJECT_NAME);
	if (i >= 0) projects[i] = mine;
	else projects.push(mine);
	writeJson(file, { ...pins, projects });
}

const WATCHES = [
	{ name: "sns-yt-comments", script: "yt-comments.ts", every: 30, platform: "youtube", on: "match", timeout: 120 },
	{ name: "sns-ig-comments", script: "ig-comments.ts", every: 60, platform: "instagram", on: "match", timeout: 120 },
	{ name: "sns-inbox", script: "inbox.ts", every: 5, platform: "any", on: "match", timeout: 120 },
	{ name: "sns-due", script: "due.ts", every: 5, platform: "any", on: "match", timeout: 900 },
	{ name: "sns-tokens", script: "tokens.ts", every: 720, platform: "any", on: "change", timeout: 120 },
	{ name: "sns-yt-metadata", script: "yt-metadata.ts", every: 1440, platform: "youtube", on: "match", timeout: 120 },
] as const;

function projectBody(key: string, c: Config, watchesOn: boolean) {
	const names = [c.youtube && "유튜브", c.instagram && "인스타"].filter(Boolean).join("·");
	return {
		key,
		title: PROJECT_NAME,
		purpose: `${names} 영상 올리기, 댓글 답글, 통계를 승인받고 처리해요`,
		milestones: [
			{ text: "계정 연결", done: true },
			{ text: "기본값 정하기", done: true },
			{ text: "감시 켜기", done: watchesOn },
		],
	};
}

async function apply(ctx: Ctx, flags: Map<string, string | true>, out: (l: string) => void): Promise<void> {
	const acc = await accountsFor(ctx, flags);
	if (!acc.youtube && !acc.instagram) throw new Fail("DOTZ_FAIL setup 연결된 계정이 없어요 (youtube-auth나 instagram-token 먼저)");
	const config = buildConfig(flags, acc);
	const bad = validateConfig(config);
	if (bad) throw new Fail(`DOTZ_FAIL setup ${bad}`);

	writeJson(paths.config(), config);
	mkdirSync(join(config.inbox_dir, "done"), { recursive: true });
	if (!existsSync(paths.tone())) writeFileSync(paths.tone(), TONE_TEMPLATE);
	out(`config ${paths.config()}`);

	const cardFile = join(dataDir(), "custom", "cards", CARD_ID, "card.json");
	writeJson(cardFile, cardSpec());
	mergePins(config.channel);
	out(`card ${CARD_ID}`);

	const key = config.channel ?? `dir:${home(snsDir())}`;
	await gateway(ctx, "PUT", "/api/projects", projectBody(key, config, false));
	out(`project ${key}`);

	const translating = Boolean(config.youtube?.languages.length);
	const mine = WATCHES.filter(w => (w.name === "sns-yt-metadata" ? translating : w.platform === "any" || (w.platform === "youtube" ? config.youtube : config.instagram)));
	// A watch tied to a work channel cannot be deleted through the API (409), so turning translations off pauses it; a
	// later --languages re-adds it by name, which replaces the paused one.
	if (flags.get("languages") === "off") {
		const list = await gateway(ctx, "GET", "/api/watches");
		const there = (Array.isArray(list) ? list : []).some((w: any) => w?.name === "sns-yt-metadata");
		if (there) {
			await gateway(ctx, "PATCH", "/api/watches/sns-yt-metadata", { paused: true });
			out("watch sns-yt-metadata paused");
		}
	}
	for (const w of mine) {
		await gateway(ctx, "POST", "/api/watches", {
			name: w.name,
			command: `bun ${shq(join(BIN, w.script))}`,
			every_minutes: w.every,
			on: w.on,
			...(w.on === "match" ? { pattern: "." } : {}),
			to: "orchestrator",
			...(config.channel ? { channels: [config.channel.slice(3)] } : {}),
			timeout_seconds: w.timeout,
		});
		out(`watch ${w.name} every ${w.every}m`);
	}
	await gateway(ctx, "PUT", "/api/projects", projectBody(key, config, true));
	out("ok");
}

// ---- status ----------------------------------------------------------------------------------------------------------

async function status(ctx: Ctx, out: (l: string) => void): Promise<void> {
	const c = readJson<Config>(paths.config());
	if (!c) {
		out("설정: 아직 안 했어요. 채팅에서 유튜브·인스타 설정을 시작해 주세요");
		out("유튜브: 연결 전이에요");
		out("인스타: 연결 전이에요");
	} else {
		const bad = validateConfig(c);
		out(bad ? `설정: 문제가 있어요. ${bad}` : `설정: 있어요. 승인은 ${c.approval === "each" ? "하나씩" : "묶어서"} 받고, 올리는 시각은 ${c.posting_times.join(", ")}예요`);
		out(c.youtube ? `유튜브: ${c.youtube.title ?? c.youtube.channel_id} 채널이 연결돼 있어요. ${c.youtube.privacy} 공개 범위, ${c.youtube.upload_via === "api" ? "API" : "브라우저"}로 올려요${existsSync(paths.ytOauth()) ? "" : ". 로그인 정보가 없어요"}` : "유튜브: 연결하지 않았어요");
		out(c.instagram ? `인스타: @${c.instagram.username} 계정이 연결돼 있어요. ${c.instagram.post_via === "api" ? "API" : "브라우저"}로 올려요${existsSync(paths.instagram()) ? "" : ". 로그인 정보가 없어요"}` : "인스타: 연결하지 않았어요");
	}
	try {
		const r = await gateway(ctx, "GET", "/api/watches");
		const list: any[] = Array.isArray(r) ? r : (r?.watches ?? r?.items ?? []);
		const names = list.map(w => String(w?.name ?? "")).filter(n => n.startsWith("sns-"));
		out(names.length ? `감시: ${names.length}개가 켜져 있어요 (${names.join(", ")})` : "감시: 아직 켜 둔 게 없어요");
	} catch (e) {
		out(`감시: 게이트웨이에서 가져오지 못했어요 (${(e as Error).message.replace("DOTZ_FAIL gateway ", "")})`);
	}
}

export async function run(ctx: Ctx, args: string[], deps: SetupDeps = {}): Promise<Result> {
	const lines: string[] = [];
	const out = (l: string) => {
		lines.push(l);
		deps.onLine?.(l);
	};
	try {
		const { cmd, flags } = parseArgs(args);
		if (cmd === "youtube-auth") await youtubeAuth(ctx, flags, deps, out);
		else if (cmd === "instagram-token") await instagramToken(ctx, flags, out);
		else if (cmd === "apply") await apply(ctx, flags, out);
		else if (cmd === "status") await status(ctx, out);
		else throw new Fail("DOTZ_FAIL setup 명령은 youtube-auth, instagram-token, apply, status 중 하나예요");
		return { lines, code: 0 };
	} catch (e) {
		if (e instanceof Fail) out(e.message);
		else if (e instanceof AuthError) out(`DOTZ_FAIL ${args[0] === "instagram-token" ? "instagram-auth" : "youtube-auth"}`);
		else if (e instanceof TransientError) out("DOTZ_FAIL network");
		else out(`DOTZ_FAIL setup ${(e as Error).message}`);
		return { lines, code: 1 };
	}
}

if (import.meta.main) {
	const { code } = await run(realCtx(), process.argv.slice(2), { onLine: l => console.log(l) });
	process.exit(code);
}
