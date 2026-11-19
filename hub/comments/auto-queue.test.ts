import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentAdapter, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";

const NOW = Date.parse("2026-11-19T00:00:00.000Z");
const answer = `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body: "답글이에요", questions: [] })}\n\`\`\``;
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "auto-queue-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function world(model: () => Promise<{ text: string }>) {
	const src: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: true, autoSince: 0 };
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: src } }));
	const adapter: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "팬", text: "질문이에요?", postTitle: "글", at: NOW - 1000 }] }), reply: async () => ({ ok: true }) };
	const calls = { n: 0 };
	const engine = createEngine({ dir, now: () => NOW, collector: "t", adapters: { youtube: adapter }, model: async () => (calls.n++, model()) });
	return { engine, calls };
}

test("a model failure keeps the comment queued: the next collect drafts it", async () => {
	let n = 0;
	const w = world(async () => {
		if (++n === 1) throw new Error("rate limit");
		return { text: answer };
	});
	const first = await w.engine.collect({ force: true });
	expect(first.drafted).toEqual([]);
	expect(w.engine.store.cursors().youtube?.queue).toEqual(["cm:youtube:c1"]);
	const second = await w.engine.collect({ force: true });
	expect(second.drafted).toHaveLength(1);
	expect(w.engine.store.cursors().youtube?.queue).toBeUndefined();
	expect(w.engine.store.cursors().youtube?.tries).toBeUndefined();
});

test("three failures drop the comment with a reported reason and no fourth model call", async () => {
	const w = world(async () => {
		throw new Error("model rate limit");
	});
	const runs = [await w.engine.collect({ force: true }), await w.engine.collect({ force: true })];
	expect(runs.map(r => r.errors.youtube)).toEqual([undefined, undefined]);
	const third = await w.engine.collect({ force: true });
	expect(third.errors.youtube).toContain("model rate limit");
	expect(w.engine.store.cursors().youtube?.queue).toBeUndefined();
	await w.engine.collect({ force: true });
	expect(w.calls.n).toBe(3);
});

test("a skip by the model is permanent: no retry", async () => {
	const w = world(async () => ({ text: JSON.stringify({ action: "skip", reason: "emoji only" }) }));
	await w.engine.collect({ force: true });
	expect(w.engine.store.cursors().youtube?.queue).toBeUndefined();
	await w.engine.collect({ force: true });
	expect(w.calls.n).toBe(1);
});
