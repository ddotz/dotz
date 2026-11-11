import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, CONFIG_FILE, DATA_DIR, paths } from "./config.ts";
import { discordConnectionRoute, type DiscordFetch } from "./discord-connection.ts";

const TOKEN = "abcdefghijklmnopqrstuv.wxyz12.SECRETSECRETSECRETSECRET1234";
const GUILD = "123456789012345678";
const OWNER = "876543210987654321";
const TOKEN_FILE = join(DATA_DIR, "secrets", "discord-conn-test", "bot-token");
const DEFAULT_FILE = join(DATA_DIR, "secrets", "discord-bot-token");
const BASE_CONFIG = { identity: { name: "tester" }, web: { port: 1 }, discord: { token_file: TOKEN_FILE, owner_id: "1", guild: "1", category: "keep-me" } };

const originalConfig = readFileSync(CONFIG_FILE, "utf8");
const originalDiscord = { ...cfg.discord };

beforeEach(() => {
	rmSync(join(DATA_DIR, "secrets", "discord-conn-test"), { recursive: true, force: true });
	rmSync(DEFAULT_FILE, { force: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(BASE_CONFIG));
	cfg.discord = { ...BASE_CONFIG.discord };
});
afterAll(() => {
	rmSync(join(DATA_DIR, "secrets", "discord-conn-test"), { recursive: true, force: true });
	rmSync(DEFAULT_FILE, { force: true });
	writeFileSync(CONFIG_FILE, originalConfig);
	cfg.discord = originalDiscord;
});

const call = async (method: string, path: string, payload?: unknown, doFetch?: DiscordFetch) => {
	const req = new Request(`http://hub${path}`, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
	const res = await discordConnectionRoute(req, new URL(req.url), doFetch);
	return { status: res!.status, text: await res!.clone().text(), json: (await res!.json()) as Record<string, any> };
};
const diskDiscord = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8")).discord;

const discordApi = (opts: { token?: string; admin?: boolean; reject?: boolean } = {}): DiscordFetch & { calls: { url: string; auth: string }[] } => {
	const calls: { url: string; auth: string }[] = [];
	const fake = async (url: string, init: { headers: Record<string, string> }) => {
		calls.push({ url, auth: init.headers.Authorization });
		if (opts.reject) return new Response("{}", { status: 401 });
		const path = url.replace("https://discord.com/api/v10", "");
		if (path === "/oauth2/applications/@me") return Response.json({ id: "999000111222333444", name: "dotz app", bot: { username: "dotz-bot" } });
		if (path === "/users/@me") return Response.json({ id: "42" });
		if (path === `/guilds/${cfg.discord.guild}/members/42`) return Response.json({ roles: ["r1"] });
		if (path === `/guilds/${cfg.discord.guild}/roles`) return Response.json([{ id: "r1", permissions: opts.admin ? "8" : "0" }]);
		return new Response("{}", { status: 404 });
	};
	return Object.assign(fake, { calls });
};

describe("discord connection", () => {
	test("GET: no restart needed before any change, token never in the shape", async () => {
		const r = await call("GET", "/api/discord/connection");
		expect(r.status).toBe(200);
		expect(Object.keys(r.json).sort()).toEqual(["app_id", "connected", "enabled", "error", "guild", "has_token", "owner_id", "restart_needed", "user"]);
		expect(r.json).toMatchObject({ guild: "1", owner_id: "1", has_token: false, restart_needed: false });
	});

	test("PUT refuses bad ids, a bad token and an empty body with 400 and changes nothing", async () => {
		for (const bad of [{ guild: "123" }, { owner_id: "abc" }, { guild: 123456789012345678 }, { guild: `${GUILD}9999` }, { token: "short" }, { token: 5 }, { token: "" }, {}, { token: TOKEN, guild: "nope" }]) {
			const r = await call("PUT", "/api/discord/connection", bad);
			expect(r.status).toBe(400);
			expect(typeof r.json.error).toBe("string");
		}
		expect(existsSync(TOKEN_FILE)).toBe(false);
		expect(diskDiscord()).toEqual(BASE_CONFIG.discord);
		expect((await call("GET", "/api/discord/connection")).json.restart_needed).toBe(false);
	});

	test("PUT writes the token 0600 in a 0700 dir, merges config, and leaks the token nowhere", async () => {
		const r = await call("PUT", "/api/discord/connection", { token: TOKEN, guild: GUILD, owner_id: OWNER });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ guild: GUILD, owner_id: OWNER, has_token: true, restart_needed: true });
		expect(readFileSync(TOKEN_FILE, "utf8").trim()).toBe(TOKEN);
		expect(statSync(TOKEN_FILE).mode & 0o777).toBe(0o600);
		expect(statSync(join(TOKEN_FILE, "..")).mode & 0o777).toBe(0o700);
		expect(r.text).not.toContain(TOKEN);
		expect((await call("GET", "/api/discord/connection")).text).not.toContain(TOKEN);
		expect(readFileSync(paths.log, "utf8")).not.toContain(TOKEN);
		expect(readFileSync(paths.log, "utf8")).not.toContain("SECRETSECRET");
		const disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		expect(disk.identity).toEqual({ name: "tester" });
		expect(disk.web).toEqual({ port: 1 });
		expect(disk.discord).toEqual({ token_file: TOKEN_FILE, owner_id: OWNER, guild: GUILD, category: "keep-me" });
		expect(cfg.discord.guild).toBe(GUILD);
		expect(JSON.stringify(disk)).not.toContain(TOKEN);
	});

	test("PUT with only an id keeps the token and the other id", async () => {
		await call("PUT", "/api/discord/connection", { token: TOKEN });
		const r = await call("PUT", "/api/discord/connection", { guild: GUILD });
		expect(r.json).toMatchObject({ guild: GUILD, owner_id: "1", has_token: true, restart_needed: true });
		expect(readFileSync(TOKEN_FILE, "utf8").trim()).toBe(TOKEN);
	});

	test("without a configured token_file the default path is used and recorded in config", async () => {
		cfg.discord = { ...cfg.discord, token_file: "" };
		writeFileSync(CONFIG_FILE, JSON.stringify({ ...BASE_CONFIG, discord: { ...BASE_CONFIG.discord, token_file: "" } }));
		const r = await call("PUT", "/api/discord/connection", { token: TOKEN });
		expect(r.json.has_token).toBe(true);
		expect(statSync(DEFAULT_FILE).mode & 0o777).toBe(0o600);
		expect(diskDiscord().token_file).toBe(DEFAULT_FILE);
		expect(cfg.discord.token_file).toBe(DEFAULT_FILE);
	});

	test("check: administrator bot is ok without an invite link, app id is stored", async () => {
		await call("PUT", "/api/discord/connection", { token: TOKEN, guild: GUILD });
		const api = discordApi({ admin: true });
		const r = await call("POST", "/api/discord/connection/check", undefined, api);
		expect(r.json).toMatchObject({ ok: true, app_id: "999000111222333444", bot_name: "dotz-bot", admin: true });
		expect(r.json.invite_url).toBeUndefined();
		expect(r.json.intent_note).toContain("MESSAGE CONTENT");
		expect(api.calls[0]).toEqual({ url: "https://discord.com/api/v10/oauth2/applications/@me", auth: `Bot ${TOKEN}` });
		expect(diskDiscord().app_id).toBe("999000111222333444");
		expect((await call("GET", "/api/discord/connection")).json.app_id).toBe("999000111222333444");
		expect(r.text).not.toContain(TOKEN);
	});

	test("check: a bot without administrator gets an invite link", async () => {
		await call("PUT", "/api/discord/connection", { token: TOKEN, guild: GUILD });
		const r = await call("POST", "/api/discord/connection/check", undefined, discordApi({ admin: false }));
		expect(r.json).toMatchObject({ ok: true, admin: false });
		expect(r.json.invite_url).toBe(`https://discord.com/oauth2/authorize?client_id=999000111222333444&scope=bot&permissions=8&guild_id=${GUILD}&disable_guild_select=true`);
	});

	test("check: a rejected token is a Korean error", async () => {
		await call("PUT", "/api/discord/connection", { token: TOKEN });
		const r = await call("POST", "/api/discord/connection/check", undefined, discordApi({ reject: true }));
		expect(r.json).toMatchObject({ ok: false, error: "토큰이 거절됐어요" });
		expect(r.text).not.toContain(TOKEN);
	});

	test("check: a token in the body is used but not stored", async () => {
		const api = discordApi({ admin: true });
		const r = await call("POST", "/api/discord/connection/check", { token: TOKEN }, api);
		expect(r.json.ok).toBe(true);
		expect(api.calls[0].auth).toBe(`Bot ${TOKEN}`);
		expect(existsSync(TOKEN_FILE)).toBe(false);
		expect(diskDiscord().app_id).toBeUndefined();
	});

	test("check: nothing stored and nothing given is an error without calling Discord", async () => {
		const api = discordApi();
		const r = await call("POST", "/api/discord/connection/check", undefined, api);
		expect(r.json.ok).toBe(false);
		expect(api.calls).toEqual([]);
	});

	test("DELETE removes only the token file; ids stay and a restart is needed", async () => {
		await call("PUT", "/api/discord/connection", { token: TOKEN, guild: GUILD, owner_id: OWNER });
		const r = await call("DELETE", "/api/discord/connection");
		expect(r.json).toMatchObject({ has_token: false, guild: GUILD, owner_id: OWNER, restart_needed: true });
		expect(existsSync(TOKEN_FILE)).toBe(false);
		expect(diskDiscord()).toEqual({ token_file: TOKEN_FILE, owner_id: OWNER, guild: GUILD, category: "keep-me" });
	});

	test("restart_needed stays true on later reads", async () => {
		await call("PUT", "/api/discord/connection", { owner_id: OWNER });
		expect((await call("GET", "/api/discord/connection")).json.restart_needed).toBe(true);
	});
});
