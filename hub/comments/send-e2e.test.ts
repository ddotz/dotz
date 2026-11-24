// End to end with fakes: a collected comment -> reply draft carrying a mail with a file (the real mail link of hub/comments/mail-link.ts,
// so the mail is a reply-drafts compose draft with a staged file) -> the owner's pick 1) 보내기 -> `comments.ts send` -> the platform reply
// (fake adapter) and then `zele mail send --attach` (fake runner). The owner's own 보내기 (engine.send by the owner) is the other path.
// Nothing real is posted or sent.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, run as runComments } from "../../features/comments/bin/comments.ts";
import { learningSettled, learnSentEdit, toneKey, type FlowDeps } from "../../features/reply-drafts/lib/flow.ts";
import { HEADINGS, profileBullets } from "../../features/reply-drafts/lib/settings.ts";
import { stagedFiles } from "../../features/reply-drafts/lib/staged.ts";
import { getDraft, setStatus } from "../../features/reply-drafts/lib/store.ts";
import type { Runner } from "../../features/reply-drafts/lib/tone.ts";
import { mailHash } from "../../features/reply-drafts/lib/view.ts";
import { parseDraftApproval } from "../draft-approval.ts";
import { runMailCli } from "../mail-cli.ts";
import { commentAsk } from "./ask.ts";
import { type CommentAdapter, commentId, type SourceConfig } from "./contract.ts";
import { createEngine, type Engine, type EngineDeps } from "./engine.ts";
import type { EditLessons } from "./draft-run.ts";
import { lessonOfEdit } from "../reply-mail.ts";
import { approvalHash } from "../draft-approval.ts";
import { commentAdapter } from "./reply-adapter.ts";
import { realMailLink } from "./mail-link.ts";
import { commentsDir } from "./store.ts";
import { appendSealed } from "../approval-seal.ts";
import { reasonOf } from "../reply-reasons.ts";

const NOW = Date.parse("2026-10-26T00:00:00.000Z");
const shownHash = async (engine: Engine, code: string): Promise<string | undefined> => ((v => v && approvalHash(v))(await commentAdapter(engine).get(code)));
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
	const run: Runner = async argv => (zele.push(argv), zeleFails && argv[1] !== "whoami" ? { code: 1, stdout: "", stderr: "smtp refused" } : { code: 0, stdout: "", stderr: "" });
	const adapter: CommentAdapter = {
		kind: "youtube",
		list: async () => ({ comments: [{ native: "c1", thread: "v1", author: "팬", text: "캐논 문서 받을 수 있나요? fan@example.com", postTitle: "캐논 연주", at: NOW - 1000 }], cursor: "1" }),
		reply: async (_s, _c, text) => (posted.push(text), replyFails ? { ok: false, reason: replyFails, code: "rejected", sent: "no" } : { ok: true, ref: "yt-r1" }),
	};
	const clock = { now: NOW };
	const make = (extra: Partial<EngineDeps> = {}, mailDeps: FlowDeps = {}): Engine => createEngine({ dir: root, now: () => clock.now, collector: "mac-a", adapters: { youtube: adapter }, mail: realMailLink({ run, ...mailDeps }), ...extra });
	const engine = make();
	const inbox = join(dir, "inbox.jsonl");
	// A pick names the version the card shows now (hub/reply-actions.ts records its approvalHash).
	const pick = async (code: string, n: 1 | 3 = 1, at = NOW + 5000) => {
		const label = n === 1 ? "보내기" : "보내지 않기";
		const hash = await shownHash(engine, code);
		appendSealed(inbox, { ts: new Date(at).toISOString(), kind: "message", source: "web", text: `${n}) ${label}`, picks: [{ q: `이 답글을 올리고 메일도 보낼까요? (${code})`, n, label, ...(hash ? { hash } : {}) }] });
	};
	const recover = () => {
		replyFails = undefined;
		zeleFails = false;
	};
	return { engine, make, posted, zele, mailSends: () => zele.filter(a => a[2] === "send"), inbox, pick, recover, clock };
}
type World = ReturnType<typeof world>;

async function card(w: World) {
	await w.engine.collect({ force: true });
	const s = await w.engine.addDraft(commentId("youtube", "c1"), "문서는 메일로 보내 드렸어요", undefined, { app: "mail", to: "fan@example.com", subject: "캐논 문서 보내드립니다", body: "요청하신 캐논 문서 보내드립니다.", attach: [score] });
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
		expect(w.mailSends()).toEqual([]);
		await w.pick(d.code);
		expect(await runComments(["send", d.code], w.engine, w.inbox)).toEqual({ lines: [`답글을 올리고 메일을 보냈어요 (${d.code})`], code: 0, posted: d.code });
		expect(w.posted).toEqual(["문서는 메일로 보내 드렸어요"]);
		expect(w.mailSends()).toEqual([["zele", "mail", "send", "--to", "fan@example.com", "--subject", "캐논 문서 보내드립니다", "--body", "요청하신 캐논 문서 보내드립니다.", "--attach", stagedFiles(mailId)[0]!.path]]);
		expect(w.engine.store.drafts()[0]!.status).toBe("sent");
		expect(getDraft(mailId)!.status).toBe("sent");
		await w.pick(d.code);
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(1);
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toHaveLength(1);
	});

	test("the mail of the card cannot be sent on its own, before or instead of the reply", async () => {
		const w = world();
		const { mailId } = await card(w);
		appendSealed(w.inbox, { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `이 메일 보낼까요? (${mailId})`, n: 1, label: "보내기" }] });
		const alone = await runMailCli(["send", "--draft", mailId], "", { run: async () => ({ code: 0, stdout: "", stderr: "" }), hub: { post: async () => ({ status: 200 }) } });
		expect(alone.code).toBe(1);
		expect(alone.lines[0]).toContain("한 장으로 승인해요");
		expect(w.mailSends()).toEqual([]);
	});

	test("a failed reply sends no mail and keeps the card; after the platform recovers the same pick posts and sends once", async () => {
		const w = world({ replyFails: "quota exceeded" });
		const { d, mailId } = await card(w);
		await w.pick(d.code);
		const out = await runComments(["send", d.code], w.engine, w.inbox);
		expect(out.code).toBe(1);
		expect(out.lines[0]).toBe("답글을 올리지 못했어요 (메일도 보내지 않았어요): quota exceeded");
		expect(w.mailSends()).toEqual([]);
		expect(w.engine.store.drafts()[0]!.status).toBe("pending");
		expect(getDraft(mailId)!.status).toBe("pending");
		w.recover();
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(0);
		expect(w.posted).toHaveLength(2);
		expect(w.mailSends()).toHaveLength(1);
	});

	test("Dt8pq3b: the mail gone after the pick leaves the card, so the old pick (it named the version with the mail) sends nothing; the owner's fresh 다시 보내기 pick posts once", async () => {
		const w = world();
		const { d, mailId } = await card(w);
		await w.pick(d.code);
		// The mail went out on its own after the owner's 보내기 (the incident's raw mail CLI).
		setStatus(mailId, "sent");
		w.clock.now = NOW + 10_000;
		const first = await runComments(["send", d.code], w.engine, w.inbox);
		expect([first.code, first.lines[0], w.engine.store.drafts()[0]!.mail]).toEqual([1, reasonOf("changed").text, undefined]);
		// The old loop: every later send reads that pick, which names the version with the mail, and is refused.
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(1);
		expect(w.posted).toEqual([]);
		// What hub/reply-actions.ts retry writes now: a fresh 1) 보내기 on the card as it is.
		await w.pick(d.code, 1, NOW + 20_000);
		expect((await runComments(["send", d.code], w.engine, w.inbox)).code).toBe(0);
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toEqual([]);
	});

	test("a failed mail is told with its draft id; the reply stays posted and the mail goes out after its own card is approved", async () => {
		const w = world({ zeleFails: true });
		const { d, mailId } = await card(w);
		await w.pick(d.code);
		const out = await runComments(["send", d.code], w.engine, w.inbox);
		expect(out.code).toBe(1);
		expect(out.lines[0]).toContain("답글은 올렸지만 메일은 보내지 못했어요");
		expect(out.lines[0]).toContain(`메일 초안 ${mailId}은 남아 있어요`);
		expect(getDraft(mailId)!.status).toBe("pending");
		w.recover();
		const hub = { post: async () => ({ status: 200 }) };
		const ask = await runMailCli(["ask", "--draft", mailId], "", { hub });
		expect(parseDraftApproval(ask.lines[0]!)).toMatchObject({ ref: mailId, attachments: [{ name: "캐논.pdf" }] });
		appendSealed(w.inbox, { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `이 메일 보낼까요? (${mailId})`, n: 1, label: "보내기", hash: mailHash(getDraft(mailId)!) }] });
		const run: Runner = async argv => (w.zele.push(argv), { code: 0, stdout: "", stderr: "" });
		expect((await runMailCli(["send", "--draft", mailId], "", { run, hub })).code).toBe(0);
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toHaveLength(2);
		expect(getDraft(mailId)!.status).toBe("sent");
	});

	test("the owner's 보내기 tapped twice posts once and sends the mail once", async () => {
		const w = world();
		const { d } = await card(w);
		const [a, b] = [w.engine.send(d.code, { by: "owner" }), w.engine.send(d.code, { by: "owner" })];
		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		await w.engine.idle();
		expect(w.posted).toHaveLength(1);
		expect(w.mailSends()).toHaveLength(1);
		expect(w.engine.store.replies()[0]).toMatchObject({ state: "sent", mail: { state: "sent" } });
	});
});

const MAIL_LESSON = "자료를 보내는 메일에는 받는 분을 먼저 부른다";
const OWNER_MAIL = "팬님, 요청하신 캐논 문서 보내드립니다.";
function teacher() {
	const lessons: string[] = [];
	const call = async (system: string) => (system.startsWith("You learn how") ? (lessons.push(system), JSON.stringify({ lesson: MAIL_LESSON, everywhere: false })) : JSON.stringify({ replaces: [] }));
	const deps = { learnCall: () => call } satisfies FlowDeps;
	return { lessons, deps, edits: { lessonOfEdit, learn: async () => undefined, mail: id => learnSentEdit(id, deps) } satisfies EditLessons };
}
const learned = (mailId: string): string[] => profileBullets(toneKey(getDraft(mailId)!), HEADINGS.corrections).filter(l => l.endsWith(MAIL_LESSON));
async function editedCard(w: World) {
	const c = await card(w);
	expect(w.engine.edit(c.d.code, OWNER_MAIL, "mail")).toMatchObject({ ok: true });
	await w.pick(c.d.code);
	return c;
}

describe("the owner's edit of the mail riding on a comment card is learned once", () => {
	test("gateway, whole card: the CLI child and its mail link learn nothing; the gateway's comment adapter learns the mail once", async () => {
		const w = world();
		const t = teacher();
		const child = w.make({}, t.deps);
		const gateway = w.make({ edits: t.edits });
		const { d, mailId } = await editedCard(w);
		expect((await runComments(["send", d.code], child, w.inbox)).code).toBe(0);
		await Promise.all([child.idle(), learningSettled()]);
		expect([t.lessons.length, learned(mailId)]).toEqual([0, []]);
		commentAdapter(gateway).learnSent?.(d.code);
		await Promise.all([gateway.idle(), learningSettled()]);
		expect([t.lessons.length, learned(mailId).length]).toEqual([1, 1]);
	});

	test("gateway, reply first and the mail alone after: the send whose mail failed learns no mail, 메일만 다시 보내기 learns it once", async () => {
		const w = world({ zeleFails: true });
		const t = teacher();
		const child = w.make({}, t.deps);
		const gateway = w.make({ edits: t.edits });
		const { d, mailId } = await editedCard(w);
		expect((await runComments(["send", d.code], child, w.inbox)).code).toBe(1);
		commentAdapter(gateway).learnSent?.(d.code);
		await Promise.all([gateway.idle(), learningSettled()]);
		expect(t.lessons).toEqual([]);
		w.recover();
		expect(await child.sendMailOnly(d.code, { retry: true })).toMatchObject({ ok: true });
		commentAdapter(gateway).learnSent?.(d.code, "mail");
		await Promise.all([gateway.idle(), learningSettled()]);
		expect([t.lessons.length, learned(mailId).length]).toEqual([1, 1]);
	});

	test("gateway, the mail alone first and the reply after: the mail is learned once, the reply's send does not learn it again", async () => {
		const w = world();
		const t = teacher();
		const child = w.make({}, t.deps);
		const gateway = w.make({ edits: t.edits });
		const { d, mailId } = await editedCard(w);
		expect(await child.sendMailOnly(d.code)).toMatchObject({ ok: true });
		commentAdapter(gateway).learnSent?.(d.code, "mail");
		await Promise.all([gateway.idle(), learningSettled()]);
		const r = child.send(d.code, { by: "owner" });
		if (!r.ok) throw new Error(r.reason);
		expect((await r.done).state).toBe("sent");
		commentAdapter(gateway).learnSent?.(d.code);
		await Promise.all([gateway.idle(), learningSettled()]);
		expect([t.lessons.length, learned(mailId).length]).toEqual([1, 1]);
	});

	test("by hand: comments.ts send without --no-learn learns the mail once before it hands back the exit code", async () => {
		const w = world();
		const t = teacher();
		const { d, mailId } = await editedCard(w);
		const learnAsked: boolean[] = [];
		const exit = await cli(["send", d.code], { engineOf: learn => (learnAsked.push(learn), w.make(learn ? { edits: t.edits } : {}, t.deps)), inbox: w.inbox, print: () => undefined });
		expect([exit, learnAsked, t.lessons.length, learned(mailId).length]).toEqual([0, [true], 1, 1]);
	});

	test("by hand: comments.ts send --only mail learns the mail's edit once before it hands back the exit code", async () => {
		const w = world();
		const t = teacher();
		const { d, mailId } = await editedCard(w);
		const learnAsked: boolean[] = [];
		const exit = await cli(["send", d.code, "--only", "mail"], { engineOf: learn => (learnAsked.push(learn), w.make(learn ? { edits: t.edits } : {}, t.deps)), inbox: w.inbox, print: () => undefined });
		expect([exit, learnAsked, w.mailSends().length, w.posted, t.lessons.length, learned(mailId).length]).toEqual([0, [true], 1, [], 1, 1]);
	});
});
