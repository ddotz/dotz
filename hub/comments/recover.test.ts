// A reply cut off by a restart: nobody knows whether it went up. It is sent only on proof read back from the platform, otherwise it waits for the owner, and nothing posts it by itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOutcomes } from "../reply-outcomes.ts";
import type { CommentAdapter, RawComment, SourceConfig, SourceKind } from "./contract.ts";
import { createEngine } from "./engine.ts";
import type { Reply } from "./store.ts";

const NOW = Date.parse("2026-11-05T00:00:00.000Z");
const ID = "send:cm:s:c1";
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comments-recover-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const own = (o: Partial<RawComment> = {}): RawComment => ({ native: "r1", thread: "p1", parent: "c1", author: "me", text: "고마워요\n또 오세요", postTitle: "글", at: NOW, mine: true, ...o });

function world(kind: SourceKind, adapter: Partial<CommentAdapter>, o: { thread?: string; state?: Reply["state"]; autoSend?: boolean } = {}) {
	const thread = o.thread ?? "p1";
	const src: SourceConfig = { key: "s", kind, label: "출처", watch: ["*"], autoDraft: false, ...(o.autoSend ? { autoSend: { on: true, match: ["."], max_per_day: 9 } } : {}) };
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { s: src } }));
	const posted: string[] = [];
	const full: CommentAdapter = { kind, list: async () => ({ comments: [] }), reply: async (_s, _c, text) => (posted.push(text), { ok: true, ref: "new" }), ...adapter };
	const engine = createEngine({ dir, now: () => NOW, collector: "t", adapters: { [kind]: full }, model: async () => ({ text: "", inputTokens: 0, outputTokens: 0 }) });
	engine.store.addComments([{ id: "cm:s:c1", source: "s", native: "c1", thread, author: "A", text: "질문", postTitle: "글", at: NOW - 1000, mine: false, collector: "t" }]);
	engine.store.putDraft({ code: "D1", commentId: "cm:s:c1", source: "s", thread, text: "고마워요 또 오세요", status: "pending", created: NOW - 500, changes: [], clean: true, notes: [] });
	engine.store.putReply({ id: ID, commentId: "cm:s:c1", source: "s", thread, text: "고마워요 또 오세요", state: o.state ?? "sending", at: NOW - 100, draft: "D1", via: "owner", collector: "t" });
	const reply = () => engine.store.replies().find(r => r.id === ID)!;
	const draft = () => engine.store.drafts().find(d => d.code === "D1")!;
	return { engine, posted, reply, draft };
}

test("a reply left sending ends unsure, not sent, and no send goes through the gate by itself", () => {
	const w = world("youtube", {}, { autoSend: true });
	expect(w.engine.leaveUnsure()).toBe(1);
	expect(w.reply().state).toBe("unsure");
	expect(w.reply().reason).toBeTruthy();
	expect(w.draft().status).toBe("pending");
	expect(w.engine.send("D1", { by: "owner" })).toMatchObject({ ok: false });
	expect(w.engine.send("D1", { by: "rule" })).toMatchObject({ ok: false });
	expect(w.posted).toEqual([]);
	expect(w.engine.leaveUnsure()).toBe(0);
});

describe("read back", () => {
	test("YouTube: the owner's reply with the same words under the comment proves it, whatever the line breaks", async () => {
		const w = world("youtube", { recheck: async (_s, open) => (expect(open.map(c => c.native)).toEqual(["c1"]), { comments: [own()], gone: [] }) });
		w.engine.leaveUnsure();
		expect((await w.engine.proveSends()).proved).toEqual([ID]);
		expect(w.reply()).toMatchObject({ state: "sent" });
		expect(w.reply().reason).toBeUndefined();
		expect(w.draft().status).toBe("sent");
		expect(w.posted).toEqual([]);
	});

	test("Instagram: an owner's reply under a reply counts under its top comment", async () => {
		const w = world("instagram", { recheck: async () => ({ comments: [own({ parent: "top" })], gone: [] }) });
		const c = w.engine.store.comments()[0]!;
		w.engine.store.patchComments({ [c.id]: { parent: "top" } });
		w.engine.leaveUnsure();
		expect((await w.engine.proveSends()).proved).toEqual([ID]);
	});

	test("a website without a re-check is read through its list", async () => {
		const site = world("website", { list: async () => ({ comments: [own()] }) });
		site.engine.leaveUnsure();
		expect((await site.engine.proveSends()).proved).toEqual([ID]);
	});

	test("a private message is proved by its room", async () => {
		const dm = world("website", { list: async () => ({ comments: [own({ thread: "dm:r", parent: undefined })] }) }, { thread: "dm:r" });
		dm.engine.leaveUnsure();
		expect((await dm.engine.proveSends()).proved).toEqual([ID]);
	});

	test.each<[string, RawComment[]]>([["other words", [own({ text: "다른 답" })]], ["another comment", [own({ parent: "c2" })]], ["someone else's row", [own({ mine: false })]], ["nothing", []]])("%s proves nothing: it stays unsure", async (_name, comments) => {
		const w = world("youtube", { recheck: async () => ({ comments, gone: [] }) });
		w.engine.leaveUnsure();
		expect((await w.engine.proveSends()).proved).toEqual([]);
		expect(w.reply().state).toBe("unsure");
	});

	test("a private message older than the one it answers proves nothing", async () => {
		const old = world("website", { list: async () => ({ comments: [own({ thread: "dm:r", parent: undefined, at: NOW - 5000 })] }) }, { thread: "dm:r" });
		old.engine.leaveUnsure();
		expect((await old.engine.proveSends()).proved).toEqual([]);
	});

	test("a failed read proves nothing and posts nothing", async () => {
		const broken = world("youtube", { recheck: async () => { throw new Error("읽기 실패"); } });
		broken.engine.leaveUnsure();
		expect(await broken.engine.proveSends()).toMatchObject({ proved: [], errors: [expect.stringContaining("읽기 실패")] });
		expect(broken.reply().state).toBe("unsure");
		expect(broken.posted).toEqual([]);
	});
});

test("the watch's reconcile leaves a reply it cannot judge alone: the draft stays open for the owner", async () => {
	const w = world("youtube", { recheck: async () => ({ comments: [own({ text: "손으로 쓴 답" })], gone: [] }) }, { state: "unsure" });
	await w.engine.reconcile({ recheck: true });
	expect(w.draft().status).toBe("pending");
});

test("the owner's two choices: 다시 보내기 posts once, 완료 posts nothing; neither works on a reply that is not unsure", async () => {
	const again = world("youtube", {}, { state: "unsure" });
	const r = again.engine.retrySend(ID);
	expect(r.ok && (await r.done).state).toBe("sent");
	expect(again.posted).toEqual(["고마워요 또 오세요"]);
	expect(again.reply().attempts).toBe(2);

	const done = world("youtube", {}, { state: "unsure" });
	expect(done.engine.markPosted(ID)).toEqual({ ok: true });
	expect(done.reply().state).toBe("sent");
	expect(done.draft().status).toBe("sent");
	expect(done.posted).toEqual([]);
	expect(done.engine.markPosted(ID)).toMatchObject({ ok: false });
});

test("the record cannot be wiped: 지우기 would open the gate for a second post", () => {
	const w = world("youtube", {}, { state: "unsure" });
	expect(w.engine.dismissSend(ID)).toMatchObject({ ok: false });
	expect(w.reply().state).toBe("unsure");
});

test("the 답장 대기 list shows it as a row of its own, marked unsure", () => {
	const w = world("youtube", {}, { state: "unsure" });
	const src = w.engine.store.config().sources.s!;
	const { failed, sent } = collectOutcomes({ notices: [], sendKind: () => undefined, appOf: () => undefined, comments: { sources: { s: { src, app: "youtube" } }, drafts: w.engine.store.drafts(), replies: w.engine.store.replies(), comments: [] }, kakao: { sends: [], drafts: {} }, since: 0, now: NOW });
	expect(sent).toEqual([]);
	expect(failed).toMatchObject([{ kind: "comment", ref: "D1", sendId: ID, unsure: true }]);
});
