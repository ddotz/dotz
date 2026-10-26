// End to end with fakes: a collected comment -> reply draft carrying a mail with a file (the real mail link of hub/comments/mail-link.ts,
// so the mail is a reply-drafts compose draft with a staged file) -> the owner's pick 1) 보내기 -> `comments.ts send` -> the platform reply
// (fake adapter) and then `zele mail send --attach` (fake runner). The web button path (POST /api/comments/drafts/<code>/send) is the
// owner's own click. Nothing real is posted or sent.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runComments } from "../../features/comments/bin/comments.ts";
import { stagedFiles } from "../../features/reply-drafts/lib/staged.ts";
import { getDraft } from "../../features/reply-drafts/lib/store.ts";
import type { Runner } from "../../features/reply-drafts/lib/tone.ts";
import { parseDraftApproval } from "../draft-approval.ts";
import { runMailCli } from "../mail-cli.ts";
import { commentAsk } from "./ask.ts";
import { type CommentAdapter, commentId, type SourceConfig } from "./contract.ts";
import { createEngine } from "./engine.ts";
import { realMailLink } from "./mail-link.ts";
import { commentsDir } from "./store.ts";
import { createCommentsWeb } from "./web.ts";

const NOW = Date.parse("2026-10-26T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const before = process.env.DOTZ_DIR;
let dir: string;
let score: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cm-e2e-"));
	process.env.DOTZ_DIR = dir;
	score = join(dir, "캐논.pdf");
	writeFileSync(score, "pdf");
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});

function world(o: { replyFails?: string; zeleFails?: boolean } = {}) {
	const root = commentsDir(dir);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const posted: string[] = [];
	const zele: string[][] = [];
	let replyFails = o.replyFails;
	let zeleFails = o.zeleFails;
	const run: Runner = async argv => (zele.push(argv), zeleFails ? { code: 1, stdout: "", stderr: "smtp refused" } : { code: 0, stdout: "", stderr: "" });
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "v1", author: "팬", text: "캐논 악보 받을 수 있나요? fan@example.com", postTitle: "캐논 연주", at: NOW - 1000 }], cursor: "1" }),
		reply: async (_s, _c, text) => (posted.push(text), replyFails ? { ok: false, reason: replyFails } : { ok: true, ref: "yt-r1" }),
	};
	const engine = createEngine({ dir: root, now: () => NOW, collector: "mac-a", adapters: { youtube: adapter }, mail: realMailLink({ run }) });
	const inbox = join(dir, "inbox.jsonl");
	const pick = (code: string, n: 1 | 3 = 1) => {
		const label = n === 1 ? "보내기" : "보내지 않기";
		appendFileSync(inbox, `${JSON.stringify({ ts: new Date(NOW + 5000).toISOString(), kind: "message", source: "web", text: `${n}) ${label}`, picks: [{ q: `이 답글을 올리고 메일도 보낼까요? (${code})`, n, label }] })}\n`);
	};
	const recover = () => {
		replyFails = undefined;
		zeleFails = false;
	};
	return { engine, posted, zele, mailSends: () => zele.filter(a => a[2] === "send"), inbox, pick, recover };
}
type World = ReturnType<typeof world>;

async function card(w: World) {
	await w.engine.collect({ force: true });
	const s = await w.engine.addDraft(commentId("youtube", "c1"), "악보는 메일로 보내 드렸어요", undefined, { app: "mail", to: "fan@example.com", subject: "캐논 악보 보내드립니다", body: "요청하신 캐논 악보 보내드립니다.", attach: [score] });
	if (!s.ok) throw new Error(s.reason);
	const ask = commentAsk(source, w.engine.store.comments()[0]!, s.draft, undefined, w.engine.mailView(s.draft));
	return { d: s.draft, mailId: s.draft.mail!, ask };
}

describe("comment reply + mail: 1) 보내기 -> reply posted -> mail sent with the file", () => {
	test("the card shows both parts with the file; the pick posts once and sends the mail once with --attach", async () => {
		const w = world();
		const { d, mailId, ask } = await card(w);
		expect(parseDraftApproval(ask)).toMatchObject({ toLabel: "대상", to: "팬 댓글", ref: d.code, mail: { to: "fan@example.com", attachments: [{ name: "캐논.pdf" }] } });
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(1);
		expect(w.posted).toEqual([]);
		expect(w.zele).toEqual([]);
		w.pick(d.code);
		expect(await runComments(["send", d.code], w.engine, w.inbox)).toEqual({ lines: [`답글을 올리고 메일을 보냈어요 (${d.code})`], code: 0 });
		expect(w.posted).toEqual(["악보는 메일로 보내 드렸어요"]);
		expect(w.mailSends()).toEqual([["zele", "mail", "send", "--to", "fan@example.com", "--subject", "캐논 악보 보내드립니다", "--body", "요청하신 캐논 악보 보내드립니다.", "--attach", stagedFiles(mailId)[0]!.path]]);
		expect(w.engine.store.drafts()[0]!.status).toBe("sent");
		expect(getDraft(mailId)!.status).toBe("sent");
		w.pick(d.code);
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(1);
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toHaveLength(1);
	});

	test("the mail of the card cannot be sent on its own, before or instead of the reply", async () => {
		const w = world();
		const { mailId } = await card(w);
		appendFileSync(w.inbox, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `이 메일 보낼까요? (${mailId})`, n: 1, label: "보내기" }] })}\n`);
		const alone = await runMailCli(["send", "--draft", mailId], "", { run: async () => ({ code: 0, stdout: "", stderr: "" }), hub: { post: async () => ({ status: 200 }) } });
		expect(alone.code).toBe(1);
		expect(alone.lines[0]).toContain("한 장으로 승인해요");
		expect(w.zele).toEqual([]);
	});

	test("a failed reply sends no mail and keeps the card; after the platform recovers the same pick posts and sends once", async () => {
		const w = world({ replyFails: "quota exceeded" });
		const { d, mailId } = await card(w);
		w.pick(d.code);
		const out = await runComments(["send", d.code], w.engine, w.inbox);
		expect(out.code).toBe(1);
		expect(out.lines[0]).toBe("답글을 올리지 못했어요 (메일도 보내지 않았어요): quota exceeded");
		expect(w.zele).toEqual([]);
		expect(w.engine.store.drafts()[0]!.status).toBe("pending");
		expect(getDraft(mailId)!.status).toBe("pending");
		w.recover();
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(0);
		expect(w.posted).toHaveLength(2);
		expect(w.mailSends()).toHaveLength(1);
	});

	test("a failed mail is told with its draft id; the reply stays posted and the mail goes out after its own card is approved", async () => {
		const w = world({ zeleFails: true });
		const { d, mailId } = await card(w);
		w.pick(d.code);
		const out = await runComments(["send", d.code], w.engine, w.inbox);
		expect(out.code).toBe(1);
		expect(out.lines[0]).toContain("답글은 올렸지만 메일은 보내지 못했어요");
		expect(out.lines[0]).toContain(`메일 초안 ${mailId}은 남아 있어요`);
		expect(getDraft(mailId)!.status).toBe("pending");
		w.recover();
		const hub = { post: async () => ({ status: 200 }) };
		const ask = await runMailCli(["ask", "--draft", mailId], "", { hub });
		expect(parseDraftApproval(ask.lines[0]!)).toMatchObject({ ref: mailId, attachments: [{ name: "캐논.pdf" }] });
		appendFileSync(w.inbox, `${JSON.stringify({ ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `이 메일 보낼까요? (${mailId})`, n: 1, label: "보내기" }] })}\n`);
		const run: Runner = async argv => (w.zele.push(argv), { code: 0, stdout: "", stderr: "" });
		expect((await runMailCli(["send", "--draft", mailId], "", { run, hub })).code).toBe(0);
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toHaveLength(2);
		expect(getDraft(mailId)!.status).toBe("sent");
	});

	test("the web 보내기 button tapped twice posts once and sends the mail once", async () => {
		const w = world();
		const { d } = await card(w);
		const web = createCommentsWeb({ engine: w.engine, broadcast: () => {} });
		const tap = () => {
			const url = new URL(`http://x/api/comments/drafts/${d.code}/send`);
			return web.route(new Request(url, { method: "POST", body: "{}" }), url, url.pathname.split("/").filter(Boolean));
		};
		const [a, b] = await Promise.all([tap(), tap()]);
		expect([a!.status, b!.status].sort()).toEqual([202, 409]);
		await web.idle();
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toHaveLength(1);
		expect(w.engine.store.replies()[0]).toMatchObject({ state: "sent", mail: { state: "sent" } });
	});
});
