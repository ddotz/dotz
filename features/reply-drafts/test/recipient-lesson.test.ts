import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createApprovalSender } from "../../../hub/approval-send.ts";
import { type CommentAdapter, commentId, type SourceConfig } from "../../../hub/comments/contract.ts";
import { createEngine, type MailLink } from "../../../hub/comments/engine.ts";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import type { PastPair } from "../../../hub/comments/past.ts";
import { commentStyle } from "../../../hub/comments/real.ts";
import { commentAdapter } from "../../../hub/comments/reply-adapter.ts";
import { createReplyActions, type ReplyDeps } from "../../../hub/reply-actions.ts";
import { addressesOf, type ReplyItem } from "../../../hub/reply-draft.ts";
import { mailAdapter, replyLearning } from "../../../hub/reply-mail.ts";
import { lessonNote } from "../../../hub/reply-reasons.ts";
import type { ReplyAdapter } from "../../../hub/reply-types.ts";
import { journalEntries } from "../lib/curate.ts";
import { buildDraft, reviseDraft } from "../lib/flow.ts";
import { styleFrom } from "../lib/pairs.ts";
import { HEADINGS, paths, profileBullets, recipientFile, toneFile } from "../lib/settings.ts";
import { addDraft, type DraftRec } from "../lib/store.ts";
import { fakeModel, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.toneDir(), paths.drafts()]) rmSync(p, { force: true, recursive: true });
});

const LINE = "이분께는 끝인사를 짧게 한다";
const CHANGE = "이분께는 끝인사 짧게 해 줘";
const RECIPIENT_HEAD = "The user's conditions for this recipient only (he set them for the person this reply goes to; where a rule or correction above says otherwise, these win):";
const A_FILE = join("mail", "to", "a_0040x_002ecom.md");
const NOW = Date.parse("2026-11-20T00:00:00.000Z");

const mailItem = (from: string): ReplyItem => ({ kind: "mail", app: "mail", from, self: ["me@example.net"], subject: "일정", text: "다음 주 일정 알려 주세요" });
const mailRec = (id: string, from: string): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", mailId: id, ref: `k-${id}`, to: addressesOf(from)[0] ?? "", subject: "Re: 일정", body: "네 확인했어요", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: mailItem(from) }) as unknown as DraftRec;
const revised = (said: object, to = "a@x.com") => j({ action: "draft", reason: "r", to, subject: "Re: 일정", body: "네 다음 주 화요일이에요", questions: [], lesson: LINE, forbid: [], ...said });
const promptOf = async (from: string): Promise<string> => {
	const model = fakeModel([j({ action: "draft", reason: "r", to: addressesOf(from)[0] ?? "", subject: "Re: 일정", body: "네 확인했어요", questions: [] })]);
	await buildDraft(mailItem(from), { source: "zele", mailId: "m9", ref: "k9" }, { call: model.call });
	return `${model.calls[0]!.system}\n${model.calls[0]!.user}`;
};
const recipientPart = (prompt: string): string => (prompt.includes(RECIPIENT_HEAD) ? prompt.slice(prompt.indexOf(RECIPIENT_HEAD)) : "");

function toneTree(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[relative(paths.toneDir(), p)] = readFileSync(p, "utf8");
		}
	};
	walk(paths.toneDir());
	return out;
}

async function onCard(adapter: ReplyAdapter, ref: string, change: string, learning: ReplyDeps["learning"] = replyLearning(() => ({})), part?: "mail", log: (line: string) => void = () => undefined): Promise<string> {
	const cards: string[] = [];
	const sender = createApprovalSender({ kind: () => undefined, fingerprint: async () => undefined, run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined, now: () => 1, undoMs: () => 0, after: () => undefined });
	const actions = createReplyActions({
		adapters: [adapter],
		sender,
		recordPick: () => undefined,
		learning,
		cards: { open: () => [], replace: (_o, _n, text) => void cards.push(text), rewrite: (_r, text) => void cards.push(text), repost: async () => undefined, close: () => undefined },
		toBot: async () => undefined,
		emit: () => undefined,
		log,
	});
	const res = await actions.act({ ref, action: "revise", change, ...(part ? { part } : {}) }, { surface: "web", login: "me" });
	expect(res.status).toBe(202);
	await actions.idle();
	expect(cards).toHaveLength(1);
	return cards[0]!.split("\n")[0]!;
}

async function mailCard(from: string, said: object, learning?: ReplyDeps["learning"]): Promise<string> {
	addDraft(mailRec("RMA1", from));
	const model = fakeModel([revised(said, addressesOf(from)[0] ?? "")]);
	return onCard(mailAdapter(() => ({ call: model.call })), "RMA1", CHANGE, learning);
}

test("a mail revise whose answer says recipient stores the line in that person's file only, the card names him, and only his next draft carries it under the recipient heading", async () => {
	const first = await mailCard("Kim <a@x.com>", { scope: "recipient" });
	expect(first).toBe(`[ask] 고친 초안이에요. 앞으로 a@x.com에게 보내는 답장에 반영해요: ${LINE}`);
	expect(Object.keys(toneTree())).toEqual([A_FILE]);
	expect(profileBullets({ app: "mail", to: "a@x.com" }, HEADINGS.corrections)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}: ${LINE}$`))]);
	expect(recipientPart(await promptOf("Kim <A@X.com>"))).toContain(LINE);
	const other = await promptOf("Lee <b@x.com>");
	expect(other).not.toContain(LINE);
	expect(other).not.toContain(RECIPIENT_HEAD);
});

test("draft.ts revise writes a recipient lesson, its ban and its wording pattern to that person's file and says so", async () => {
	addDraft(mailRec("RMA2", "Kim <a@x.com>"));
	const asked: string[] = [];
	const learnCall = () => async (system: string) => (asked.push(system.includes("style conditions") ? "curate" : "pattern"), system.includes("style conditions") ? JSON.stringify({ replaces: [] }) : j({ parts: [{ any: ["하루"] }, { gap: 3 }, { any: ["되세요"] }], label: "'하루 보내세요'로 쓴다", bad: ["행복한 하루 되세요"], good: [] }));
	const model = fakeModel([j({ action: "draft", reason: "r", to: "a@x.com", subject: "Re: 일정", body: "네 다음 주 화요일이에요", questions: [], lesson: LINE, forbid: ["행복한 하루 되세요"], scope: "recipient" })]);
	const step = await reviseDraft("RMA2", "이분께는 '행복한 하루 되세요' 쓰지 말고 짧게", { call: model.call, learnCall });
	expect(step).toMatchObject({ ok: true, lesson: { key: { app: "mail", to: "a@x.com" }, line: LINE, forbid: ["행복한 하루 되세요"] } });
	expect(step.text).toContain(`앞으로 a@x.com에게 보내는 답장에 반영해요: ${LINE}`);
	expect(step.text).toContain("앞으로 a@x.com에게 보내는 답장에서 쓰지 않을 표현: '행복한 하루 되세요'");
	expect(asked).toEqual(["pattern"]);
	expect(Object.keys(toneTree())).toEqual([A_FILE]);
	expect(profileBullets({ app: "mail", to: "a@x.com" }, HEADINGS.forbidden)).toHaveLength(2);
});

test("a recipient lesson that repeats what that person's file already says replaces it instead of adding a second line, curated against that file", async () => {
	const file = toneFile({ app: "mail", to: "a@x.com" });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `## 고친 점\n\n- 2030-03-01: ${LINE}\n`);
	addDraft(mailRec("RMA3", "Kim <a@x.com>"));
	const curated: string[] = [];
	const learnCall = () => async (system: string, user: string) => (system.includes("style conditions") ? (curated.push(user), JSON.stringify({ replaces: [{ id: "C1", why: "same" }] })) : "{}");
	const step = await reviseDraft("RMA3", CHANGE, { call: fakeModel([revised({ scope: "recipient" })]).call, learnCall });
	expect(curated).toHaveLength(1);
	expect(curated[0]).toContain(`2030-03-01: ${LINE}`);
	expect(step.text).toContain(`앞으로 a@x.com에게 보내는 답장에 반영해요: ${LINE} · 기존 조건 1개를 이 조건으로 바꿨어요`);
	expect(profileBullets({ app: "mail", to: "a@x.com" }, HEADINGS.corrections)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}: ${LINE}$`))]);
	expect(journalEntries().map(e => [e.profile, e.why])).toEqual([["mail/to/a_0040x_002ecom.md", "same"]]);
	expect(existsSync(toneFile({ app: "mail" }))).toBe(false);
});

test("on the card a recipient lesson that makes that person's corrections long compacts that person's file only", async () => {
	const earlier = Array.from({ length: 12 }, (_, i) => `2030-03-${String(i + 1).padStart(2, "0")}: 예전에 고친 점 ${i + 1}`);
	const file = toneFile({ app: "mail", to: "a@x.com" });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `## 고친 점\n\n${earlier.map(l => `- ${l}`).join("\n")}\n`);
	const asked: string[] = [];
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	await mailCard("Kim <a@x.com>", { scope: "recipient" }, replyLearning(() => ({ learnCall: () => async (_system, user) => (asked.push(user), JSON.stringify({ replaces: [] })) })));
	log.mockRestore();
	expect(asked).toHaveLength(2);
	for (const line of earlier) expect(asked[1]).toContain(line);
	expect(Object.keys(toneTree())).toEqual([A_FILE]);
});

test("a recipient lesson on a mail whose sender is only a name stays the channel's, and the card says so", async () => {
	const first = await mailCard("김 팀장", { scope: "recipient" });
	expect(first).toBe(`[ask] 고친 초안이에요. 앞으로 이 앱 답장에 반영해요: ${LINE}`);
	expect(Object.keys(toneTree())).toEqual(["mail.md"]);
});

test("scope everywhere and an older answer's everywhere: true both write a standing rule of install.md", async () => {
	for (const said of [{ scope: "everywhere" }, { everywhere: true }]) {
		rmSync(paths.toneDir(), { force: true, recursive: true });
		rmSync(paths.drafts(), { force: true, recursive: true });
		expect(await mailCard("Kim <a@x.com>", said)).toBe(`[ask] 고친 초안이에요. 앞으로 모든 답장에 반영해요: ${LINE}`);
		expect(toneTree()).toEqual({ "install.md": `## 말투\n\n- ${LINE}\n` });
	}
});

async function snapshot(said: object) {
	rmSync(paths.toneDir(), { force: true, recursive: true });
	rmSync(paths.drafts(), { force: true, recursive: true });
	const card = await mailCard("Kim <a@x.com>", said);
	return { card, files: toneTree(), toA: await promptOf("Kim <a@x.com>"), toB: await promptOf("Lee <b@x.com>") };
}

test("older answers store, say and prompt what they did before scope: a channel lesson in mail.md, an everywhere lesson in install.md, and the same as the scope that means it", async () => {
	const day = new Date().toISOString().slice(0, 10);
	const channel = await snapshot({ everywhere: false });
	expect(channel.card).toBe(`[ask] 고친 초안이에요. 앞으로 이 앱 답장에 반영해요: ${LINE}`);
	expect(channel.files).toEqual({ "mail.md": `## 고친 점\n\n- ${day}: ${LINE}\n` });
	expect(channel.toA).toBe(channel.toB.replaceAll("b@x.com", "a@x.com").replaceAll("Lee <", "Kim <"));
	expect(channel.toA).not.toContain(RECIPIENT_HEAD);
	expect(await snapshot({})).toEqual(channel);
	expect(await snapshot({ scope: "channel" })).toEqual(channel);
	expect(await snapshot({ scope: "anyone" })).toEqual(channel);
	const everywhere = await snapshot({ everywhere: true });
	expect(everywhere.card).toBe(`[ask] 고친 초안이에요. 앞으로 모든 답장에 반영해요: ${LINE}`);
	expect(everywhere.files).toEqual({ "install.md": `## 말투\n\n- ${LINE}\n` });
	expect(await snapshot({ scope: "everywhere" })).toEqual(everywhere);
});

const youtube: SourceConfig = { key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false };
const blog: SourceConfig = { key: "site-blog", kind: "website", label: "블로그 댓글", watch: ["*"], autoDraft: false };
const commentAnswer = (said: object = {}, lesson = "") => j({ action: "draft", reason: "r", to: "", body: "토요일에 올라가요", questions: [], lesson, ...said });
type Commenter = { author: string; authorId?: string };
const KIM_A: Commenter = { author: "김 선생님", authorId: "UC_kimA" };
const KIM_B: Commenter = { author: "김 선생님", authorId: "UC_kimB" };

function commentWorld(authors: Commenter[], o: { outs?: string[]; pairs?: PastPair[]; mail?: MailLink; src?: SourceConfig } = {}) {
	const src = o.src ?? youtube;
	const dir = mkdtempSync(join(tmpdir(), "rd-to-lesson-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: true, sources: { [src.key]: src } }));
	const platform: CommentAdapter = {
		kind: src.kind,
		list: async () => ({ comments: authors.map((who, i) => ({ native: `c${i}`, thread: "p1", ...who, text: "다음 편 언제 올라와요?", postTitle: "Post one", at: NOW - 1000 + i })), cursor: "1" }),
		reply: async () => ({ ok: true, ref: "r1" }),
		posts: async () => [],
	};
	const prompts: string[] = [];
	const outs = o.outs ?? [commentAnswer()];
	let n = 0;
	const engine = createEngine({ dir, now: () => NOW, collector: "mac", adapters: { [src.kind]: platform }, model: async (system, user) => (prompts.push(`${system}\n${user}`), { text: outs[Math.min(n++, outs.length - 1)]! }), style: commentStyle, pairs: { load: () => o.pairs ?? [], save: () => undefined }, ...(o.mail ? { mail: o.mail } : {}) });
	const draft = async (i: number): Promise<string> => {
		await engine.collect({ force: true });
		const step = await engine.makeDraft(commentId(src.key, `c${i}`));
		if (!step.ok) throw new Error(step.reason);
		return step.draft.code;
	};
	return { engine, prompts, draft, a: commentAdapter(engine), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a recipient lesson on one of two commenters with the same name is stored under his channel id, the card names him, and only his next comment's draft carries it", async () => {
	const w = commentWorld([KIM_A, KIM_B, KIM_A], { outs: [commentAnswer(), commentAnswer({ scope: "recipient" }, LINE), commentAnswer()] });
	try {
		const code = await w.draft(0);
		expect(await onCard(w.a, code, CHANGE)).toBe(`[ask] 고친 초안이에요. 앞으로 김 선생님에게 보내는 답장에 반영해요: ${LINE}`);
		expect(Object.keys(toneTree())).toEqual([join("youtube", "to", `${recipientFile("UC_kimA")}.md`)]);
		w.prompts.length = 0;
		await w.draft(2);
		await w.draft(1);
		expect(recipientPart(w.prompts[0]!)).toContain(LINE);
		expect(w.prompts[1]).not.toContain(LINE);
	} finally {
		w.close();
	}
});

test("the hub log names a commenter's recipient lesson by his id, never by the name the card shows", async () => {
	const w = commentWorld([KIM_A], { outs: [commentAnswer(), commentAnswer({ scope: "recipient" }, LINE)] });
	const logs: string[] = [];
	const failing: ReplyDeps["learning"] = { ...replyLearning(() => ({})), record: async () => Promise.reject(new Error("disk full")) };
	try {
		await onCard(w.a, await w.draft(0), CHANGE, failing, undefined, line => void logs.push(line));
		expect(logs).toContain("reply learning for youtube to UC_kimA failed: disk full");
	} finally {
		w.close();
	}
});

test("a recipient lesson on an anonymous comment stays the source's, and the card says so", async () => {
	const w = commentWorld([{ author: "익명" }], { outs: [commentAnswer(), commentAnswer({ scope: "recipient" }, LINE)] });
	try {
		expect(await onCard(w.a, await w.draft(0), CHANGE)).toBe(`[ask] 고친 초안이에요. 앞으로 이 앱 답장에 반영해요: ${LINE}`);
		expect(Object.keys(toneTree())).toEqual(["youtube.md"]);
	} finally {
		w.close();
	}
});

test("a website comment has no recipient level: its recipient lesson goes to the site's profile with the channel wording and no to/ file appears", async () => {
	const w = commentWorld([{ author: "홍길동" }], { src: blog, outs: [commentAnswer(), commentAnswer({ scope: "recipient" }, LINE)] });
	try {
		expect(await onCard(w.a, await w.draft(0), CHANGE)).toBe(`[ask] 고친 초안이에요. 앞으로 이 앱 답장에 반영해요: ${LINE}`);
		expect(Object.keys(toneTree())).toEqual(["site-blog.md"]);
	} finally {
		w.close();
	}
});

test("a recipient lesson of the mail that rides on a comment goes to that address's file under the shared mail profile", async () => {
	const mailAnswer = j({ action: "draft", reason: "r", to: "fan@example.com", subject: "Re: 자료", body: "자료 보내드려요", questions: [], lesson: LINE, forbid: [], scope: "recipient" });
	const w = commentWorld([{ author: "팬", authorId: "UC_fan" }], { mail: realMailLink({ call: async () => mailAnswer }) });
	try {
		const code = await w.draft(0);
		addDraft({ ...mailRec("RMAIL01", "fan@example.com"), app: "mail-teaching", account: "me@example.net" } as DraftRec);
		w.engine.store.putDraft({ ...w.engine.store.drafts().find(d => d.code === code)!, mail: "RMAIL01", mailAt: Date.now() });
		expect(await onCard(w.a, code, CHANGE, replyLearning(() => ({})), "mail")).toBe(`[ask] 고친 초안이에요. 앞으로 fan@example.com에게 보내는 답장에 반영해요: ${LINE}`);
		expect(Object.keys(toneTree())).toEqual([join("mail", "to", `${recipientFile("fan@example.com")}.md`)]);
	} finally {
		w.close();
	}
});

test("a comment draft puts up to three past replies to the same author id first, marked, then the most similar of the rest; an equal name marks nothing", async () => {
	const pair = (reply: string, fromId: string | undefined, at: number): PastPair => ({ comment: "다음 편 언제 올라와요?", reply, at, thread: "", ...(fromId ? { fromId } : {}) });
	const pairs = [pair("A1", "UC_kimA", NOW - 5), pair("A2", "UC_kimA", NOW - 4), pair("A3", "UC_kimA", NOW - 3), pair("A4", "UC_kimA", NOW - 2), pair("B1", "UC_kimB", NOW - 1), pair("N1", undefined, NOW)];
	const w = commentWorld([KIM_A, KIM_B, { author: "김 선생님" }], { pairs });
	try {
		await w.draft(0);
		await w.draft(1);
		await w.draft(2);
		const order = (prompt: string) => [...prompt.matchAll(/<<<RECEIVED\n(\(this same sender\)\n)?[^]*?<<<REPLY\n(\w+)\n/g)].map(m => `${m[2]}${m[1] ? "*" : ""}`);
		expect(order(w.prompts[0]!).slice(0, 3)).toEqual(["A4*", "A3*", "A2*"]);
		expect(order(w.prompts[0]!).slice(3).toSorted()).toEqual(["A1*", "B1", "N1"]);
		expect(order(w.prompts[1]!)[0]).toBe("B1*");
		expect(order(w.prompts[1]!).filter(e => e.endsWith("*"))).toEqual(["B1*"]);
		expect(order(w.prompts[2]!).some(e => e.endsWith("*"))).toBe(false);
	} finally {
		w.close();
	}
});

test("a mail draft puts up to three past replies to the same address first (two before scope), then the most similar of the rest", () => {
	const pair = (reply: string, from: string, at: number) => ({ received: "다음 주 일정 알려 주세요", reply, at, from });
	const pairs = [pair("A1", "Kim <a@x.com>", 1), pair("A2", "a@x.com", 2), pair("A3", "A@X.com", 3), pair("A4", "Kim <a@x.com>", 4), pair("B1", "b@x.com", 5)];
	const style = styleFrom({ rules: [], corrections: [], forbidden: [], samples: [] }, pairs, "다음 주 일정 알려 주세요", "Kim <a@x.com>");
	expect(style.examples?.slice(0, 3).map(e => [e.reply, e.same])).toEqual([["A4", true], ["A3", true], ["A2", true]]);
	expect(style.examples?.slice(3).map(e => e.reply).toSorted()).toEqual(["A1", "B1"]);
});

test("the card names the person a recipient lesson holds for by the name it was given, else as stored, cut to 40 characters, in its line and in its ban sentence", () => {
	expect(lessonNote({ key: { app: "mail", to: `${"a".repeat(30)}@example.com` }, line: LINE, forbid: ["행복한 하루 되세요"] })).toBe(`앞으로 ${"a".repeat(30)}@example.c…에게 보내는 답장에 반영해요: ${LINE} · 앞으로 ${"a".repeat(30)}@example.c…에게 보내는 답장에서 쓰지 않을 표현: '행복한 하루 되세요'`);
	expect(lessonNote({ key: { app: "youtube", to: "UC_kimA", toName: "김 선생님" }, line: "", forbid: ["ㅋㅋ"] })).toBe("앞으로 김 선생님에게 보내는 답장에서 쓰지 않을 표현: 'ㅋㅋ'");
	expect(lessonNote({ key: { app: "instagram", to: "foo.bar", toName: " Foo\nBar  " }, line: LINE })).toBe(`앞으로 Foo Bar에게 보내는 답장에 반영해요: ${LINE}`);
	expect(lessonNote({ key: { app: "mail", to: `${"b".repeat(28)}@example.com` }, line: LINE })).toBe(`앞으로 ${"b".repeat(28)}@example.com에게 보내는 답장에 반영해요: ${LINE}`);
	expect(lessonNote({ key: { app: "kakao", room: "1" }, line: LINE })).toBe(`앞으로 이 대화방 답장에 반영해요: ${LINE}`);
});
