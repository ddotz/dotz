// lane:<name> resolves to where the lane lives (its lane.json record) when channels.json has no entry; with nothing
// recorded the message goes to the worklog with the lane title in front. Fake Discord REST server records every post.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as discord from "./discord.ts";

const posts: { channel: string; content: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
const records = new Map<string, { channel?: string; home?: string; title?: string }>();

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/api\/v10/, "");
			const m = /^\/channels\/([^/]+)\/messages$/.exec(path);
			if (req.method === "POST" && m) posts.push({ channel: m[1]!, content: (await req.json()).content });
			return Response.json({ id: `m${posts.length}` });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	discord.status.enabled = true;
	discord.setLaneRecords({
		read: lane => records.get(lane),
		remember: (lane, channel, home) => records.set(lane, { ...records.get(lane), channel, ...(home ? { home } : {}) }),
	});
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
});
beforeEach(() => {
	posts.length = 0;
	records.clear();
	Object.assign(discord.channels, { worklog: "worklog", lanes: {}, homes: {}, work: { proj: "proj" }, threads: {} });
});

test("a thread-home lane without a channel-map entry resolves to its recorded thread", async () => {
	records.set("tailnet", { channel: "thr1", home: "proj", title: "탭넷 감시" });
	const r = await discord.send("lane:tailnet", "보고합니다");
	expect(r.delivered).toBe(true);
	expect(posts).toEqual([{ channel: "thr1", content: "보고합니다" }]);
	expect(discord.channels.lanes.tailnet).toBe("thr1");
	expect(discord.channels.homes.tailnet).toBe("proj");
});

test("a resumed lane with its own channel resolves to the recorded channel", async () => {
	records.set("solo", { channel: "chan9" });
	expect((await discord.send("lane:solo", "다시 시작했습니다")).delivered).toBe(true);
	expect(posts[0]).toEqual({ channel: "chan9", content: "다시 시작했습니다" });
	expect(discord.channels.homes.solo).toBeUndefined();
});

test("a lane with nothing recorded falls back to the worklog with its title", async () => {
	records.set("ghost", { title: "유령 작업" });
	expect((await discord.send("lane:ghost", "내용")).delivered).toBe(true);
	expect(posts).toEqual([{ channel: "worklog", content: "**유령 작업**: 내용" }]);
	await discord.send("lane:unknown", "또 내용");
	expect(posts[1]).toEqual({ channel: "worklog", content: "**unknown**: 또 내용" });
});

test("a lane stop keeps the thread in the record, and recordLaneChannels fills old lanes", async () => {
	Object.assign(discord.channels, { lanes: { old: "thr2" }, homes: { old: "proj" } });
	discord.recordLaneChannels();
	expect(records.get("old")).toEqual({ channel: "thr2", home: "proj" });
});
