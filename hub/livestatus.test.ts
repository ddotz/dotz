// The live progress message against a fake Discord REST server (DOTZ_DISCORD_API) and the fake clock: typing while the
// answer is pending, ONE progress message from 5 min on, edited in place when there is news, deleted by the answer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { emitEventActivity } from "./activity.ts";
import * as discord from "./discord.ts";
import { emitActivity } from "./events.ts";
import { msg } from "./i18n.ts";
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
const toolCall = (intent: string) => emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "tool_call", text: `bash: ${intent}`, intent, said: true });
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
	expect(posted[0]!.body!.content).toMatch(/: 테스트 실행하는 중\n/);
	expect(posted[0]!.body!.content.split("\n")).toContain("- 설정 파일 읽는 중");
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

test("the note says plain steps: no raw tool name, query or upload file name, at most three recent ones and a count of the rest", async () => {
	await run(1); // the previous answer is not this wait's
	requests.length = 0;
	const raw = (tool: string, intent: string, said = false) => emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "tool_call", tool, text: intent ? `${tool}: ${intent}` : tool, intent, ...(said ? { said } : {}) });
	const upload = "mw2u0t1gz8ef-20261105_095044.jpg";
	livestatus.begin("ch:111", "lane:live-test");
	await run(6, m => {
		if (m === 0) {
			raw("web_search", "채무자회생법 제137조 외국통화 회생채권 조문");
			raw("read", `/Users/x/uploads/2026-11-05/${upload}`);
			raw("read", `${upload} 확인`, true);
			raw("eval", "eval", true);
			toolCall("환율 확인");
			toolCall("집계 확인");
			toolCall("평가액 계산");
			toolCall("기준서 원문 확보");
			raw("mcp__custom-tools__eval", "");
		}
	});
	await discord.send("ch:111", "answer");
	await discord.clearProgress("ch:111");
	const note = reports()[0]!.body!.content;
	expect(note.split("\n").filter(l => l.startsWith("- ")).slice(0, 3)).toEqual(["- 집계 확인", "- 평가액 계산", "- 기준서 원문 확보"]);
	expect(note).toContain(`: ${msg().liveTool.run}\n`);
	expect(note).toMatch(/\b4\b/);
	for (const leak of ["eval", "web_search", "제137조", "mw2u0t1gz8ef", ".jpg"]) expect(note).not.toContain(leak);
	await run(1);
});

test("nothing in the model's words since the last report means no recent section", async () => {
	requests.length = 0;
	livestatus.begin("ch:111", "lane:live-test");
	await run(6, m => {
		if (m === 0) for (const tool of ["web_search", "read", "bash"]) emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "tool_call", tool, text: tool, intent: "" });
	});
	await discord.send("ch:111", "answer");
	await discord.clearProgress("ch:111");
	const lines = reports()[0]!.body!.content.split("\n");
	expect(lines.filter(l => l.startsWith("- "))).toEqual([]);
	expect(lines[1]).toEndWith(`: ${msg().liveTool.run}`);
	await run(1);
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

test("web: the progress line is one note per conversation through the web hook, nothing goes to Discord, and the turn's end stops it", async () => {
	requests.length = 0;
	const posts: { target: string; text: string }[] = [];
	livestatus.setWebProgress((target, text) => void posts.push({ target, text }));
	livestatus.begin("lane:live-test", "lane:live-test", true);
	await run(6, m => {
		if (m === 1) toolCall("웹에서 보낸 일 하는 중");
	});
	expect(posts).toHaveLength(1);
	expect(posts[0]!.target).toBe("lane:live-test");
	expect(posts[0]!.text).toContain("웹에서 보낸 일 하는 중");
	expect(requests).toEqual([]);
	emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "lane:live-test", type: "turn_end", text: "" });
	await run(12);
	// No report after the end; the line shown is finalized with an empty note (the page drops it).
	expect(posts.map(p => p.text)).toEqual([posts[0]!.text, ""]);
});

// A work channel answered by its own conversation session (2026-11-01, ch:1564971207911284746): the web message's progress line
// waited on main's turn and on a Discord send, so the session's answer at 1:40 (web only) left "5분째 작업 중" posted at 5:00.
test("a conversation session's answer at 1:40 ends the web wait too: nothing is posted at 5:00", async () => {
	requests.length = 0;
	const posts: { target: string; text: string }[] = [];
	livestatus.setWebProgress((target, text) => void posts.push({ target, text }));
	livestatus.begin("ch:111", "conv:work", true);
	await run(1);
	await advance(40_000);
	// What the answer's delivery does (prompts.ts onAnswer, outbound.ts settleAnswer), on the web as on Discord.
	await discord.clearProgress("ch:111");
	await run(12);
	expect(posts).toEqual([]);
	expect(visible().filter(r => r.method !== "DELETE")).toEqual([]);
});

test("web: a line already posted is finalized when the session's turn ends or its answer comes, and none follows", async () => {
	const posts: { target: string; text: string }[] = [];
	livestatus.setWebProgress((target, text) => void posts.push({ target, text }));
	const sessionTool = (intent: string) => emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "conv:work", type: "tool_call", text: intent, intent, said: true });
	livestatus.begin("ch:111", "conv:work", true);
	await run(6, m => m === 1 && sessionTool("문서 정리하는 중"));
	expect(posts.map(p => p.text.length > 0)).toEqual([true]);
	emitActivity({ ts: new Date(Date.now()).toISOString(), kind: "activity", source: "conv:work", type: "turn_end", text: "" });
	await run(12);
	expect(posts.map(p => p.text)).toEqual([posts[0]!.text, ""]);

	posts.length = 0;
	livestatus.begin("ch:111", "conv:work", true);
	await run(6, m => m === 1 && sessionTool("다시 정리하는 중"));
	await discord.clearProgress("ch:111");
	await run(12);
	expect(posts.map(p => p.text.length > 0)).toEqual([true, false]);
});

test("gateway start: a progress message a turn before the start left on Discord is deleted, a live one is kept", async () => {
	requests.length = 0;
	await discord.progress("ch:111", "progress", "⏳ live");
	const file = join(DATA_DIR, "discord-progress.json");
	const live = JSON.parse(readFileSync(file, "utf8"))["ch:111"].progress as string;
	writeFileSync(file, JSON.stringify({ "ch:111": { progress: live, other: "left1" }, "ch:222": { progress: "left2" } }));
	discord.channels.work["222"] = "proj2";
	await discord.clearLeftProgress();
	const deleted = requests.filter(r => r.method === "DELETE").map(r => r.path.split("/channels/")[1]);
	expect(deleted).toEqual(["111/messages/left1", "222/messages/left2"]);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "ch:111": { progress: live } });
	await discord.clearProgress("ch:111");
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
});
