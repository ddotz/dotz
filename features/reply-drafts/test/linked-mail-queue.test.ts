// A comment reply and the mail that answers the same comment (autoMail, compose --with-comment / --origin comment:<id>) in the one reply queue:
// the mail riding on a waiting reply is one card with it, a mail left behind after 답글만 보내기 is its own open card, and a reply whose words say the
// mail was sent is held while that mail still waits. Real reply-drafts and comment stores; the platform and the mail runner are injected, so nothing leaves.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run as runComments } from "../../comments/bin/comments.ts";
import { type CommentAdapter, commentId } from "../../../hub/comments/contract.ts";
import { createEngine } from "../../../hub/comments/engine.ts";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { commentAdapter } from "../../../hub/comments/reply-adapter.ts";
import { commentsDir } from "../../../hub/comments/store.ts";
import { runMailCli } from "../../../hub/mail-cli.ts";
import { mailAdapter } from "../../../hub/reply-mail.ts";
import { paths } from "../lib/settings.ts";
import { getDraft, listDrafts } from "../lib/store.ts";
import { enable, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(() => env.cleanup());
const ADDRESS = "메일주소A@example.com";
const FILE = join(env.dir, "자료A.pdf");
writeFileSync(FILE, "pdf bytes");
const BODY = "안녕하세요.\n\n요청하신 자료를 보내드립니다.\n\n감사합니다.";

let t: ReturnType<typeof setup>;
beforeEach(() => {
	t = setup();
});

function setup() {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), commentsDir(env.dir)]) rmSync(p, { force: true, recursive: true });
	enable(env);
	const dir = commentsDir(env.dir);
	const posted: string[] = [];
	const sent: string[][] = [];
	const deps = { run: async (argv: string[]) => (argv[1] === "whoami" || sent.push(argv), { code: 0, stdout: "", stderr: "" }), hub: { post: async () => ({ status: 200 }) } };
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "p1", author: "작성자A", text: `자료 파일 받고 싶어요 ${ADDRESS}`, postTitle: "글A", at: Date.now() - 1000 }], cursor: "1" }),
		reply: async (_s, _c, text) => (posted.push(text), { ok: true, ref: "r1" }),
		posts: async () => [],
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false } } }));
	const engine = createEngine({ dir, now: Date.now, collector: "mac-a", adapters: { youtube: adapter }, mail: realMailLink(deps) });
	return { engine, deps, posted, sent, id: commentId("youtube", "c1") };
}

async function reply(text: string): Promise<string> {
	await t.engine.collect({ force: true });
	const s = await t.engine.addDraft(t.id, text);
	if (!s.ok) throw new Error(s.reason);
	return s.draft.code;
}
const compose = (extra: string[]) => runMailCli(["compose", "--app", "mail", "--to", ADDRESS, "--subject", "자료A 보내드립니다", "--attach", FILE, ...extra], BODY, t.deps);
const mailRefs = async () => (await mailAdapter().list()).map(v => v.ref);

test("the mail riding on a waiting reply is one card: the queue shows it inside the comment item, never as a mail item of its own", async () => {
	const code = await reply("메일로 보내 드릴게요");
	expect((await compose(["--with-comment", code])).code).toBe(0);
	const mailId = listDrafts()[0]!.id;
	const comments = await commentAdapter(t.engine).list();
	expect(comments.map(v => [v.ref, v.draft.mail?.ref])).toEqual([[code, mailId]]);
	expect(await mailRefs()).not.toContain(mailId);
});

test("after 답글만 보내기 the mail left behind is its own open card in the queue", async () => {
	const code = await reply("메일로 보내 드릴게요");
	await compose(["--with-comment", code]);
	const mailId = listDrafts()[0]!.id;
	pick(env, code, 1);
	expect((await runComments(["send", code, "--only", "reply"], t.engine, paths.inbox())).code).toBe(0);
	expect(getDraft(mailId)?.status).toBe("pending");
	expect(await commentAdapter(t.engine).list()).toEqual([]);
	expect(await mailRefs()).toEqual([mailId]);
});

test("a pending mail made for a comment whose reply already went out (origin comment:<id>) is listed when the queue is built", async () => {
	const code = await reply("메일로 보내 드릴게요");
	pick(env, code, 1);
	expect((await runComments(["send", code], t.engine, paths.inbox())).code).toBe(0);
	expect((await compose(["--origin", `comment:${t.id}`])).code).toBe(0);
	const mail = listDrafts()[0]!;
	expect(mail.origin).toMatchObject({ kind: "comment", id: t.id });
	expect(await mailRefs()).toEqual([mail.id]);
});

test("답글만 보내기 of a reply that says the mail was sent is held while its mail still waits: nothing goes", async () => {
	const code = await reply("요청하신 자료는 메일로 보내드렸습니다");
	await compose(["--with-comment", code]);
	const mailId = listDrafts()[0]!.id;
	pick(env, code, 1);
	const r = t.engine.send(code, { by: "owner", only: "reply" });
	expect(r).toMatchObject({ ok: false, code: "mail_claim_unsent" });
	const out = await runComments(["send", code, "--only", "reply"], t.engine, paths.inbox());
	expect(out.code).toBe(1);
	expect(t.posted).toEqual([]);
	expect(getDraft(mailId)?.status).toBe("pending");
	expect(t.engine.store.drafts().find(d => d.code === code)?.status).toBe("pending");
});

test("a reply that says the mail was sent is held while a mail made for the same comment (origin comment:<id>) still waits", async () => {
	expect((await compose(["--origin", `comment:${t.id}`])).code).toBe(0);
	const mailId = listDrafts()[0]!.id;
	const code = await reply("메일로 보내드렸어요. 확인해 주세요");
	expect(t.engine.store.drafts().find(d => d.code === code)?.mail).toBeUndefined();
	pick(env, code, 1);
	expect(t.engine.send(code, { by: "owner" })).toMatchObject({ ok: false, code: "mail_claim_unsent" });
	expect(t.posted).toEqual([]);
	expect(getDraft(mailId)?.status).toBe("pending");
});

test("1) 보내기 of the one card sends the reply and then its mail, even when the reply says the mail was sent", async () => {
	const code = await reply("요청하신 자료는 메일로 보내드렸습니다");
	await compose(["--with-comment", code]);
	const mailId = listDrafts()[0]!.id;
	pick(env, code, 1);
	const out = await runComments(["send", code], t.engine, paths.inbox());
	expect(out.code).toBe(0);
	expect(t.posted).toEqual(["요청하신 자료는 메일로 보내드렸습니다"]);
	expect(getDraft(mailId)?.status).toBe("sent");
});
