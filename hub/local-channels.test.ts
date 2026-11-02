// A project made while Discord is off is web-only: a small numeric id from channels.json (localNext), kept by every Discord reconcile
// and never sent to Discord, also after Discord is turned on. Fake Discord REST server (DOTZ_DISCORD_API).
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "./config.ts";
import * as discord from "./discord.ts";
import { out } from "./outbound.ts";

type Call = { method: string; path: string };
const calls: Call[] = [];
let guild: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/api\/v10/, "");
			calls.push({ method: req.method, path });
			if (req.method === "GET" && /^\/guilds\/[^/]+\/channels$/.test(path)) return Response.json(guild);
			if (req.method === "GET" && /^\/guilds\/[^/]+\/roles$/.test(path)) return Response.json([{ id: "r-me", name: "mini bot", tags: { bot_id: "me" } }]);
			if (req.method === "GET" && path === "/users/@me") return Response.json({ id: "me" });
			return Response.json({ id: "9".repeat(18), name: "made" });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
});
beforeEach(() => {
	calls.length = 0;
	discord.status.enabled = false;
	delete discord.channels.local;
	delete discord.channels.localNext;
	Object.assign(discord.channels, { category: "cat", workCategory: "wcat", chat: "chat", alert: "alert", worklog: "worklog", lanes: {}, homes: {}, work: {}, threads: {}, adopted: ["cat", "wcat", "chat", "alert", "worklog"] });
});

const stored = () => JSON.parse(readFileSync(paths.channels, "utf8"));
const ch = (id: string, name: string, parent: string | null) => ({ id, name, type: id.endsWith("cat") ? 4 : 0, parent_id: parent, position: 0, permission_overwrites: [] });
const layout = () => [ch("cat", "main", null), ch("wcat", "work", null), ch("chat", "chat", "cat"), ch("alert", "alert", "cat"), ch("worklog", "worklog", "wcat"), ch("mine", "mine", "wcat")];

test("with Discord off a project gets the next local number, saved with its name in channels.json", async () => {
	const a = await discord.createWorkChannel("first");
	const b = await discord.createWorkChannel("second");
	expect([a, b]).toEqual([{ id: "1", name: "first" }, { id: "2", name: "second" }]);
	expect(stored()).toMatchObject({ local: ["1", "2"], localNext: 3, work: { "1": "first", "2": "second" } });
	expect(discord.isLocalChannel("2")).toBe(true);
	expect(calls).toEqual([]);
});

test("a local project survives a reconcile after Discord is turned on, while a work channel Discord lost is dropped", async () => {
	const local = await discord.createWorkChannel("web only");
	Object.assign(discord.channels.work, { mine: "mine", lost: "lost" });
	discord.status.enabled = true;
	guild = layout();
	await discord.ensureChannels();
	expect(Object.keys(discord.channels.work).sort()).toEqual([local.id, "mine"]);
	expect(stored().local).toEqual([local.id]);
});

test("a message to a local project never reaches Discord and raises no delivery failure", async () => {
	const local = await discord.createWorkChannel("web only");
	discord.status.enabled = true;
	const r = await out(`ch:${local.id}`, "hello", undefined, { source: "gateway" });
	expect(r.delivered).toBe(true);
	expect(calls.filter(c => c.path.includes(`/channels/${local.id}`))).toEqual([]);
	expect(calls.filter(c => c.method === "POST")).toEqual([]);
});
