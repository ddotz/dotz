// The comment adapter of the one reply flow (design 1.8 column 3) over a real engine with an injected platform, model and mail link.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommentAdapter, RawComment, ReplyOutcome, SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailView } from "./engine.ts";
import type { EditLessons } from "./draft-run.ts";
import { localMidnight } from "../reply-route.ts";
import { commentAdapter } from "./reply-adapter.ts";
import { realMailLink } from "./mail-link.ts";
import { approvalHash, createApprovalSender, type SendJob, type SendLook } from "../approval-send.ts";
import { createReplyActions } from "../reply-actions.ts";
import { addDraft, getDraft, setStatus, type DraftRec } from "../../features/reply-drafts/lib/store.ts";
import { readLedger } from "../../features/reply-drafts/lib/ledger.ts";
import { HEADINGS, loadStyle, paths, profileBullets, recordLearned } from "../../features/reply-drafts/lib/settings.ts";
import { generateReply } from "../reply-draft.ts";
import { lessonOfEdit, replyLearning } from "../reply-mail.ts";
import { cli } from "../../features/comments/bin/comments.ts";
import { realEngine } from "./real.ts";
import { commentsDir } from "./store.ts";
import { appendSealed } from "../approval-seal.ts";
import { flush } from "../runtime/test-clock.ts";
import type { LearnInput, LessonOfEdit } from "../reply-types.ts";

const NOW = Date.parse("2026-11-13T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const raw: RawComment = { native: "c1", thread: "p1", author: "팬", text: "다음 편 언제 올라와요?", postTitle: "Post one", at: NOW - 1000 };
const reply = (body: string, extra: object = {}) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [], ...extra })}\n\`\`\``;
const ROOM_KEYS = { channel: { app: "youtube" } };
let dir: string;
const savedDir = process.env.DOTZ_DIR;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comment-adapter-"));
	process.env.DOTZ_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedDir === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = savedDir;
});

const WISH_RULE = `shape ${JSON.stringify({ parts: [{ any: ["좋은"] }, { gap: 5 }, { any: ["되세요"] }], label: "'좋은 주말 보내세요'로 쓴다" })}`;
function setup(o: { model?: string[]; taught?: LearnInput[]; prompts?: string[]; tone?: true; files?: MailView["attachments"]; now?: number; mail?: MailLink; posts?: ReplyOutcome[]; answered?: { thread: string; at: number }[]; lessonOfEdit?: LessonOfEdit; learnEdit?: EditLessons["learn"] } = {}) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const posts = [...(o.posts ?? [])];
	const platform: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [raw], cursor: "1" }), reply: async () => posts.shift() ?? { ok: true, ref: "r1" }, posts: async () => [] };
	const mails = new Map<string, MailView>([["RMAIL01", { id: "RMAIL01", to: "fan@example.com", subject: "자료", body: "보내드려요", attachments: o.files ?? [] }]]);
	const mail: MailLink = o.mail ?? { compose: async () => ({ ok: false, reason: "x" }), send: async () => ({ ok: true, text: "" }), drop: () => undefined, revise: async () => ({ ok: false, reason: "x" }), view: id => mails.get(id), edit: (id, text, subject) => (mails.set(id, { ...mails.get(id)!, body: text, ...(subject !== undefined ? { subject } : {}) }), { ok: true }) };
	let n = 0;
	const outs = o.model ?? [reply("이번 주말이에요!")];
	const learnEdit = o.learnEdit ?? (async (input: LearnInput) => void o.taught?.push(input));
	const engine = createEngine({ dir, now: () => o.now ?? NOW, collector: "mac", adapters: { youtube: platform }, model: async (system, user) => (o.prompts?.push(`${system}\n${user}`), { text: outs[Math.min(n++, outs.length - 1)]! }), mail, style: o.tone ? src => loadStyle({ app: src.key }) : () => ({ rules: [], corrections: [], forbidden: ["무조건", WISH_RULE], samples: [] }), answeredMailThread: (thread, at) => void o.answered?.push({ thread, at }), ...(o.lessonOfEdit ? { edits: { lessonOfEdit: o.lessonOfEdit, learn: learnEdit, mail: async () => undefined } } : {}) });
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
	const { engine, a } = setup({ model: [reply("이번 주말이에요!"), reply("토요일 저녁에 올라가요!", { once: false })] });
	const code = await drafted(engine);
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01" });
	const r = await a.revise(code, "요일로 말해 줘");
	expect(r).toMatchObject({ ok: true, replaces: code, lesson: { keys: ROOM_KEYS, words: "요일로 말해 줘", proposal: { once: false, scope: "channel" }, evidence: { draft: "이번 주말이에요!", change: "요일로 말해 줘" } } });
	expect(existsSync(paths.toneDir())).toBe(false);
	const next = r.ok ? await a.get(r.ref) : undefined;
	expect(next?.draft).toMatchObject({ text: "토요일 저녁에 올라가요!", replaces: { ref: code, text: "이번 주말이에요!" }, mail: { ref: "RMAIL01" } });
	const card = r.ok ? (await a.ask(r.ref))! : "";
	expect(card.split("RMAIL01").length - 1).toBe(1);
	expect((await a.get(code))!.draft.state).toBe("stale");
});

test("the engine's own revise returns its lesson and learns nothing; the skill CLI learns it through the entry after the new draft is stored and prints what it stored", async () => {
	const { engine } = setup({ model: [reply("이번 주말이에요!"), reply("토요일 저녁에 올라가요!", { once: false }), reply("토요일 밤에 올라가요!", { once: false })] });
	const code = await drafted(engine);
	const own = await engine.revise(code, "요일로");
	expect(own).toMatchObject({ ok: true, lesson: { words: "요일로", proposal: { once: false } } });
	expect(existsSync(paths.toneDir())).toBe(false);
	const lines: string[] = [];
	const next = own.ok ? own.draft.code : code;
	expect(await cli(["revise", next, "--change", "밤으로"], { engineOf: () => engine, inbox: join(dir, "inbox.jsonl"), print: text => void lines.push(text) })).toBe(0);
	expect(lines.join("\n")).toContain('기억했어요: "밤으로" · 범위: 이 앱');
	expect(profileBullets({ app: "youtube" }, HEADINGS.corrections).join("\n")).toContain("밤으로");
});

test("edit keeps the code, stores the owner's text, makes the draft unclean and refuses a forbidden word or a broken wording rule", async () => {
	const { engine, a } = setup();
	const code = await drafted(engine);
	expect(await a.edit(code, "무조건 토요일!")).toMatchObject({ ok: false, reason: { code: "forbidden_word" } });
	expect(await a.edit(code, "좋은 주말 되세요!")).toMatchObject({ ok: false, reason: { code: "wording_rule" } });
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const d = engine.store.drafts().find(x => x.code === code)!;
	expect([d.text, d.clean, d.editedFrom]).toEqual(["토요일에 올릴게요 :)", false, "이번 주말이에요!"]);
	expect(await a.markSent(code)).toEqual({ ok: true });
	expect(await a.prove!(code)).toBe("sent");
});

const owedSetup = async (mailRecord: { mail?: { state: "failed"; text: string } }) => {
	const state = { owed: true };
	const view: MailView = { id: "RMAIL01", to: "fan@example.com", subject: "자료", body: "보내드려요", attachments: [] };
	const mail: MailLink = { compose: async () => ({ ok: false, reason: "x" }), send: async () => ({ ok: true, text: "" }), drop: () => undefined, revise: async () => ({ ok: false, reason: "x" }), view: () => (state.owed ? view : undefined), edit: () => ({ ok: true }) };
	const { engine, a } = setup({ mail });
	const code = await drafted(engine);
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01" });
	engine.store.putReply({ id: `send:${engine.store.comments()[0]!.id}`, commentId: engine.store.comments()[0]!.id, source: "youtube", thread: "p1", text: "이번 주말이에요!", state: "unsure", at: NOW - 100, draft: code, via: "owner", collector: "mac", reason: "답글은 올렸고 메일은 못 보냈어요", code: "unknown", ...mailRecord });
	expect(await a.markSent(code)).toEqual({ ok: true });
	expect(engine.store.drafts().find(d => d.code === code)!.status).toBe("sent");
	return { a, code, state };
};

test("a posted reply whose mail was tried and failed is not proved sent by a read-back: the card stays unsure until the mail is dealt with", async () => {
	const { a, code, state } = await owedSetup({ mail: { state: "failed", text: "메일을 못 보냈어요" } });
	expect(await a.prove!(code)).toBe("unknown");
	state.owed = false;
	expect(await a.prove!(code)).toBe("sent");
});

test("a reply sent alone (답글만 보내기) is proved sent once posted, though its mail still waits as a draft", async () => {
	const { a, code } = await owedSetup({});
	expect(await a.prove!(code)).toBe("sent");
});

test("a reply with a linked pending mail carries the mail's files and offers both, reply only and mail only; one without a mail offers one 보내기", async () => {
	const { engine, a } = setup({ files: [{ name: "자료.pdf", size: 2048 }, { name: "사진.jpg" }] });
	const code = await drafted(engine);
	expect((await a.get(code))!.can.sends).toBeUndefined();
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01" });
	const v = (await a.get(code))!;
	expect(v.draft.mail).toEqual({ ref: "RMAIL01", to: "fan@example.com", subject: "자료", text: "보내드려요", attachments: [{ name: "자료.pdf", size: "2KB" }, { name: "사진.jpg" }] });
	expect(v.can.sends).toEqual(["send", "send-main", "send-mail"]);
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
	// The bundled mail's subject rides along with its text.
	expect(await a.edit(code, "메일은 제가 쓴 대로요", "mail", "자료 보내드려요")).toEqual({ ok: true });
	expect((await a.get(code))!.draft.mail).toMatchObject({ subject: "자료 보내드려요", text: "메일은 제가 쓴 대로요" });
});

async function posted(at: number) {
	const { engine, a } = setup({ now: at });
	const code = await drafted(engine);
	const r = engine.send(code, { by: "owner" });
	if (!r.ok) throw new Error(r.reason);
	await r.done;
	return { engine, a, code };
}

test("U4-7 a reply posted today is listed as sent with its time; a rule's post says rule", async () => {
	const at = Date.now();
	const { engine, a, code } = await posted(at);
	expect(await a.get(code)).toMatchObject({ draft: { state: "sent" }, can: { send: false }, sent: { at, how: "owner" } });
	expect((await a.list()).map(v => v.ref)).toEqual([code]);
	const rep = engine.store.replies().find(r => r.draft === code)!;
	engine.store.putReply({ ...rep, via: "rule" });
	expect((await a.get(code))!.sent).toEqual({ at, how: "rule" });
});

test("U4-7 a reply posted before the gateway's midnight is not listed, though get still names it sent", async () => {
	const at = localMidnight() - 3_600_000;
	const { a, code } = await posted(at);
	expect((await a.get(code))!.sent).toEqual({ at, how: "owner" });
	expect(await a.list()).toEqual([]);
});

const rec = (id: string, o: Partial<DraftRec> = {}): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", account: "me@example.net", mailId: id, ref: `k-${id}`, to: "fan@example.com", subject: "Re: 자료", body: "보내드려요", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "fan@example.com", text: "hi", subject: "x" }, ...o }) as unknown as DraftRec;
const realMail = (): MailLink => ({ ...realMailLink(), send: async id => (setStatus(id, "sent"), { ok: true, text: "" }) });
async function withMail(only?: "reply") {
	const { engine, a } = setup({ now: Date.now(), mail: realMail() });
	const code = await drafted(engine);
	addDraft(rec("RMAIL01"));
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01", mailAt: Date.now() });
	const r = engine.send(code, { by: "owner", ...(only ? { only } : {}) });
	if (!r.ok) throw new Error(r.reason);
	await r.done;
	return { engine, a, code };
}

test("U4-5 a reply that went out with its mail is one row that carries the mail, read from the mail draft's own record once it is sent", async () => {
	const { a, code } = await withMail();
	expect(getDraft("RMAIL01")!.status).toBe("sent");
	expect(realMail().view("RMAIL01")).toBeUndefined();
	const rows = await a.list();
	expect(rows.map(v => [v.ref, v.draft.state, v.draft.mail?.ref, v.draft.mail?.text])).toEqual([[code, "sent", "RMAIL01", "보내드려요"]]);
	expect((await a.get(code))!.draft.mail).toMatchObject({ ref: "RMAIL01", to: "fan@example.com", subject: "Re: 자료" });
});

test("U4-5 a reply sent alone (답글만 보내기) does not carry a mail that is sent later by itself", async () => {
	const { a, code } = await withMail("reply");
	expect(getDraft("RMAIL01")!.status).toBe("pending");
	setStatus("RMAIL01", "sent");
	expect((await a.get(code))!.draft.mail).toBeUndefined();
});

test("a reply that carries a mail shows the account that mail goes out from, and the account is in the hash", async () => {
	const { engine, a } = setup({ now: Date.now(), mail: realMail() });
	const code = await drafted(engine);
	const put = (id: string, o: Partial<DraftRec>) => {
		addDraft(rec(id, o));
		engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: id, mailAt: Date.now() });
	};
	put("RMAIL01", { account: "me@example.net" });
	const mine = (await a.get(code))!;
	expect(mine.draft.mail?.account).toBe("me@example.net");
	put("RMAIL02", { account: "other@example.net" });
	const other = (await a.get(code))!;
	expect(other.draft.mail?.account).toBe("other@example.net");
	expect(approvalHash(other)).not.toBe(approvalHash(mine));
	put("RMAIL03", { account: undefined, accounts: ["a@example.net", "b@example.net"] });
	const held = (await a.get(code))!;
	expect(held.draft.mail).toMatchObject({ ref: "RMAIL03", accountHeld: true });
	expect(held.draft.mail?.account).toBeUndefined();
});

test("a listing reads the send records once, however many drafts it shows", async () => {
	const { engine, a } = setup({ now: Date.now() });
	const first = await drafted(engine);
	const r = engine.send(first, { by: "owner" });
	if (!r.ok) throw new Error(r.reason);
	await r.done;
	for (const code of ["DSENT002", "DSENT003"]) engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === first)!, code, status: "sent" });
	const read = engine.store.replies;
	let reads = 0;
	engine.store.replies = () => (reads++, read());
	expect((await a.list()).map(v => v.ref).sort()).toEqual([first]);
	expect(reads).toBe(1);
});

async function sendWithThread(o: { posts?: ReplyOutcome[]; thread?: { id: string; answered?: boolean } }) {
	const answered: { thread: string; at: number }[] = [];
	const { engine } = setup({ ...(o.posts ? { posts: o.posts } : {}), answered });
	const code = await drafted(engine);
	if (o.thread) engine.store.patchDraft(code, { mailThread: o.thread });
	const r = engine.send(code, { by: "owner" });
	if (!r.ok) throw new Error(r.reason);
	const rep = await r.done;
	return { engine, answered, rep };
}

test("CM-13 a posted reply to a comment whose writer's mail was found names that mail thread and the time", async () => {
	const { answered, rep } = await sendWithThread({ thread: { id: "18c2f0a9d1", answered: false } });
	expect([rep.state, answered]).toEqual(["sent", [{ thread: "18c2f0a9d1", at: NOW }]]);
});

for (const [what, failed] of [["failed", { ok: false, reason: "거절됐어요", code: "rejected", sent: "no" }], ["unknown", { ok: false, reason: "모름", code: "server_error", sent: "maybe" }]] as const) {
	test(`CM-13 a reply whose post ${what === "failed" ? "failed" : "has an unknown outcome"} names no mail thread until a later send of it is posted`, async () => {
		const { engine, answered, rep } = await sendWithThread({ thread: { id: "18c2f0a9d1", answered: false }, posts: [failed, { ok: true, ref: "r2" }] });
		expect([rep.state, answered]).toEqual([what === "failed" ? "failed" : "unsure", []]);
		const again = engine.retrySend(rep.id);
		if (!again.ok) throw new Error(again.reason);
		expect((await again.done).state).toBe("sent");
		expect(answered).toEqual([{ thread: "18c2f0a9d1", at: NOW }]);
	});
}

test("CM-13 a comment draft whose writer's mail was already answered says so on its card, outside the approved version; one not answered says nothing", async () => {
	const { engine, a } = setup();
	const code = await drafted(engine);
	const before = (await a.get(code))!;
	expect(before.answeredElsewhere).toBeUndefined();
	engine.store.patchDraft(code, { mailThread: { id: "t1", answered: false } });
	expect((await a.get(code))!.answeredElsewhere).toBeUndefined();
	engine.store.patchDraft(code, { mailThread: { id: "t1", answered: true } });
	const after = (await a.get(code))!;
	expect(after.answeredElsewhere).toEqual({ via: "mail" });
	expect(approvalHash(after)).toBe(approvalHash(before));
});

test("CM-13 a pending comment draft says 메일로 이미 답했어요 once its writer's mail is answered after the draft was made; a posted one does not take it up", async () => {
	const { engine } = setup();
	const answeredMails = new Set<string>();
	const a = commentAdapter(engine, () => thread => answeredMails.has(thread));
	const code = await drafted(engine);
	engine.store.patchDraft(code, { mailThread: { id: "t1", answered: false } });
	expect((await a.get(code))!.answeredElsewhere).toBeUndefined();
	answeredMails.add("t1");
	expect((await a.get(code))!.answeredElsewhere).toEqual({ via: "mail" });
	expect((await a.list()).find(v => v.ref === code)?.answeredElsewhere).toEqual({ via: "mail" });
	engine.store.setDraftStatus(code, "sent");
	expect((await a.get(code))!.answeredElsewhere).toBeUndefined();
});

const BAN = "행복한 하루 되세요";
const CHANGE = `마무리에 "${BAN}"는 쓰지 말고 짧게 끝내 줘`;
const LESSON = "마무리 인사는 짧게 한다";

async function store(ref: string, l: Omit<LearnInput, "source" | "ref"> | undefined) {
	if (!l) throw new Error("no lesson");
	return replyLearning(() => ({})).learn({ source: "revise", ref, ...l });
}

test("K1 a comment revise that quotes a wording leaves the ban and the lesson in the source's own profile, and the next draft's prompt carries both", async () => {
	const prompts: string[] = [];
	const { engine, a } = setup({ tone: true, prompts, model: [reply("이번 주말이에요!"), reply("토요일에 올라가요", { forbid: [BAN], once: false, scope: "channel" }), reply("토요일 저녁이에요")] });
	const code = await drafted(engine);
	const r = await a.revise(code, CHANGE);
	expect(r).toMatchObject({ ok: true, lesson: { keys: ROOM_KEYS, words: CHANGE, proposal: { forbid: [BAN], once: false, scope: "channel" } } });
	if (!r.ok) throw new Error("revise failed");
	const said = await store(r.ref, r.lesson);
	expect(said.text).toContain(`기억했어요: "${CHANGE}" · 범위: 이 앱`);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.corrections).join("\n")).toContain(CHANGE);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	prompts.length = 0;
	expect((await a.revise(r.ref, "더 짧게")).ok).toBe(true);
	expect(prompts[0]).toContain(BAN);
	expect(prompts[0]).toContain(CHANGE);
});

test("K1 a comment revise the model says holds everywhere is a standing rule of install.md and a draft of another app carries it", async () => {
	const { engine, a } = setup({ tone: true, model: [reply("이번 주말이에요!"), reply("토요일에 올라가요", { forbid: [BAN], once: false, scope: "everywhere" })] });
	const code = await drafted(engine);
	const r = await a.revise(code, CHANGE);
	expect(r).toMatchObject({ ok: true, lesson: { keys: ROOM_KEYS, words: CHANGE, proposal: { forbid: [BAN], once: false, scope: "everywhere" } } });
	if (!r.ok) throw new Error("revise failed");
	expect((await store(r.ref, r.lesson)).text).toContain(`기억했어요: "${CHANGE}" · 범위: 모든 답장`);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual([CHANGE]);
	expect(profileBullets("install", HEADINGS.corrections)).toEqual([]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([]);
	let seen = "";
	await generateReply({ kind: "comment", app: "instagram", from: "팬", text: "언제 올라와요?", context: "" }, loadStyle({ app: "instagram" }), async (system, user) => ((seen = `${system}\n${user}`), reply("토요일이에요")));
	expect(seen).toContain(BAN);
	expect(seen).toContain(CHANGE);
});

test("K3 a one-off comment change returns its lesson with once and is told as 이번만 반영했어요, writing no tone file; K4 a wording the change text does not hold is not a ban", async () => {
	const { engine, a } = setup({ tone: true, model: [reply("이번 주말이에요!"), reply("토요일이에요", { once: true, forbid: [], scope: "everywhere" }), reply("토요일 밤이에요", { once: true, forbid: ["받은 댓글에 있던 말"] })] });
	const code = await drafted(engine);
	const one = await a.revise(code, "토요일로만");
	expect(one).toMatchObject({ ok: true, lesson: { words: "토요일로만", proposal: { once: true } } });
	if (!one.ok) throw new Error("revise failed");
	expect((await store(one.ref, one.lesson)).text).toBe("이번만 반영했어요");
	const next = await a.revise(one.ref, "밤으로만");
	expect(next).toMatchObject({ ok: true, lesson: { words: "밤으로만", proposal: { once: true, forbid: [] } } });
	expect(loadStyle({ app: "youtube" })).toMatchObject({ rules: [], corrections: [], forbidden: [] });
	expect(existsSync(paths.toneDir())).toBe(false);
});

const EDIT_LESSON = "팬 댓글에는 날짜 대신 요일로 답한다";
const lessonAnswer = (lesson: string, everywhere = false) => JSON.stringify({ lesson, everywhere });
const editInput = (ref: string, words: string, scope?: "everywhere"): LearnInput => ({ source: "edit", ref, keys: ROOM_KEYS, words, ...(scope ? { proposal: { scope } } : {}) });

test("an edited comment reply teaches the model's lesson once it went up, not before and not when the post failed", async () => {
	const taught: LearnInput[] = [];
	const failed = setup({ taught, lessonOfEdit, model: [reply("이번 주말이에요!"), lessonAnswer(EDIT_LESSON)], posts: [{ ok: false, reason: "x", code: "rejected", sent: "no" }] });
	const lost = await drafted(failed.engine);
	expect(await failed.a.edit(lost, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const bad = failed.engine.send(lost, { by: "owner" });
	if (!bad.ok) throw new Error(bad.reason);
	await bad.done;
	await failed.engine.idle();
	expect(taught).toEqual([]);

	const prompts: string[] = [];
	const { engine, a } = setup({ taught, prompts, lessonOfEdit, model: [reply("이번 주말이에요!"), lessonAnswer(EDIT_LESSON)] });
	const code = await drafted(engine);
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	expect(taught).toEqual([]);
	const r = engine.send(code, { by: "owner" });
	if (!r.ok) throw new Error(r.reason);
	await r.done;
	await engine.idle();
	expect(taught).toEqual([editInput(code, EDIT_LESSON)]);
	expect(prompts).toHaveLength(2);
	for (const said of ["다음 편 언제 올라와요?", "이번 주말이에요!", "토요일에 올릴게요 :)"]) expect(prompts[1]).toContain(said);
});

test("an edited comment lesson about the language itself is marked everywhere; \"\", a failed call or a whitespace-only edit ends once with no words, no lesson reader reaches nothing, and the post goes up the same", async () => {
	const run = async (o: { model?: string[]; lessonOfEdit?: LessonOfEdit; text?: string }) => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir);
		const taught: LearnInput[] = [], prompts: string[] = [];
		const { engine, a } = setup({ taught, prompts, model: [reply("이번 주말이에요!"), ...(o.model ?? [])], ...(o.lessonOfEdit ? { lessonOfEdit: o.lessonOfEdit } : {}) });
		const code = await drafted(engine);
		expect(await a.edit(code, o.text ?? "토요일에 올릴게요 :)")).toEqual({ ok: true });
		const r = engine.send(code, { by: "owner" });
		if (!r.ok) throw new Error(r.reason);
		const rep = await r.done;
		await engine.idle();
		return { taught: taught.map(t => [t.source, t.ref === code, t.words, t.proposal?.scope]), calls: prompts.length - 1, state: rep.state };
	};
	expect(await run({ lessonOfEdit, model: [lessonAnswer("맞춤법은 '돼요'로 쓴다", true)] })).toEqual({ taught: [["edit", true, "맞춤법은 '돼요'로 쓴다", "everywhere"]], calls: 1, state: "sent" });
	expect(await run({ lessonOfEdit, model: [lessonAnswer("")] })).toEqual({ taught: [["edit", true, "", undefined]], calls: 1, state: "sent" });
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	expect(await run({ lessonOfEdit: input => lessonOfEdit(input, async () => { throw new Error("model down"); }) })).toEqual({ taught: [["edit", true, "", undefined]], calls: 0, state: "sent" });
	log.mockRestore();
	expect(await run({ lessonOfEdit, model: [lessonAnswer(EDIT_LESSON)], text: "이번  주말이에요! " })).toEqual({ taught: [["edit", true, "", undefined]], calls: 0, state: "sent" });
	expect(await run({ model: [lessonAnswer(EDIT_LESSON)] })).toEqual({ taught: [], calls: 0, state: "sent" });
});

test("an edited comment lesson that says a standing rule of install.md again is not added again: it goes through the one learning door and its curation", async () => {
	const STANDING = "맞춤법은 '되요'가 아니라 '돼요'로 쓴다";
	await replyLearning(() => ({})).learn({ source: "chat", ref: "S1", keys: ROOM_KEYS, words: STANDING, proposal: { scope: "everywhere" } });
	expect(profileBullets("install", HEADINGS.rules)).toEqual([STANDING]);
	const curated: string[] = [];
	const learning = replyLearning(() => ({ learnCall: () => async (_system, user) => (curated.push(user), JSON.stringify({ replaces: [{ id: "R1", why: "same" }] })) }));
	const { engine, a } = setup({ lessonOfEdit, learnEdit: async input => void (await learning.learn(input)), model: [reply("이번 주말이에요!"), lessonAnswer("'돼요'를 맞춤법대로 쓴다", true)] });
	const code = await drafted(engine);
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const r = engine.send(code, { by: "owner" });
	if (!r.ok) throw new Error(r.reason);
	expect((await r.done).state).toBe("sent");
	await engine.idle();
	expect(curated).toHaveLength(1);
	expect(curated[0]).toContain("'돼요'를 맞춤법대로 쓴다");
	expect(profileBullets("install", HEADINGS.rules)).toEqual([STANDING]);
});

const approve = (inbox: string, code: string, hash: string) => appendSealed(inbox, { ts: new Date(NOW + 5000).toISOString(), kind: "message", source: "web", text: "1) 보내기", picks: [{ q: `이 답글 올릴까요? (${code})`, n: 1, label: "보내기", hash }] });

test("a comment send by hand through the CLI prints its result first and stores the edit's lesson before it hands back the exit code", async () => {
	const taught: LearnInput[] = [], order: string[] = [];
	const printed = Promise.withResolvers<void>();
	const afterPrint: LessonOfEdit = (input, ask) =>
		lessonOfEdit(input, async (system, user) => {
			await Promise.race([printed.promise, flush(30)]);
			const text = await ask(system, user);
			order.push("lesson answered");
			return text;
		});
	const { engine, a } = setup({ taught, lessonOfEdit: afterPrint, model: [reply("이번 주말이에요!"), lessonAnswer(EDIT_LESSON)] });
	const code = await drafted(engine);
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const inbox = join(dir, "inbox.jsonl");
	approve(inbox, code, approvalHash((await a.get(code))!));
	const learnAsked: boolean[] = [];
	const exit = await cli(["send", code], { engineOf: learn => (learnAsked.push(learn), engine), inbox, print: text => (order.push(text), printed.resolve()) });
	expect([exit, learnAsked]).toEqual([0, [true]]);
	expect(order).toEqual([`답글을 올렸어요 (${code})`, "lesson answered"]);
	expect(taught).toEqual([editInput(code, EDIT_LESSON)]);
});

test("a comment send the gateway's queue runs: the CLI gets --no-learn and learns nothing; the gateway learns the edit once the outcome is stored", async () => {
	const taught: LearnInput[] = [], childTaught: LearnInput[] = [];
	const gateway = setup({ taught, lessonOfEdit, model: [reply("이번 주말이에요!"), lessonAnswer(EDIT_LESSON)] });
	const code = await drafted(gateway.engine);
	expect(await gateway.a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const inbox = join(dir, "inbox.jsonl");
	approve(inbox, code, approvalHash((await gateway.a.get(code))!));
	const argvs: string[][] = [], learnAsked: boolean[] = [], reports: string[] = [], stateAtLearn: (string | undefined)[] = [];
	const s = createApprovalSender({
		kind: () => ({ kind: "comment", lane: "comment:youtube" }),
		run: async argv => {
			argvs.push(argv);
			const child = (learn: boolean) => (learnAsked.push(learn), setup({ taught: childTaught, model: [lessonAnswer(EDIT_LESSON)], ...(learn ? { lessonOfEdit } : {}) }).engine);
			return { code: await cli(argv.slice(2), { engineOf: child, inbox, print: () => undefined }), out: "" };
		},
		learn: job => {
			stateAtLearn.push(reports.at(-1));
			gateway.a.learnSent?.(job.ref);
		},
		report: r => void reports.push(r.state),
		log: () => undefined,
	});
	expect(s.enqueue({ ref: code, conv: "comment:youtube", action: "send", title: `이 답글 올릴까요? (${code})`, by: "owner" })).toBe(true);
	await s.idle();
	await gateway.engine.idle();
	expect(argvs.map(argv => argv.slice(2))).toEqual([["send", code, "--no-learn"]]);
	expect([learnAsked, childTaught, stateAtLearn]).toEqual([[false], [], ["sent"]]);
	expect(taught).toEqual([editInput(code, EDIT_LESSON)]);
});

test("a comment send whose CLI child finishes after the gateway restarted (its reply left unsure at boot, then found sent) is learned once, however many triggers find it sent, and never again by a later engine over the same store", async () => {
	const taught: LearnInput[] = [], prompts: string[] = [];
	const gateway = setup({ taught, prompts, lessonOfEdit, model: [reply("이번 주말이에요!"), lessonAnswer(EDIT_LESSON)] });
	const code = await drafted(gateway.engine);
	expect(await gateway.a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const posting = Promise.withResolvers<ReplyOutcome>();
	const childPlatform: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [], cursor: "1" }), reply: () => posting.promise, posts: async () => [] };
	const child = createEngine({ dir, now: () => NOW, collector: "mac", adapters: { youtube: childPlatform } });
	const sending = child.send(code, { by: "owner" });
	if (!sending.ok) throw new Error(sending.reason);

	const job: SendJob = { ref: code, conv: "comment:youtube", action: "send", title: `이 답글 올릴까요? (${code})` };
	const file = { body: JSON.stringify([{ ...job, state: "sending" }]) };
	const outcome = (ref: string): SendLook => {
		const r = gateway.engine.store.replies().find(x => x.draft === ref);
		return r?.state === "sent" ? { state: "sent" } : { state: "unsure", text: r?.reason ?? "?" };
	};
	const s = createApprovalSender({ kind: () => undefined, run: async () => ({ code: 0, out: "" }), store: { load: () => JSON.parse(file.body) as unknown[], save: body => void (file.body = body) }, look: j => outcome(j.ref), learn: j => gateway.a.learnSent?.(j.ref), report: () => undefined, log: () => undefined });
	expect(gateway.engine.leaveUnsure()).toBe(1);
	s.recover();
	expect(JSON.parse(file.body)).toMatchObject([{ ref: code, state: "unsure" }]);
	await gateway.engine.idle();
	expect(taught).toEqual([]);

	posting.resolve({ ok: true, ref: "r1" });
	expect((await sending.done).state).toBe("sent");
	expect(outcome(code)).toEqual({ state: "sent" });
	s.settle(job, "sent");
	await gateway.engine.idle();
	expect(taught).toEqual([editInput(code, EDIT_LESSON)]);
	s.settle(job, "sent");
	gateway.a.learnSent?.(code);
	await gateway.engine.idle();
	const later = setup({ taught, prompts, lessonOfEdit, model: [lessonAnswer(EDIT_LESSON)] });
	later.a.learnSent?.(code);
	await later.engine.idle();
	expect([taught, prompts.length]).toEqual([[editInput(code, EDIT_LESSON)], 2]);
});

test("the real engine's comment edit lesson goes through the one learning door: curated against the profile, stored as a correction, and the stored correction starts the refinement", async () => {
	const root = commentsDir(dir);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const platform: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [raw], cursor: "1" }), reply: async () => ({ ok: true, ref: "r1" }), posts: async () => [] };
	const sender = createEngine({ dir: root, now: () => NOW, collector: "mac", adapters: { youtube: platform }, model: async () => ({ text: reply("이번 주말이에요!") }), style: () => ({ rules: [], corrections: [], forbidden: [], samples: [] }) });
	const code = await drafted(sender);
	expect(await commentAdapter(sender).edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const sent = sender.send(code, { by: "owner" });
	if (!sent.ok) throw new Error(sent.reason);
	expect((await sent.done).state).toBe("sent");
	const earlier = Array.from({ length: 12 }, (_, i) => `예전에 고친 점 ${i + 1}`);
	for (const line of earlier) recordLearned({ app: "youtube" }, line, new Date(NOW));

	const asked: string[] = [];
	const engine = realEngine(dir, { model: async () => ({ text: lessonAnswer(EDIT_LESSON) }), flow: () => ({ learnCall: () => async (_system, user) => (asked.push(user), JSON.stringify({ replaces: [] })) }) });
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	await engine.learnSent(code);
	log.mockRestore();
	expect(asked).toHaveLength(2);
	expect(asked[0]).toContain(EDIT_LESSON);
	for (const line of earlier) expect(asked[1]).toContain(line);
	expect(profileBullets({ app: "youtube" }, HEADINGS.corrections).filter(l => l.endsWith(EDIT_LESSON))).toHaveLength(1);
});

test("a comment reply posted as the model wrote it teaches nothing", async () => {
	const taught: LearnInput[] = [];
	const { engine } = setup({ taught });
	const code = await drafted(engine);
	const p = engine.send(code, { by: "owner" });
	if (!p.ok) throw new Error(p.reason);
	await p.done;
	expect(taught).toEqual([]);
});

const mailRevision = (extra: object = {}) => reply("자료 보내드려요. 확인 부탁드려요.", { to: "fan@example.com", subject: "Re: 자료", ...extra });

async function reviseMailPart(o: { everywhere: boolean; instance?: string; part: "mail" | "reply" }) {
	const lesson = { forbid: [BAN], once: false, scope: o.everywhere ? "everywhere" : "channel" };
	const model = [reply("이번 주말이에요!"), mailRevision(lesson), reply("토요일에 올라가요", lesson)];
	const { engine, a } = setup({ now: Date.now(), model, mail: realMailLink({ call: async () => model[1]! }) });
	const code = await drafted(engine);
	addDraft(rec("RMAIL01", { app: o.instance ?? "mail", item: { kind: "mail", app: o.instance ?? "mail", from: "fan@example.com", text: "hi", subject: "x" } as DraftRec["item"] }));
	engine.store.putDraft({ ...engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01", mailAt: Date.now() });
	const cards: string[] = [];
	const sender = createApprovalSender({ kind: () => undefined, fingerprint: async () => undefined, run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined, now: () => 1, undoMs: () => 0, after: () => undefined });
	const actions = createReplyActions({
		adapters: [a],
		sender,
		recordPick: () => undefined,
		learning: replyLearning(() => ({})),
		cards: { open: () => [], replace: (_o, _n, text) => void cards.push(text), rewrite: (_r, text) => void cards.push(text), repost: async () => undefined, close: () => undefined },
		toBot: async () => undefined,
		emit: () => undefined,
		log: () => undefined,
	});
	const res = await actions.act({ ref: code, action: "revise", change: CHANGE, part: o.part }, { surface: "web", login: "me" });
	expect(res.status).toBe(202);
	await actions.idle();
	return { cards };
}

for (const part of ["mail", "reply"] as const) {
	test(`a ${part} revise of a comment card says on the card what it stored, as its first line`, async () => {
		const { cards } = await reviseMailPart({ everywhere: false, part });
		expect(cards).toHaveLength(1);
		expect(cards[0]!.split("\n")[0]).toStartWith("[ask] 고친 초안이에요. 기억했어요: ");
		expect(cards[0]!.split("\n")[0]).toContain(BAN);
	});
}

test("a mail revise of a comment card teaches the profile of the mail instance the linked mail's drafts read (which reads mail under its own), or install when said everywhere", async () => {
	await reviseMailPart({ everywhere: false, instance: "mail-teaching", part: "mail" });
	expect(readLedger().filter(r => r.kind === "ban").map(r => [r.text, r.scope, r.state])).toEqual([[BAN, { app: "mail-teaching" }, "on"]]);
	expect(profileBullets({ app: "mail-teaching" }, HEADINGS.forbidden)).toEqual([BAN]);
	expect(loadStyle({ app: "mail-teaching" }).forbidden).toEqual([BAN]);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([]);
});

test("a mail revise of a comment card the model says holds everywhere is a standing rule of install.md", async () => {
	await reviseMailPart({ everywhere: true, instance: "mail-teaching", part: "mail" });
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets({ app: "mail-teaching" }, HEADINGS.forbidden)).toEqual([]);
});
