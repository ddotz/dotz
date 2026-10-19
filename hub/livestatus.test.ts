// The live progress message against a fake Discord REST server (DOTZ_DISCORD_API) and the fake clock: typing while the
// answer is pending, ONE progress message from 5 min on, edited in place when there is news, deleted by the answer.
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
async function run(minutes: number, each?: (m: number) => void): Promise<void> {
	for (let m = 0; m < minutes; m++) {
		each?.(m);
		await advance(60_000);
		await quiet();
	}
}
const toolCall = (intent: string) => emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "tool_call", text: `bash: ${intent}`, intent });
const typing = (r: Req) => r.path.endsWith("/typing");
const reports = () => requests.filter(r => (r.method === "POST" || r.method === "PATCH") && !typing(r) && r.body?.content.startsWith("⏳"));
const visible = () => requests.filter(r => !typing(r));

test("progress: typing throughout, one message at 5 min edited when something moved, deleted by the answer", async () => {
	requests.length = 0;
	const t0 = Date.now();
	livestatus.begin("ch:111", "lane:live-test");
	emitEventActivity("lane:live-test", { type: "subagent", update: { id: "w1", agent: "task", description: "LiveStatusLine 구현", status: "running" } });
	await run(23, m => {
		if (m === 1) toolCall("설정 파일 읽는 중");
		if (m === 3) toolCall("테스트 실행하는 중");
		if (m === 7) toolCall("커밋 정리하는 중");
		if (m === 21) toolCall("리뷰 반영하는 중");
	});
	await discord.send("ch:111", "answer");
	await discord.clearProgress("ch:111");
	const answeredAt = requests.length;
	await run(12);

	const posted = reports();
	// 15 and 20 min said nothing new (same current intent, lanes, workers; no tool call since): skipped as in Dori's sweep;
	// the tool call at 21 min is news more than 5 min after the last report, so it goes out at the next check.
	expect(posted.map(p => Math.round((p.at - t0) / 60_000))).toEqual([5, 10, 22]);
	expect(posted[0]!.body!.content).toMatch(/\b5\b/);
	expect(posted[0]!.body!.content).toMatch(/: 설정 파일 읽는 중\n[^\n]*: 테스트 실행하는 중\n/);
	expect(posted[0]!.body!.content).toContain("테스트 실행하는 중");
	expect(posted[0]!.body!.content).toContain("w1: LiveStatusLine 구현");
	expect(posted[1]!.body!.content).toContain("커밋 정리하는 중");
	expect(posted[1]!.body!.content).not.toContain("설정 파일");
	// One message: posted once, then edited; the answer deletes it; nothing (not even typing) after the answer.
	expect(posted.map(p => p.method)).toEqual(["POST", "PATCH", "PATCH"]);
	expect(requests.filter(typing).length).toBeGreaterThan(100);
	expect(requests.slice(0, answeredAt).filter(r => r.method === "DELETE")).toHaveLength(1);
	expect(requests).toHaveLength(answeredAt);
});

test("after the first report a worker finishing is reported within a minute, not at the next 5-min mark", async () => {
	requests.length = 0;
	const t0 = Date.now();
	livestatus.begin("ch:111", "lane:live-test");
	emitEventActivity("lane:live-test", { type: "subagent", update: { id: "w2", agent: "task", description: "빌드", status: "running" } });
	await run(7, m => {
		if (m === 0) toolCall("빌드 돌리는 중");
		if (m === 6) emitEventActivity("lane:live-test", { type: "subagent", update: { id: "w2", agent: "task", description: "빌드", status: "done" } });
	});
	await discord.send("ch:111", "answer");
	await discord.clearProgress("ch:111");
	expect(reports().map(p => Math.round((p.at - t0) / 60_000))).toEqual([5, 7]);
	expect(reports()[1]!.body!.content).not.toContain("w2: 빌드");
});

test("an answer within 5 min means no report at all", async () => {
	requests.length = 0;
	livestatus.begin("ch:111", "lane:live-test");
	await run(4);
	await discord.send("ch:111", "quick answer");
	await run(12);
	expect(visible().map(r => r.body?.content)).toEqual(["quick answer"]);
});

test("the turn's end stops the reports even when no answer reached the channel", async () => {
	requests.length = 0;
	livestatus.begin("ch:111", "lane:live-test");
	await run(2);
	emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "turn_end", text: "" });
	const ended = requests.length;
	await run(12);
	expect(visible()).toEqual([]);
	expect(requests.length - ended).toBeLessThanOrEqual(1); // at most the typing tick already due
});
