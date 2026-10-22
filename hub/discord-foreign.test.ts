// Two gateways (MacBook, Mac mini) share one Discord server. A work channel the other gateway made or hid from this bot
// (its keepPrivate denied View Channel to our managed role, or its topic carries the other bot's id) is never adopted,
// and one an earlier build adopted is dropped by ensureChannels. Fake Discord REST server (DOTZ_DISCORD_API).
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as discord from "./discord.ts";

type Call = { method: string; path: string; body?: any };
const calls: Call[] = [];
let guild: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/api\/v10/, "");
			const text = await req.text();
			calls.push({ method: req.method, path, body: text ? JSON.parse(text) : undefined });
			if (req.method === "GET" && /^\/guilds\/[^/]+\/channels$/.test(path)) return Response.json(guild);
			if (req.method === "GET" && /^\/guilds\/[^/]+\/roles$/.test(path)) return Response.json([{ id: "r-other", name: "macbook bot", tags: { bot_id: "other-bot" } }, { id: "r-me", name: "mini bot", tags: { bot_id: "me" } }]);
			if (req.method === "GET" && path === "/users/@me") return Response.json({ id: "me" });
			return Response.json({ id: `new${calls.length}`, name: "made" });
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
	Object.assign(discord.channels, { category: "cat", workCategory: "wcat", chat: "chat", alert: "alert", worklog: "worklog", lanes: {}, homes: {}, work: {}, threads: {}, adopted: ["cat", "wcat", "chat", "alert", "worklog"] });
});

const ch = (id: string, name: string, parent: string | null, extra: object = {}) => ({ id, name, type: id.endsWith("cat") || id === "cat" ? 4 : 0, parent_id: parent, position: 0, permission_overwrites: [], ...extra });
const VIEW = String(1n << 10n);
const layout = () => [
	ch("cat", "main", null), ch("wcat", "work", null),
	ch("chat", "chat", "cat"), ch("alert", "alert", "cat"), ch("worklog", "worklog", "wcat"),
	ch("mine", "mine", "wcat"),
	ch("hidden", "dotz-hidden", "wcat", { permission_overwrites: [{ id: "r-me", type: 0, allow: "0", deny: VIEW }] }),
	ch("tagged", "dotz-tagged", "wcat", { topic: "dotz:other-bot" }),
	ch("ownTag", "own-tagged", "wcat", { topic: "dotz:me" }),
];

test("ensureChannels drops a work channel that another gateway hid from this bot or tagged as its own, and keeps ours", async () => {
	guild = layout();
	discord.channels.work = { mine: "mine", hidden: "dotz-hidden", tagged: "dotz-tagged", ownTag: "own-tagged" };
	await discord.ensureChannels();
	expect(Object.keys(discord.channels.work).sort()).toEqual(["mine", "ownTag"]);
});

test("a work channel made here is tagged with this bot's id in its topic", async () => {
	guild = layout();
	await discord.createWorkChannel("project");
	const post = calls.find(c => c.method === "POST" && c.path.endsWith("/channels"));
	expect(post?.body).toMatchObject({ parent_id: "wcat", topic: "dotz:me" });
});
