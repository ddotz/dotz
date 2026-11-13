// The comment adapter of the one reply flow (design 1.8 column 3) over a real engine with an injected platform, model and mail link.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommentAdapter, RawComment, SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailView } from "./engine.ts";
import { commentAdapter } from "./reply-adapter.ts";

const NOW = Date.parse("2026-11-13T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const raw: RawComment = { native: "c1", thread: "p1", author: "팬", text: "다음 편 언제 올라와요?", postTitle: "Post one", at: NOW - 1000 };
const reply = (body: string, lesson = "") => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [], lesson })}\n\`\`\``;
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "comment-adapter-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(o: { model?: string[]; learn?: string[] } = {}) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const platform: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [raw], cursor: "1" }), reply: async () => ({ ok: true, ref: "r1" }), posts: async () => [] };
	const mails = new Map<string, MailView>([["RMAIL01", { id: "RMAIL01", to: "fan@example.com", subject: "자료", body: "보내드려요", attachments: [] }]]);
	const mail: MailLink = { compose: async () => ({ ok: false, reason: "x" }), send: async () => ({ ok: true, text: "" }), drop: () => undefined, revise: async () => ({ ok: false, reason: "x" }), view: id => mails.get(id), edit: (id, text) => (mails.set(id, { ...mails.get(id)!, body: text }), { ok: true }) };
	let n = 0;
	const outs = o.model ?? [reply("이번 주말이에요!")];
	const engine = createEngine({ dir, now: () => NOW, collector: "mac", adapters: { youtube: platform }, model: async () => ({ text: outs[Math.min(n++, outs.length - 1)]! }), mail, learn: (_s, line) => void o.learn?.push(line), style: () => ({ rules: [], corrections: [], forbidden: ["무조건"], samples: [] }) });
	return { engine, a: commentAdapter(engine) };
}
async function drafted(engine: ReturnType<typeof createEngine>): Promise<string> {
	await engine.collect();
	const c = engine.store.comments()[0]!;
	const step = await engine.makeDraft(c.id);
	if (!step.ok) throw new Error(step.reason);
	return step.draft.code;
}

test("get and list read a pending draft as the one view; another kind's ref is not this adapter's", async () => {
	const { engine, a } = setup();
	const code = await drafted(engine);
	expect(await a.get(code)).toMatchObject({ kind: "comment", item: `comment:${engine.store.comments()[0]!.id}`, conv: "comment:youtube", draft: { state: "pending", text: "이번 주말이에요!", to: "팬 댓글" }, original: { who: "팬" } });
	expect((await a.list()).map(v => v.ref)).toEqual([code]);
	expect(await a.get("RAAAAAA")).toBeUndefined();
	expect(a.target(code)).toEqual({ kind: "comment", lane: "comment:youtube" });
	expect(a.question(code)).toBe(`이 답글 올릴까요? (${code})`);
});

test("revise stores a new draft that replaces the old, returns the lesson and records nothing itself; the linked mail keeps its id (incident #68)", async () => {
	const learned: string[] = [];
	const { engine, a } = setup({ model: [reply("이번 주말이에요!"), reply("토요일 저녁에 올라가요!", "날짜는 요일로 말한다")], learn: learned });
	const code = await drafted(engine);
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01" });
	const r = await a.revise(code, "요일로 말해 줘");
	expect(r).toMatchObject({ ok: true, replaces: code, lesson: { key: { app: "youtube" }, line: "날짜는 요일로 말한다" } });
	expect(learned).toEqual([]);
	const next = r.ok ? await a.get(r.ref) : undefined;
	expect(next?.draft).toMatchObject({ text: "토요일 저녁에 올라가요!", replaces: { ref: code, text: "이번 주말이에요!" }, mail: { ref: "RMAIL01" } });
	const card = r.ok ? (await a.ask(r.ref))! : "";
	expect(card.split("RMAIL01").length - 1).toBe(1);
	expect((await a.get(code))!.draft.state).toBe("stale");
});

test("the engine's own revise (the skill CLI) still learns, after the new draft is stored", async () => {
	const learned: string[] = [];
	const { engine } = setup({ model: [reply("이번 주말이에요!"), reply("토요일 저녁에 올라가요!", "날짜는 요일로 말한다")], learn: learned });
	const code = await drafted(engine);
	expect((await engine.revise(code, "요일로")).ok).toBe(true);
	expect(learned).toEqual(["날짜는 요일로 말한다"]);
});

test("edit keeps the code, stores the owner's text, makes the draft unclean and refuses a forbidden word; learned speaks only after it was sent", async () => {
	const { engine, a } = setup();
	const code = await drafted(engine);
	expect(await a.edit(code, "무조건 토요일!")).toMatchObject({ ok: false, reason: { code: "forbidden_word" } });
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const d = engine.store.drafts().find(x => x.code === code)!;
	expect([d.text, d.clean, d.editedFrom]).toEqual(["토요일에 올릴게요 :)", false, "이번 주말이에요!"]);
	expect(await a.learned!(code)).toBeUndefined();
	expect(await a.markSent(code)).toEqual({ ok: true });
	expect((await a.learned!(code))?.line).toContain("토요일에 올릴게요");
	expect(await a.prove!(code)).toBe("sent");
});

test("drop then restore; the mail part of an edit goes to the mail link", async () => {
	const { engine, a } = setup();
	const code = await drafted(engine);
	expect(await a.drop(code)).toEqual({ ok: true });
	expect((await a.get(code))!.draft.state).toBe("dropped");
	expect(await a.restore(code)).toEqual({ ok: true });
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01" });
	expect(await a.edit(code, "메일은 제가 쓴 대로요", "mail")).toEqual({ ok: true });
	expect((await a.get(code))!.draft.mail?.text).toBe("메일은 제가 쓴 대로요");
});
