// The Discord bot connection (token, server id, owner id) as one web screen: GET/PUT/DELETE /api/discord/connection and POST
// /api/discord/connection/check. Same data `bun setup.ts` writes. hub/discord.ts reads token/guild/owner only at start, so every
// change leaves `restart_needed` true until the process restarts; the UI restarts the gateway when idle with the existing
// POST /api/update/restart (hub/selfupdate.ts updateRoute; body {"when":"now"} restarts at once, otherwise when idle).
// The token is never returned or logged.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { PERMISSIONS } from "../onboard/discord.ts";
import { cfg, CONFIG_FILE, DATA_DIR, expand, log, writeAtomic } from "./config.ts";
import { status } from "./discord.ts";
import { body, json } from "./routes-util.ts";

export type DiscordFetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
const realFetch: DiscordFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

const API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;
// Application ids the developer portal issues and onboard/discord.ts reads (15-25 digits).
const APP_ID = /^\d{15,25}$/;
// Three dot-separated parts, as Discord issues bot tokens (same shape onboard/discord.ts reads from the developer portal).
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}$/;
const INTENT_NOTE = "개발자 포털 > Bot > Privileged Gateway Intents > MESSAGE CONTENT를 켜 주세요";
const DEFAULT_TOKEN_FILE = join(DATA_DIR, "secrets", "discord-bot-token");

let restartNeeded = false;

const tokenFile = () => expand(String(cfg.discord?.token_file ?? "")) || DEFAULT_TOKEN_FILE;
function storedToken(): string {
	try {
		return readFileSync(tokenFile(), "utf8").trim();
	} catch {
		return "";
	}
}

function view() {
	return {
		enabled: status.enabled,
		connected: status.connected,
		user: status.user,
		error: status.error,
		guild: String(cfg.discord?.guild ?? ""),
		owner_id: String(cfg.discord?.owner_id ?? ""),
		app_id: String(cfg.discord?.app_id ?? ""),
		has_token: storedToken() !== "",
		restart_needed: restartNeeded,
	};
}

// Edits config.json's discord block (re-read from disk) and mirrors it into `cfg`, like updateNotifyPush.
function updateDiscord(values: Record<string, string>): void {
	let disk: Record<string, any> = {};
	try {
		disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch {}
	disk.discord = { ...disk.discord, ...values };
	writeAtomic(CONFIG_FILE, `${JSON.stringify(disk, null, 2)}\n`);
	cfg.discord = { ...cfg.discord, ...values };
}

class Bad extends Error {}

export type DiscordConfig = { token_file: string; guild: string; owner_id: string; app_id: string };
/** The bot connection of one data dir: the live install (no dir) or a test/temporary one. A secret only ever leaves through `storeToken`. */
export type DiscordStore = {
	config(): DiscordConfig;
	token(): string;
	storeToken(token: string): void;
	save(b: Record<string, unknown>): { changed: boolean };
};

function readDiscordConfig(dir: string | undefined): Record<string, any> {
	try {
		const disk = dir ? (JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, any>) : (JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, any>);
		return disk.discord && typeof disk.discord === "object" ? disk.discord : {};
	} catch {
		return {};
	}
}

function writeDiscordConfig(dir: string | undefined, values: Record<string, string>): void {
	if (!dir) {
		updateDiscord(values);
		return;
	}
	const file = join(dir, "config.json");
	const disk = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
	disk.discord = { ...disk.discord, ...values };
	writeAtomic(file, `${JSON.stringify(disk, null, 2)}\n`);
}

/** Validates a whole connection body before anything is written; the route and the onboarding flow share it. */
function validate(b: Record<string, unknown>): { values: Record<string, string>; token: string | undefined } {
	const values: Record<string, string> = {};
	for (const [key, label, shape, note] of [
		["guild", "서버 ID", SNOWFLAKE, "17~20자리"],
		["owner_id", "내 사용자 ID", SNOWFLAKE, "17~20자리"],
		["app_id", "앱 ID", APP_ID, "15~25자리"],
	] as const) {
		if (!(key in b)) continue;
		const v = b[key];
		if (typeof v !== "string" || !shape.test(v.trim())) throw new Bad(`${label}는 ${note} 숫자여야 해요`);
		values[key] = v.trim();
	}
	let token: string | undefined;
	if ("token" in b) {
		token = typeof b.token === "string" ? b.token.trim() : "";
		if (!TOKEN_SHAPE.test(token)) throw new Bad("봇 토큰 형식이 올바르지 않아요");
	}
	if (token === undefined && !Object.keys(values).length) throw new Bad("바꿀 값이 없어요: token, guild, owner_id, app_id 중 하나를 보내 주세요");
	return { values, token };
}

/** The token path of a config block: its configured token_file, else DATA_DIR/secrets/discord-bot-token. */
function tokenPathOf(dir: string | undefined, discord: Record<string, any>): string {
	const configured = expand(String(discord?.token_file ?? ""));
	if (configured) return configured;
	return dir ? join(dir, "secrets", "discord-bot-token") : DEFAULT_TOKEN_FILE;
}

/** A store over one data dir. Without a dir it is the live install: writes mirror `cfg` and mark the restart. */
export function createDiscordStore(dir?: string): DiscordStore {
	const config = (): DiscordConfig => {
		const d = readDiscordConfig(dir);
		return { token_file: String(d.token_file ?? ""), guild: String(d.guild ?? ""), owner_id: String(d.owner_id ?? ""), app_id: String(d.app_id ?? "") };
	};
	const token = (): string => {
		try {
			return readFileSync(tokenPathOf(dir, readDiscordConfig(dir)), "utf8").trim();
		} catch {
			return "";
		}
	};
	const storeToken = (value: string): void => {
		if (!TOKEN_SHAPE.test(value)) throw new Bad("봇 토큰 형식이 올바르지 않아요");
		const discord = readDiscordConfig(dir);
		const file = tokenPathOf(dir, discord);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeAtomic(file, `${value}\n`, 0o600);
		chmodSync(file, 0o600);
		if (!discord.token_file) writeDiscordConfig(dir, { token_file: file });
		if (!dir) restartNeeded = true;
	};
	const save = (b: Record<string, unknown>): { changed: boolean } => {
		const { values, token: given } = validate(b);
		const before = config();
		const changed = given !== undefined || Object.entries(values).some(([k, v]) => (before as Record<string, string>)[k] !== v);
		// Validated as a whole above; the writes follow.
		if (given !== undefined) storeToken(given);
		if (Object.keys(values).length) writeDiscordConfig(dir, values);
		if (changed && !dir) restartNeeded = true;
		log(`discord connection saved (${[...(given !== undefined ? ["token"] : []), ...Object.keys(values)].join(", ")})`);
		return { changed };
	};
	return { config, token, storeToken, save };
}

/** Writes a connection body through the validated path (the HTTP route of the live install). */
export function saveDiscordConnection(b: Record<string, unknown>): { changed: boolean } {
	return createDiscordStore().save(b);
}

// isAdmin of onboard/discord.ts over an injectable fetch: does one of the bot's roles in the server carry Administrator?
async function botIsAdmin(call: (path: string) => Promise<unknown>, guild: string): Promise<boolean> {
	const me = (await call("/users/@me")) as { id: string } | undefined;
	const member = me && ((await call(`/guilds/${guild}/members/${me.id}`)) as { roles: string[] } | undefined);
	const roles = member && ((await call(`/guilds/${guild}/roles`)) as { id: string; permissions: string }[] | undefined);
	if (!roles) return false;
	const mine = new Set([...member.roles, guild]);
	return roles.some(r => mine.has(r.id) && (BigInt(r.permissions) & 8n) === 8n);
}

export async function checkConnection(token: string, stored: boolean, doFetch: DiscordFetch) {
	const call = async (path: string): Promise<unknown> => {
		const r = await doFetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
		if (r.ok) return r.json();
		if (path.startsWith("/oauth2/") || path === "/users/@me") throw new Bad(r.status === 401 ? "토큰이 거절됐어요" : `디스코드가 오류로 답했어요 (${r.status})`);
		return undefined;
	};
	try {
		const app = (await call("/oauth2/applications/@me")) as { id: string; name?: string; bot?: { username?: string } };
		const guild = String(cfg.discord?.guild ?? "");
		const out: Record<string, unknown> = { ok: true, app_id: app.id, bot_name: app.bot?.username ?? app.name ?? "", intent_note: INTENT_NOTE };
		if (stored && app.id && app.id !== cfg.discord?.app_id) updateDiscord({ app_id: app.id });
		if (SNOWFLAKE.test(guild)) {
			out.admin = await botIsAdmin(call, guild);
			if (!out.admin) out.invite_url = `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot&permissions=${PERMISSIONS}&guild_id=${guild}&disable_guild_select=true`;
		}
		return out;
	} catch (error) {
		return { ok: false, error: error instanceof Bad ? error.message : "디스코드에 연결하지 못했어요", intent_note: INTENT_NOTE };
	}
}

export async function discordConnectionRoute(req: Request, url: URL, doFetch: DiscordFetch = realFetch): Promise<Response | undefined> {
	if (url.pathname === "/api/discord/connection") {
		if (req.method === "GET") return json(view());
		if (req.method === "PUT") {
			try {
				saveDiscordConnection(await body(req));
			} catch (error) {
				if (error instanceof Bad) return json({ error: error.message }, 400);
				throw error;
			}
			return json(view());
		}
		if (req.method === "DELETE") {
			if (existsSync(tokenFile())) rmSync(tokenFile(), { force: true });
			restartNeeded = true;
			log("discord token removed");
			return json(view());
		}
	}
	if (req.method === "POST" && url.pathname === "/api/discord/connection/check") {
		const b = await body(req);
		const given = typeof b.token === "string" ? b.token.trim() : "";
		const token = given || storedToken();
		if (!token) return json({ ok: false, error: "확인할 봇 토큰이 없어요", intent_note: INTENT_NOTE });
		return json(await checkConnection(token, !given, doFetch));
	}
}
