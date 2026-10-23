// compose --with-comment: the mail draft of hub/mail-cli.ts rides on a comment reply draft and both are approved by one pick. The mail draft,
// its staged file and its sender are the real ones (runner injected, so no mail leaves); the comment side is the real engine with a fake adapter.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runComments } from "../../comments/bin/comments.ts";
import { type CommentAdapter, commentId } from "../../../hub/comments/contract.ts";
import { createEngine } from "../../../hub/comments/engine.ts";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { commentsDir } from "../../../hub/comments/store.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { runMailCli } from "../../../hub/mail-cli.ts";
import { runDraft } from "../bin/draft.ts";
import { paths } from "../lib/settings.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { enable, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
const files = mkdtempSync(join(tmpdir(), "rd-cc-"));
afterAll(() => {
	env.cleanup();
	rmSync(files, { recursive: true, force: true });
});
const score = join(files, "score.pdf");
writeFileSync(score, "pdf bytes");
const BODY = "안녕하세요.\n\n요청하신 악보를 보내드립니다.\n\n감사합니다.";

function setup() {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), commentsDir(env.dir)]) rmSync(p, { force: true, recursive: true });
	enable(env);
	const dir = commentsDir(env.dir);
	const source = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
	const posted: string[] = [];
	const argvs: string[][] = [];
	const deps = {
		run: async (argv: string[]) => (argvs.push(argv), { code: 0, stdout: "", stderr: "" }),
		hub: { post: async () => ({ status: 200 }) },
	};
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "팬", text: "악보 받고 싶어요 fan@example.com", postTitle: "Post one", postLink: "https://youtu.be/p1", at: Date.now() - 1000 }], cursor: "1" }),
		reply: async (_s, _c, text) => (posted.push(text), { ok: true, ref: "r1" }),
		posts: async () => [],
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const engine = createEngine({ dir, now: Date.now, collector: "mac-a", adapters: { youtube: adapter }, mail: realMailLink(deps) });
	return { engine, posted, argvs, deps, id: commentId("youtube", "c1") };
}
type T = ReturnType<typeof setup>;
const compose = (t: T, code: string, extra: string[] = []) =>
	runMailCli(["compose", "--app", "mail", "--to", "fan@example.com", "--subject", "악보 보내드립니다", "--attach", score, "--with-comment", code, ...extra], BODY, t.deps);
async function draftReply(t: T) {
	await t.engine.collect({ force: true });
	const s = await t.engine.addDraft(t.id, "악보는 메일로 보내 드릴게요");
	if (!s.ok) throw new Error(s.reason);
	return s.draft.code;
}

describe("compose --with-comment", () => {
	test("prints ONE card: the reply, then the mail with its file, and nothing is listed as a separate mail ask", async () => {
		const t = setup();
		const code = await draftReply(t);
		const out = await compose(t, code);
		expect(out.code).toBe(0);
		const text = out.lines.join("\n");
		const card = parseDraftApproval(text);
		expect(card).toMatchObject({ toLabel: "대상", to: "팬 댓글", body: "악보는 메일로 보내 드릴게요", ref: code });
		expect(card?.mail).toMatchObject({ toLabel: "받는이", to: "fan@example.com", subject: "악보 보내드립니다", attachments: [{ name: "score.pdf", size: "9B" }] });
		expect(card?.mail?.body).toContain("요청하신 악보를 보내드립니다.");
		expect(card?.mail?.warning).toBeUndefined();
		const mailId = listDrafts()[0]!.id;
		expect(t.engine.store.drafts()[0]).toMatchObject({ code, mail: mailId, clean: false });
		expect(t.engine.mailView(t.engine.store.drafts()[0]!)).toMatchObject({ id: mailId, to: "fan@example.com" });
	});

	test("the mail cannot be sent on its own, and a missing or handled comment draft is refused before a mail is recorded", async () => {
		const t = setup();
		const code = await draftReply(t);
		expect((await compose(t, "Dnone00")).code).toBe(2);
		expect(listDrafts()).toHaveLength(0);
		await compose(t, code);
		const mailId = listDrafts()[0]!.id;
		pick(env, mailId, 1);
		const alone = await runMailCli(["send", "--draft", mailId], "", t.deps);
		expect(alone.code).toBe(1);
		expect(alone.lines[0]).toContain(`comments.ts send ${code}`);
		expect((await runDraft(["send", mailId], "", t.deps)).code).toBe(1);
		expect(t.argvs).toEqual([]);
		expect((await runMailCli(["ask", "--draft", mailId], "", t.deps)).code).toBe(2);
	});

	test("one 보내기 on the card posts the reply and then sends the mail with its file", async () => {
		const t = setup();
		const code = await draftReply(t);
		await compose(t, code);
		const mailId = listDrafts()[0]!.id;
		expect((await runComments(["send", code], t.engine, paths.inbox())).code).toBe(1);
		expect(t.posted).toEqual([]);
		expect(t.argvs).toEqual([]);
		pick(env, code, 1);
		const out = await runComments(["send", code], t.engine, paths.inbox());
		expect(out.code).toBe(0);
		expect(t.posted).toEqual(["악보는 메일로 보내 드릴게요"]);
		expect(t.argvs).toHaveLength(1);
		expect(t.argvs[0]!.slice(0, 5)).toEqual(["zele", "mail", "send", "--to", "fan@example.com"]);
		expect(t.argvs[0]!.some(a => a.endsWith("score.pdf"))).toBe(true);
		expect(getDraft(mailId)?.status).toBe("sent");
	});

	test("a mail the sender refuses leaves the reply posted, says so, and the mail can be asked for again alone", async () => {
		const t = setup();
		const code = await draftReply(t);
		await compose(t, code);
		const mailId = listDrafts()[0]!.id;
		const failing = { ...t.deps, run: async (argv: string[]) => (t.argvs.push(argv), { code: 1, stdout: "", stderr: "smtp refused" }) };
		const engine = createEngine({ dir: commentsDir(env.dir), now: Date.now, collector: "mac-a", adapters: { youtube: { kind: "youtube", list: async () => ({ comments: [] }), reply: async (_s, _c, text) => (t.posted.push(text), { ok: true }), posts: async () => [] } }, mail: realMailLink(failing) });
		pick(env, code, 1);
		const out = await runComments(["send", code], engine, paths.inbox());
		expect(out.code).toBe(1);
		expect(out.lines[0]).toContain("답글은 올렸지만 메일은 보내지 못했어요");
		expect(t.posted).toHaveLength(1);
		expect(getDraft(mailId)?.status).toBe("pending");
		const again = await runMailCli(["ask", "--draft", mailId], "", t.deps);
		expect(again.code).toBe(0);
		expect(parseDraftApproval(again.lines[0]!)).toMatchObject({ to: "fan@example.com", subject: "악보 보내드립니다" });
	});

	test("composing again for the same card replaces the earlier mail and 보내지 않기 drops it", async () => {
		const t = setup();
		const code = await draftReply(t);
		await compose(t, code);
		const first = listDrafts()[0]!.id;
		await compose(t, code, ["--subject", "악보 다시 보내드립니다"]);
		const second = listDrafts().find(d => d.id !== first)!.id;
		expect(getDraft(first)?.status).toBe("dropped");
		expect(t.engine.store.drafts()[0]!.mail).toBe(second);
		expect((await runComments(["drop", code], t.engine, paths.inbox())).code).toBe(0);
		expect(getDraft(second)?.status).toBe("dropped");
		expect(t.posted).toEqual([]);
	});
});
