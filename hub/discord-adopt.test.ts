// Adopted channels (channels.adopted: existing channels taken over from another bot, e.g. its chat, alert and worklog channels)
// keep their name, category, position and permission overwrites: ensureChannels neither renames, moves nor hides them,
// while channels dotz made itself keep the fixed layout and stay private. A brief slot (channels.brief) takes the morning
// brief. Fake Discord REST server (DOTZ_DISCORD_API) records every call.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as discord from "./discord.ts";

type Call = { method: string; path: string; body?: any };
const calls: Call[] = [];
let guild: any[] = [];
let server: ReturnType<typeof Bun.serve>;
const OTHER_ROLE = "r-other";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/api\/v10/, "");
			const text = await req.text();
			calls.push({ method: req.method, path, body: text ? JSON.parse(text) : undefined });
			if (req.method === "GET" && /^\/guilds\/[^/]+\/channels$/.test(path)) return Response.json(guild);
			if (req.method === "GET" && /^\/guilds\/[^/]+\/roles$/.test(path)) return Response.json([{ id: OTHER_ROLE, name: "other bot", tags: { bot_id: "other-bot" } }, { id: "r-me", name: "me", tags: { bot_id: "me" } }]);
			if (req.method === "GET" && path === "/users/@me") return Response.json({ id: "me" });
			return Response.json({ id: `new${calls.length}` });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	discord.status.enabled = true;
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
});
beforeEach(() => {
	calls.length = 0;
	const c = discord.channels;
	for (const k of ["category", "workCategory", "chat", "worklog", "alert", "brief", "adopted"] as const) delete (c as any)[k];
	c.lanes = {};
	c.homes = {};
	c.work = {};
	c.threads = {};
});

const ch = (id: string, name: string, parent: string | null, type = 0) => ({ id, name, type, parent_id: parent, position: 0, permission_overwrites: [] });
// Another bot's layout: category "🐈‍⬛ main" (chat, alert, brief) and "🛠 작업" (worklog, two work channels, one extra channel).
const otherBotGuild = () => [
	ch("cat", "🐈‍⬛ main", null, 4),
	ch("work-cat", "🛠 작업", null, 4),
	ch("chat", "💬┃대화", "cat"),
	ch("alert", "🔔┃알림", "cat"),
	ch("brief", "☀️┃브리핑", "cat"),
	ch("worklog", "📋┃작업로그", "work-cat"),
	ch("docs-a", "docs-a", "work-cat"),
	ch("docs-b", "docs-b", "work-cat"),
	ch("extra", "extra", "work-cat"),
	ch("lane1", "debt-cleanup", "work-cat"),
];
const cutover = (adopted: string[]) => Object.assign(discord.channels, { category: "cat", workCategory: "work-cat", chat: "chat", alert: "alert", worklog: "worklog", brief: "brief", work: { "docs-a": "docs-a", "docs-b": "docs-b" }, lanes: { "debt-cleanup": "lane1" }, adopted });
const writes = () => calls.filter(c => c.method !== "GET");
const touched = (id: string) => writes().filter(c => c.path === `/channels/${id}` || c.path.startsWith(`/channels/${id}/permissions/`));

test("adopted channels and categories are neither renamed, moved nor hidden; other channels in an adopted category are left alone", async () => {
	guild = otherBotGuild();
	cutover(["cat", "work-cat", "chat", "alert", "worklog", "brief", "docs-a", "docs-b"]);
	await discord.ensureChannels();
	for (const id of ["cat", "work-cat", "chat", "alert", "worklog", "brief", "docs-a", "docs-b", "extra"]) expect(touched(id)).toEqual([]);
	expect(writes().filter(c => c.method === "POST")).toEqual([]);
	expect(discord.channels.brief).toBe("brief");
});

test("a lane channel dotz made inside an adopted category stays hidden from other bots", async () => {
	guild = otherBotGuild();
	cutover(["cat", "work-cat", "chat", "alert", "worklog", "brief", "docs-a", "docs-b"]);
	await discord.ensureChannels();
	expect(writes()).toEqual([{ method: "PUT", path: `/channels/lane1/permissions/${OTHER_ROLE}`, body: { type: 0, deny: String(1n << 10n), allow: "0" } }]);
});

test("without adoption the fixed layout still applies: renamed, moved under the category and hidden from other bots", async () => {
	guild = otherBotGuild();
	cutover([]);
	await discord.ensureChannels();
	expect(touched("chat").some(c => c.method === "PATCH" && c.body.name)).toBe(true);
	expect(touched("worklog").some(c => c.method === "PATCH" && c.body.parent_id === "cat")).toBe(true);
	expect(touched("extra").some(c => c.method === "PUT")).toBe(true);
});

test("the brief slot is a send target; a brief channel that no longer exists is dropped (the brief falls back to chat)", async () => {
	guild = otherBotGuild();
	cutover(["cat", "work-cat", "chat", "alert", "worklog", "brief", "docs-a", "docs-b"]);
	expect((await discord.send("brief", "morning")).delivered).toBe(true);
	expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/channels/brief/messages" });
	guild = otherBotGuild().filter(c => c.id !== "brief");
	calls.length = 0;
	await discord.ensureChannels();
	expect(discord.channels.brief).toBeUndefined();
	expect(writes().filter(c => c.method === "POST")).toEqual([]);
});
