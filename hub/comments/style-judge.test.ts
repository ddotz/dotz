import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentAdapter, commentId, type SourceConfig } from "./contract.ts";
import { createEngine, type DraftModel, type ModelReply } from "./engine.ts";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const reply = (body: string): ModelReply => ({ text: `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "thanks", to: "", body, questions: [] })}\n\`\`\`` });
const violations = (vs: object[]): ModelReply => ({ text: JSON.stringify({ violations: vs }) });

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-judge-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function engineWith(bodies: string[], judged: ModelReply[] | undefined) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "A", text: "영상 잘 봤어요 감사합니다!", postTitle: "Post one", at: NOW - 1000 }], cursor: "1" }),
		reply: async () => ({ ok: true, ref: "ref1" }),
		posts: async () => [{ id: "p1", title: "Post one" }],
	};
	const drafts: string[] = [], judges: { user: string; app?: string }[] = [];
	const model: DraftModel = async (_system, user) => (drafts.push(user), reply(bodies[Math.min(drafts.length - 1, bodies.length - 1)]!));
	const judge: DraftModel | undefined = judged && (async (_system, user, app) => (judges.push({ user, app }), judged[Math.min(judges.length - 1, judged.length - 1)]!));
	const engine = createEngine({ dir, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, model, ...(judge ? { judge } : {}), style: () => ({ standing: ["감사 댓글에는 이모지를 붙이지 않는다"], rules: [], corrections: [], forbidden: [], samples: [] }) });
	await engine.collect({ force: true });
	return { engine, drafts, judges };
}

test("a comment draft is judged on the engine's judge call with the comment it answers; a rewrite that still breaks the rule carries the 확인 note", async () => {
	const t = await engineWith(["고마워요 😊", "고마워요 😊"], [violations([{ rule: 1, quote: "고마워요 😊", why: "이모지" }])]);
	const step = await t.engine.makeDraft(commentId("youtube", "c1"));
	expect(t.drafts).toHaveLength(2);
	expect(t.judges).toHaveLength(2);
	expect(t.judges[0]!.user).toContain("1. 감사 댓글에는 이모지를 붙이지 않는다");
	expect(t.judges[0]!.user).toContain("영상 잘 봤어요 감사합니다!");
	expect(t.judges[0]!.app).toBe("youtube");
	expect(step.ok && [step.draft.text, step.draft.notes, step.draft.clean]).toEqual(["고마워요 😊", ["확인: 말투 조건과 달라 보여요: 감사 댓글에는 이모지를 붙이지 않는다"], false]);
});

test("a comment engine without a judge (guard.style_judge false) drafts in one call", async () => {
	const t = await engineWith(["고마워요 😊"], undefined);
	const step = await t.engine.makeDraft(commentId("youtube", "c1"));
	expect(t.drafts).toHaveLength(1);
	expect(step.ok && step.draft.notes).toEqual([]);
});
