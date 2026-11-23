// The comment adapter of the one reply flow (design 1.8 column 3) over a real engine with an injected platform, model and mail link.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommentAdapter, RawComment, ReplyOutcome, SourceConfig } from "./contract.ts";
import { createEngine, type MailLink, type MailView } from "./engine.ts";
import { localMidnight } from "../reply-route.ts";
import { commentAdapter } from "./reply-adapter.ts";
import { realMailLink } from "./mail-link.ts";
import { approvalHash, createApprovalSender } from "../approval-send.ts";
import { createReplyActions } from "../reply-actions.ts";
import { addDraft, getDraft, setStatus, type DraftRec } from "../../features/reply-drafts/lib/store.ts";
import { HEADINGS, loadStyle, paths, profileBullets } from "../../features/reply-drafts/lib/settings.ts";
import { generateReply } from "../reply-draft.ts";
import { replyLearning } from "../reply-mail.ts";
import type { Lesson } from "../reply-types.ts";

const NOW = Date.parse("2026-11-13T00:00:00.000Z");
const source: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const raw: RawComment = { native: "c1", thread: "p1", author: "팬", text: "다음 편 언제 올라와요?", postTitle: "Post one", at: NOW - 1000 };
const reply = (body: string, lesson = "", extra: object = {}) => `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks", to: "", body, questions: [], lesson, ...extra })}\n\`\`\``;
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

function setup(o: { model?: string[]; learn?: string[]; taught?: Lesson[]; prompts?: string[]; tone?: true; files?: MailView["attachments"]; now?: number; mail?: MailLink; posts?: ReplyOutcome[]; answered?: { thread: string; at: number }[] } = {}) {
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { youtube: source } }));
	const posts = [...(o.posts ?? [])];
	const platform: CommentAdapter = { kind: "youtube", list: async () => ({ comments: [raw], cursor: "1" }), reply: async () => posts.shift() ?? { ok: true, ref: "r1" }, posts: async () => [] };
	const mails = new Map<string, MailView>([["RMAIL01", { id: "RMAIL01", to: "fan@example.com", subject: "자료", body: "보내드려요", attachments: o.files ?? [] }]]);
	const mail: MailLink = o.mail ?? { compose: async () => ({ ok: false, reason: "x" }), send: async () => ({ ok: true, text: "" }), drop: () => undefined, revise: async () => ({ ok: false, reason: "x" }), view: id => mails.get(id), edit: (id, text, subject) => (mails.set(id, { ...mails.get(id)!, body: text, ...(subject !== undefined ? { subject } : {}) }), { ok: true }) };
	let n = 0;
	const outs = o.model ?? [reply("이번 주말이에요!")];
	const engine = createEngine({ dir, now: () => o.now ?? NOW, collector: "mac", adapters: { youtube: platform }, model: async (system, user) => (o.prompts?.push(`${system}\n${user}`), { text: outs[Math.min(n++, outs.length - 1)]! }), mail, learn: lesson => void (o.learn?.push(lesson.line), o.taught?.push(lesson)), style: o.tone ? src => loadStyle({ app: src.key }) : () => ({ rules: [], corrections: [], forbidden: ["무조건"], samples: [] }), answeredMailThread: (thread, at) => void o.answered?.push({ thread, at }) });
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

test("edit keeps the code, stores the owner's text, makes the draft unclean and refuses a forbidden word", async () => {
	const { engine, a } = setup();
	const code = await drafted(engine);
	expect(await a.edit(code, "무조건 토요일!")).toMatchObject({ ok: false, reason: { code: "forbidden_word" } });
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const d = engine.store.drafts().find(x => x.code === code)!;
	expect([d.text, d.clean, d.editedFrom]).toEqual(["토요일에 올릴게요 :)", false, "이번 주말이에요!"]);
	expect(await a.markSent(code)).toEqual({ ok: true });
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

async function store(l: Lesson | undefined): Promise<void> {
	if (!l) throw new Error("no lesson");
	const learning = replyLearning(() => ({}));
	await learning.record(l.key, l.line);
	await learning.forbid(l.key, l.forbid ?? []);
}

test("K1 a comment revise that quotes a wording leaves the ban and the lesson in the source's own profile, and the next draft's prompt carries both", async () => {
	const prompts: string[] = [];
	const { engine, a } = setup({ tone: true, prompts, model: [reply("이번 주말이에요!"), reply("토요일에 올라가요", LESSON, { forbid: [BAN], everywhere: false }), reply("토요일 저녁이에요")] });
	const code = await drafted(engine);
	const r = await a.revise(code, CHANGE);
	expect(r).toMatchObject({ ok: true, lesson: { key: { app: "youtube" }, line: LESSON, forbid: [BAN] } });
	await store(r.ok ? r.lesson : undefined);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.corrections).join("\n")).toContain(LESSON);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([]);
	if (!r.ok) throw new Error("revise failed");
	prompts.length = 0;
	expect((await a.revise(r.ref, "더 짧게")).ok).toBe(true);
	expect(prompts[0]).toContain(BAN);
	expect(prompts[0]).toContain(LESSON);
});

test("K1 a comment revise the model says holds everywhere is a standing rule of install.md and a draft of another app carries it", async () => {
	const { engine, a } = setup({ tone: true, model: [reply("이번 주말이에요!"), reply("토요일에 올라가요", LESSON, { forbid: [BAN], everywhere: true })] });
	const code = await drafted(engine);
	const r = await a.revise(code, CHANGE);
	expect(r).toMatchObject({ ok: true, lesson: { key: { app: "install" }, line: LESSON, forbid: [BAN] } });
	await store(r.ok ? r.lesson : undefined);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual([LESSON]);
	expect(profileBullets("install", HEADINGS.corrections)).toEqual([]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([]);
	let seen = "";
	await generateReply({ kind: "comment", app: "instagram", from: "팬", text: "언제 올라와요?", context: "" }, loadStyle({ app: "instagram" }), async (system, user) => ((seen = `${system}\n${user}`), reply("토요일이에요")));
	expect(seen).toContain(BAN);
	expect(seen).toContain(LESSON);
});

test("K3 a one-off comment change returns no lesson and writes no tone file; K4 a wording the change text does not hold is not a ban", async () => {
	const { engine, a } = setup({ tone: true, model: [reply("이번 주말이에요!"), reply("토요일이에요", "", { forbid: [], everywhere: true }), reply("토요일 밤이에요", "", { forbid: ["받은 댓글에 있던 말"] })] });
	const code = await drafted(engine);
	const one = await a.revise(code, "토요일로만");
	expect(one.ok && one.lesson).toBeFalsy();
	const next = one.ok ? await a.revise(one.ref, "밤으로만") : one;
	expect(next.ok && next.lesson).toBeFalsy();
	expect(loadStyle({ app: "youtube" })).toMatchObject({ rules: [], corrections: [], forbidden: [] });
	expect(existsSync(paths.toneDir())).toBe(false);
});

test("an edited comment reply teaches what he changed once it went up, not before and not when the post failed", async () => {
	const taught: Lesson[] = [];
	const failed = setup({ taught, posts: [{ ok: false, reason: "x", code: "rejected", sent: "no" }] });
	const lost = await drafted(failed.engine);
	expect(await failed.a.edit(lost, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	const bad = failed.engine.send(lost, { by: "owner" });
	if (!bad.ok) throw new Error(bad.reason);
	await bad.done;
	expect(taught).toEqual([]);

	const { engine, a } = setup({ taught });
	const code = await drafted(engine);
	expect(await a.edit(code, "토요일에 올릴게요 :)")).toEqual({ ok: true });
	expect(taught).toEqual([]);
	const r = engine.send(code, { by: "owner" });
	if (!r.ok) throw new Error(r.reason);
	await r.done;
	expect(taught).toHaveLength(1);
	expect(taught[0]).toMatchObject({ key: { app: "youtube" } });
	expect(taught[0]!.line).toContain("토요일에 올릴게요");
});

test("a comment reply posted as the model wrote it teaches nothing", async () => {
	const taught: Lesson[] = [];
	const { engine } = setup({ taught });
	const code = await drafted(engine);
	const p = engine.send(code, { by: "owner" });
	if (!p.ok) throw new Error(p.reason);
	await p.done;
	expect(taught).toEqual([]);
});

const mailRevision = (lesson: string, extra: object = {}) => reply("자료 보내드려요. 확인 부탁드려요.", lesson, { to: "fan@example.com", subject: "Re: 자료", ...extra });

async function reviseMailPart(o: { everywhere: boolean; instance?: string; part: "mail" | "reply" }) {
	const model = [reply("이번 주말이에요!"), mailRevision(LESSON, { forbid: [BAN], everywhere: o.everywhere }), reply("토요일에 올라가요", LESSON, { forbid: [BAN], everywhere: o.everywhere })];
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
		expect(cards[0]!.split("\n")[0]).toStartWith("[ask] 고친 초안이에요. 앞으로 ");
		expect(cards[0]!.split("\n")[0]).toContain(BAN);
	});
}

test("a mail revise of a comment card teaches the mail profile the linked mail's drafts read, or install when said everywhere", async () => {
	await reviseMailPart({ everywhere: false, instance: "mail-teaching", part: "mail" });
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets({ app: "mail-teaching" }, HEADINGS.forbidden)).toEqual([]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual([]);
});

test("a mail revise of a comment card the model says holds everywhere is a standing rule of install.md", async () => {
	await reviseMailPart({ everywhere: true, instance: "mail-teaching", part: "mail" });
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual([BAN]);
	expect(profileBullets({ app: "mail-teaching" }, HEADINGS.forbidden)).toEqual([]);
});
