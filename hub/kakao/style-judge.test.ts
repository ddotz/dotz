import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteDb } from "./db.ts";
import type { ModelReply, StyleHint } from "./draft.ts";
import { addMessage, BASE_LOG, BASE_TIME, type FixtureMsg, makeFixtureDb, OWNER, ROOM } from "./fixture.ts";
import { makeDraft, type MakeDraftCtx } from "./make-draft.ts";
import { listDrafts } from "./send.ts";
import { type KakaoConfig, kakaoPaths } from "./types.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const DIRECT = String(ROOM.direct);
const quiet = async () => ({ code: 0, stdout: "", stderr: "" });
let dir: string;
let paths: ReturnType<typeof kakaoPaths>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kakao-judge-"));
	paths = kakaoPaths(dir, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const style: StyleHint = { standing: ["존댓말로 쓴다"], rules: [], corrections: ["2026-11-20 약속은 시간을 먼저 말한다"], forbidden: [], samples: [] };
const draftOf = (body: string): ModelReply => ({ text: JSON.stringify({ action: "draft", body, summary: "" }) });
const violations = (vs: object[]): ModelReply => ({ text: JSON.stringify({ violations: vs }) });
const NOTE = "확인: 말투 조건과 달라 보여요: 존댓말로 쓴다";

function room(drafts: (string | ModelReply | Error)[], judged: ModelReply[], o: { hint?: StyleHint; messages?: FixtureMsg[] } = {}) {
	const dbPath = join(dir, "k.sqlite");
	const fixture = makeFixtureDb(dbPath);
	for (const m of o.messages ?? []) addMessage(fixture, m);
	fixture.close();
	const db = sqliteDb(dbPath);
	const draftCalls: string[] = [], judgeCalls: string[] = [];
	const config: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: [DIRECT] };
	const chat = { chatId: DIRECT, name: "Alex", type: 1, kind: "direct" as const, unread: 0, lastAt: 1 };
	const ctx: MakeDraftCtx = {
		deps: {
			paths,
			runner: quiet,
			now: () => NOW,
			openDb: async () => db,
			broadcast: () => {},
			draftModel: async (_system, user) => {
				draftCalls.push(user);
				const d = drafts[Math.min(draftCalls.length - 1, drafts.length - 1)]!;
				if (d instanceof Error) throw d;
				return typeof d === "string" ? draftOf(d) : d;
			},
			judgeModel: async (_system, user) => (judgeCalls.push(user), judged[Math.min(judgeCalls.length - 1, judged.length - 1)]!),
			draftStyle: () => o.hint ?? style,
		},
		paths,
		now: () => NOW,
		getDb: async () => db,
		allRooms: async () => ({ all: [chat] }),
		eligible: rooms => rooms,
		setAsk: () => {},
		storedAsks: () => ({}),
	};
	const pending = async () => (await listDrafts({ paths, runner: quiet })).filter(d => d.status === "pending");
	return { run: () => makeDraft(ctx, config, DIRECT), ctx, config, draftCalls, judgeCalls, pending, close: () => db.close() };
}

test("a KakaoTalk draft that follows the owner's conditions is judged once and stored as written", async () => {
	const r = room(["3시에 뵐게요"], [violations([])]);
	expect(await r.run()).toMatchObject({ ok: true });
	expect(r.draftCalls).toHaveLength(1);
	expect(r.judgeCalls).toHaveLength(1);
	expect(r.judgeCalls[0]).toContain("Standing rules (the owner set these; they always hold):\n1. 존댓말로 쓴다\n\nPast corrections, newest first:\n2. 약속은 시간을 먼저 말한다\n");
	expect((await r.pending()).map(d => [d.text, d.notes ?? []])).toEqual([["3시에 뵐게요", []]]);
	r.close();
});

test("a KakaoTalk draft that breaks a condition is written again once with the finding, and the rewrite is judged again", async () => {
	const r = room(["3시에 봐", "3시에 뵐게요"], [violations([{ rule: 1, quote: "3시에 봐", why: "반말" }]), violations([])]);
	await r.run();
	expect(r.draftCalls).toHaveLength(2);
	expect(r.draftCalls[1]).toContain("Your last draft failed these checks; fix them: it breaks the owner's rule '존댓말로 쓴다' at '3시에 봐'");
	expect(r.judgeCalls).toHaveLength(2);
	expect((await r.pending()).map(d => [d.text, d.notes ?? []])).toEqual([["3시에 뵐게요", []]]);
	r.close();
});

test("a KakaoTalk draft the judge flags only about its content is stored as written, with no rewrite and no note", async () => {
	const r = room(["3시에 뵐게요"], [violations([{ rule: 2, about: "content", quote: "3시에", why: "시간을 약속함" }])]);
	await r.run();
	expect(r.draftCalls).toHaveLength(1);
	expect(r.judgeCalls).toHaveLength(1);
	expect((await r.pending()).map(d => [d.text, d.notes ?? []])).toEqual([["3시에 뵐게요", []]]);
	r.close();
});

test("a KakaoTalk rewrite that still breaks a condition is stored with the 확인 note, never a third try", async () => {
	const r = room(["3시에 봐", "3시에 봐"], [violations([{ rule: 1, quote: "3시에 봐", why: "반말" }])]);
	await r.run();
	expect(r.draftCalls).toHaveLength(2);
	expect(r.judgeCalls).toHaveLength(2);
	expect((await r.pending()).map(d => [d.text, d.notes])).toEqual([["3시에 봐", [NOTE]]]);
	r.close();
});

test("a KakaoTalk rewrite the judge asked for that fails the lint, skips, throws, does not parse or asks keeps the first draft with the 확인 note", async () => {
	const ask: ModelReply = { text: JSON.stringify({ action: "ask", body: "", summary: "", question: "몇 시가 좋을까요?", choices: ["3시", "4시"] }) };
	const skip: ModelReply = { text: JSON.stringify({ action: "skip", body: "", summary: "" }) };
	for (const second of [draftOf("[이름]님 3시에 뵐게요"), draftOf(""), skip, new Error("model call timed out after 45s"), { text: "다시 써 봤어요: 3시에 뵐게요" }, ask]) {
		const r = room(["3시에 봐", second], [violations([{ rule: 1, quote: "3시에 봐", why: "반말" }]), violations([])]);
		expect(await r.run()).toMatchObject({ ok: true, code: expect.any(String) });
		expect(r.draftCalls).toHaveLength(2);
		expect(r.judgeCalls).toHaveLength(1);
		expect((await r.pending()).map(d => [d.text, d.notes])).toEqual([["3시에 봐", [NOTE]]]);
		r.close();
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "kakao-judge-"));
		paths = kakaoPaths(dir, dir);
	}
});

test("a KakaoTalk revise is judged with the owner's request in its own block, and teaches what its first try said", async () => {
	const first: ModelReply = { text: JSON.stringify({ action: "draft", body: "3시에 봐", summary: "", lesson: "친한 사이에는 반말로 쓴다", forbid: [], everywhere: false }) };
	const rewrite: ModelReply = { text: JSON.stringify({ action: "draft", body: "3시에 뵐게요", summary: "", lesson: "it breaks the owner's rule", forbid: [], everywhere: true }) };
	const r = room([first, rewrite], [violations([{ rule: 1, quote: "3시에 봐", why: "반말" }]), violations([])]);
	const learned: unknown[] = [];
	const made = await makeDraft({ ...r.ctx, deps: { ...r.ctx.deps, onRevise: (_chatId, l) => void learned.push(l) } }, r.config, DIRECT, undefined, { code: "old", draft: "3시에 뵙겠습니다", change: "반말로 편하게 바꿔 줘" });
	expect(learned).toEqual([{ line: "친한 사이에는 반말로 쓴다", forbid: [], everywhere: false }]);
	expect(made).toMatchObject({ ok: true, learned: { line: "친한 사이에는 반말로 쓴다", everywhere: false } });
	expect(r.judgeCalls[0]).toContain("Standing rules (the owner set these; they always hold):\n1. 존댓말로 쓴다\n\nPast corrections, newest first:\n2. 약속은 시간을 먼저 말한다\n\nThe owner's request for this draft (it wins: never report a rule that this request overrides or conflicts with):\n반말로 편하게 바꿔 줘\n");
	r.close();
});

test("a KakaoTalk revise whose judged rewrite fails the lint stores the first try and teaches its lesson", async () => {
	const first: ModelReply = { text: JSON.stringify({ action: "draft", body: "3시에 봐", summary: "", lesson: "친한 사이에는 반말로 쓴다", forbid: [], everywhere: false }) };
	const rewrite: ModelReply = { text: JSON.stringify({ action: "draft", body: "[이름]님 3시에 뵐게요", summary: "", lesson: "it breaks the owner's rule", forbid: [], everywhere: true }) };
	const r = room([first, rewrite], [violations([{ rule: 1, quote: "3시에 봐", why: "반말" }]), violations([])]);
	const made = await makeDraft(r.ctx, r.config, DIRECT, undefined, { code: "old", draft: "3시에 뵙겠습니다", change: "반말로 편하게 바꿔 줘" });
	expect(made).toMatchObject({ ok: true, learned: { line: "친한 사이에는 반말로 쓴다", forbid: [], everywhere: false } });
	expect((await r.pending()).map(d => [d.text, d.notes])).toEqual([["3시에 봐", [NOTE]]]);
	r.close();
});

test("the KakaoTalk judge reads the newest end of a long chat window, down to the line the draft answers", async () => {
	const long = Array.from({ length: 12 }, (_, i): FixtureMsg => ({ logId: BASE_LOG + BigInt(10 + i), chatId: ROOM.direct, authorId: 2001, message: `[line-${i}] ${"이야기".repeat(70)}`, sentAt: BASE_TIME + (10 + i) * 10 }));
	const newest: FixtureMsg = { logId: BASE_LOG + 30n, chatId: ROOM.direct, authorId: 2001, message: "그럼 내일 3시 어때요?", sentAt: BASE_TIME + 300 };
	const r = room(["3시에 뵐게요"], [violations([])], { messages: [...long, newest] });
	await r.run();
	expect(r.judgeCalls[0]).toMatch(/그럼 내일 3시 어때요\?\nMESSAGE>>>/);
	expect(r.judgeCalls[0]).not.toContain("[line-0]");
	r.close();
});

test("a room with no standing rule and no correction makes no judge call", async () => {
	const r = room(["3시에 봐"], [violations([{ rule: 1, quote: "3시에 봐", why: "x" }])], { hint: { rules: ["짧게 쓴다"], corrections: [], forbidden: [], samples: [] } });
	await r.run();
	expect(r.judgeCalls).toHaveLength(0);
	expect((await r.pending()).map(d => [d.text, d.notes ?? []])).toEqual([["3시에 봐", []]]);
	r.close();
});
