// The live status line against a fake Discord REST server (DOTZ_DISCORD_API) and the fake clock: 15 s turn with three
// tool calls and a running task worker -> one POST after 10 s, edits that carry the intents, one DELETE after the answer
// and no request after it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { emitEventActivity } from "./activity.ts";
import * as discord from "./discord.ts";
import { emitActivity } from "./events.ts";
import * as livestatus from "./livestatus.ts";
import { advance, flush } from "./runtime/test-clock.ts";

type Req = { method: string; path: string; body?: { content: string }; at: number };
const requests: Req[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const text = await req.text();
			requests.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : undefined, at: Date.now() });
			if (req.method === "DELETE") return new Response(null, { status: 204 });
			return Response.json({ id: `m${requests.length}` });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	discord.status.enabled = true;
	discord.channels.work["111"] = "proj";
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = realFetch;
	delete process.env.DOTZ_DISCORD_API;
});

// Fetches to the fake server run on real I/O: after every fake second, event-loop turns pass until every fetch the code
// under test started has come back.
let pending = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
	pending++;
	try {
		return await realFetch(...args);
	} finally {
		pending--;
	}
}) as typeof fetch;
async function quiet(): Promise<void> {
	do await flush(10);
	while (pending > 0);
	await flush(10);
}
async function run(seconds: number, each?: (s: number) => void): Promise<void> {
	for (let s = 1; s <= seconds; s++) {
		each?.(s);
		await advance(1000);
		await quiet();
	}
}
const toolCall = (intent: string) => emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "tool_call", text: `bash: ${intent}`, intent });

test("live status line: one post, edits with the intents, delete after the answer, nothing after", async () => {
	requests.length = 0;
	const t0 = Date.now();
	livestatus.begin("ch:111", "lane:live-test");
	emitEventActivity("lane:live-test", { type: "subagent", update: { id: "w1", agent: "task", description: "LiveStatusLine 구현", status: "running" } });
	await run(15, s => {
		if (s === 5) toolCall("설정 파일 읽는 중");
		if (s === 11) toolCall("테스트 실행하는 중");
		if (s === 13) toolCall("커밋 정리하는 중");
	});
	// The answer arrives at 15 s: it is posted, then clearProgress removes the status line.
	await discord.send("ch:111", "answer");
	await discord.clearProgress("ch:111");
	const cleared = requests.length;
	await run(30);

	const posts = requests.filter(r => r.method === "POST" && r.body?.content !== "answer");
	const patches = requests.filter(r => r.method === "PATCH");
	const deletes = requests.filter(r => r.method === "DELETE");
	expect(posts).toHaveLength(1);
	expect(posts[0]!.at).toBe(t0 + 10_000);
	expect(posts[0]!.body!.content).toStartWith("⏳");
	expect(posts[0]!.body!.content).toContain("설정 파일 읽는 중");
	expect(posts[0]!.body!.content).toContain("task: LiveStatusLine 구현");
	expect(posts[0]!.body!.content.length).toBeLessThanOrEqual(300);
	expect(patches.length).toBeGreaterThanOrEqual(2);
	expect(patches.some(p => p.body!.content.includes("테스트 실행하는 중"))).toBe(true);
	expect(patches.some(p => p.body!.content.includes("커밋 정리하는 중"))).toBe(true);
	for (let i = 1; i < patches.length; i++) expect(patches[i]!.at - patches[i - 1]!.at).toBeGreaterThanOrEqual(2000);
	expect(deletes).toHaveLength(1);
	expect(deletes[0]!.path).toBe(patches[0]!.path);
	expect(requests.indexOf(deletes[0]!)).toBe(cleared - 1);
	expect(requests).toHaveLength(cleared);
});

test("an answer within 10 s means no status line at all", async () => {
	requests.length = 0;
	livestatus.begin("ch:111", "lane:live-test");
	await run(4);
	await discord.send("ch:111", "quick answer");
	await discord.clearProgress("ch:111");
	await run(30);
	expect(requests.map(r => r.method)).toEqual(["POST"]);
});
