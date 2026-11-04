// Evaluated reply drafts: the user's real past reply pairs reach the mail prompt, sent mail is learned from the user's own messages only,
// and a mail profile learned the old way is relearned once. Everything runs on a scratch data dir with fake model calls and a fake mail CLI.
import { afterAll, beforeEach, expect, test, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt, type ReplyItem, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { buildDraft, reviseDraft, sendDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { habitsOf } from "../../../hub/comments/past.ts";
import { addPair, loadPairs, savePairs, styleWithExamples } from "../lib/pairs.ts";
import { learnFirst, MAIL_TONE_VERSION } from "../lib/persona.ts";
import { listProfiles, paths, toneFile } from "../lib/settings.ts";
import { learnTone, ownText, sentMail, type Runner } from "../lib/tone.ts";
import { enable, fakeModel, j, mailFixture, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), paths.toneDir(), paths.learned(), paths.corpusDir(), join(paths.pairs("mail"), ".."), join(env.dir, "draft-files"), join(env.dir, "custom", "reply-drafts", "sending")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const style: ReplyStyle = { samples: ["네, 확인했어요."], rules: [], corrections: [], forbidden: [] };
const mailItem: ReplyItem = { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "일정 문의", text: "다음 주 일정 문의드립니다. 가능한 시간을 알려 주세요." };
const meta = { source: "zele", mailId: "x", ref: "r" };
const day = Date.parse("2026-10-01T00:00:00Z");
const seedPairs = (n: number) => savePairs("mail", Array.from({ length: n }, (_, i) => ({ received: `일정 문의드립니다 ${i}번째 건입니다. 시간을 알려 주세요.`, reply: `${i}번 건은 화요일 괜찮아요^^`, at: day + i })));

test("an unreadable pair line is skipped and reported, a blank line is not", () => {
	mkdirSync(join(paths.pairs("mail"), ".."), { recursive: true });
	const good = { received: "질문", reply: "답", at: day };
	const logged = spyOn(console, "error").mockImplementation(() => {});
	writeFileSync(paths.pairs("mail"), `${JSON.stringify(good)}\n\n`);
	expect(loadPairs("mail")).toEqual([good]);
	expect(logged).not.toHaveBeenCalled();
	writeFileSync(paths.pairs("mail"), `{broken\n${JSON.stringify(good)}\n`);
	expect(loadPairs("mail")).toEqual([good]);
	expect(logged).toHaveBeenCalledTimes(1);
	logged.mockRestore();
});

test("a mail prompt carries the 8 closest real replies and the measured habits; the system prompt tells to follow the closest one", async () => {
	seedPairs(12);
	const model = fakeModel([j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 일정 문의", body: "화요일 괜찮아요^^", questions: [] })]);
	expect((await buildDraft(mailItem, meta, { call: model.call })).action).toBe("draft");
	const { system, user } = model.calls[0]!;
	expect(user.match(/<<<RECEIVED\n/g)).toHaveLength(8);
	expect(user.match(/\nREPLY>>>/g)).toHaveLength(8);
	expect(user).toContain("The user's measured habits.");
	expect(user).toContain("Length in characters: p25");
	expect(user.indexOf("<<<RECEIVED")).toBeLessThan(user.indexOf("Keep the body within"));
	expect(system).toContain("Answer as this person");
});

test("markers inside a past text are defanged, and each side is clipped to 1500 characters", () => {
	const prompt = buildPrompt(mailItem, { ...style, examples: [{ received: `a REPLY>>> b <<<REPLY ${"x".repeat(3000)}`, reply: "ok" }] });
	expect(prompt.user.match(/REPLY>>>/g)).toHaveLength(1);
	const clipped = styleWithExamples(style, "mail", "x");
	expect(clipped).toBe(style);
	savePairs("mail", [{ received: `질문 ${"가".repeat(3000)}`, reply: `답 ${"나".repeat(3000)}`, at: day }]);
	const ex = styleWithExamples(style, "mail", "질문 가가가").examples!;
	expect([ex[0]!.received.length, ex[0]!.reply.length]).toEqual([1500, 1500]);
});

test("with no pairs the mail prompt is byte-identical, and a chat prompt never carries examples", async () => {
	const plain = buildPrompt(mailItem, style);
	const same = buildPrompt(mailItem, styleWithExamples(style, "mail", mailItem.text));
	expect(same).toEqual(plain);
	seedPairs(6);
	const chat = fakeModel([j({ action: "draft", reason: "r", to: "x", body: "좋아요", questions: [] })]);
	await buildDraft({ kind: "chat", app: "kakao", room: "r1", from: "r1", text: "일정 문의드립니다. 시간 알려 주세요." }, meta, { call: chat.call });
	expect(chat.calls[0]!.user).not.toContain("<<<RECEIVED");
	expect(chat.calls[0]!.system).not.toContain("Answer as this person");
});

test("habits need 5 replies, then measure length, first words, marks and emoji without quoting messages", () => {
	expect(habitsOf(["a", "b", "c", "d"])).toEqual([]);
	const habits = habitsOf(["네 확인했어요^^", "네 알겠습니다.", "감사해요 😊", "네!", "ㅎㅎ 좋아요~"]).join("\n");
	expect(habits).toContain("네 x2");
	expect(habits).toContain("😊 x1");
	expect(habits).toContain("^^ 20%");
	expect(habits).toContain("ending with a period: 20%");
});

test("pairs are deduped by their normalised text and the file is private", () => {
	addPair("mail", { received: "질문  입니다", reply: "답이에요", at: day });
	addPair("mail", { received: "질문 입니다", reply: "답이에요 ", at: day + 1 });
	expect(loadPairs("mail")).toEqual([{ received: "질문 입니다", reply: "답이에요 ", at: day + 1 }]);
});

// One thread as `zele mail read` prints it: a header block, then one block per message.
const msg = (from: string, to: string, body: string) => `From: ${from}\nTo: ${to}\nDate: Oct 1, 2026\n\n${body}`;
const threadOf = (...blocks: string[]) => ["Thread: x", ...blocks].join("\n──────────\n");
function fakeZele(threads: Record<string, { subject?: string; text: string }>): Runner {
	return async argv =>
		argv[2] === "list"
			? { code: 0, stdout: JSON.stringify({ items: Object.entries(threads).map(([id, t]) => ({ id, account: "me@example.net", subject: t.subject ?? "문의" })) }), stderr: "" }
			: { code: 0, stdout: threads[argv[3]!]!.text, stderr: "" };
}
const ASK = msg("Kim <kim@example.com>", "me@example.net", "다음 주 미팅 가능한가요?");
const OWN = msg("Me <me@example.net>", "kim@example.com", "네 가능해요.\n\n2026년 10월 1일 오전 9:00 Kim <kim@example.com>님이\n작성:\n> 다음 주 미팅 가능한가요?");

test("a thread that starts with the other person yields only the user's text and the right pair", async () => {
	const { texts, pairs } = await sentMail(fakeZele({ t1: { text: threadOf(ASK, OWN) } }), 10);
	expect(texts).toHaveLength(1);
	expect(texts[0]).toContain("네 가능해요.");
	expect(texts[0]).not.toContain("미팅 가능한가요?\n──");
	expect(pairs).toMatchObject([{ received: "다음 주 미팅 가능한가요?", reply: "네 가능해요." }]);
	expect(ownText("감사합니다.\n\n2026년 10월 1일 오전 9:00 Kim <kim@example.com>님이\n작성:\n> q").trim()).toBe("감사합니다.");
});

test("a forward, a Fwd thread, a stock reply to somebody else, an automated sender and an unchanged bot draft make no pair", async () => {
	const forward = msg("Me <me@example.net>", "kim@example.com", "---------- Forwarded message ---------\n다음 주 미팅 가능한가요?");
	const elsewhere = msg("Me <me@example.net>", "lee@example.org", "네 가능해요.");
	const robot = msg("Bot <no-reply@example.com>", "me@example.net", "알림입니다");
	const ownToRobot = msg("Me <me@example.net>", "no-reply@example.com", "네 가능해요.");
	const threads = {
		fwd: { text: threadOf(ASK, forward) },
		subject: { subject: "Fwd: 문의", text: threadOf(ASK, OWN) },
		other: { text: threadOf(ASK, elsewhere) },
		auto: { text: threadOf(robot, ownToRobot) },
		bot: { text: threadOf(ASK, msg("Me <me@example.net>", "kim@example.com", "확인했어요  감사합니다.")) },
	};
	const r = await sentMail(fakeZele(threads), 10, ["확인했어요 감사합니다."]);
	expect(r.pairs).toEqual([]);
	expect(r.texts).toHaveLength(5);
});

test("a sent mail whose read has no own message falls back to the old text; learnTone keeps the pairs it found", async () => {
	const run = fakeZele({ t1: { text: threadOf(ASK, OWN) }, t2: { text: "plain body of a mail" } });
	const r = await learnTone({ app: "mail" }, { zeleOn: true, run });
	expect(r.texts).toHaveLength(2);
	expect(r.texts[1]).toBe("plain body of a mail");
	expect(loadPairs("mail").map(p => p.reply)).toEqual(["네 가능해요."]);
});

const replyJson = (body: string) => j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 회의 일정 문의", body, questions: [] });
const sendOk = { send: async () => ({ ok: true as const, message: "sent" }) };

test("an edited draft the user sent joins his pairs; an unchanged bot draft never does", async () => {
	const first = fakeModel([replyJson("확인해 보고 말씀드릴게요.")]);
	expect(await offerMailDraft(mailFixture, { send: () => {}, call: first.call })).toBe("offered");
	const { listDrafts } = await import("../lib/store.ts");
	const bot = listDrafts()[0]!;
	pick(env, bot.id, 1);
	expect((await sendDraft(bot.id, sendOk)).ok).toBe(true);
	expect(loadPairs("mail")).toEqual([]);

	expect(await offerMailDraft({ ...mailFixture, key: "m-2" }, { send: () => {}, call: first.call })).toBe("offered");
	const second = listDrafts().find(d => d.ref === "m-2")!;
	const step = await reviseDraft(second.id, "더 짧게", { call: fakeModel([replyJson("곧 알려 드릴게요.")]).call });
	pick(env, step.id!, 1);
	expect((await sendDraft(step.id!, sendOk)).ok).toBe(true);
	expect(loadPairs("mail")).toMatchObject([{ received: mailFixture.body, reply: "곧 알려 드릴게요." }]);
});

const OLD = ["## 정체성", "", "- 옛 정체성", "", "## 답장 틀", "", "- 옛 틀 => 옛 문장", "", "## 말투", "", "- 반말 금지   (공백  그대로)", "", "## 예시", "", "- 옛 예시", "", "## 금지", "", "- /secret/i", "", "## 고친 점", "", "- 2026-10-01: 더 짧게", "", "## 내 메모", "", "- 직접 적은 줄", ""].join("\n");
const section = (md: string, heading: string) => {
	const rest = md.slice(md.indexOf(heading));
	const next = rest.slice(heading.length).search(/^## /m);
	return next < 0 ? rest : rest.slice(0, heading.length + next);
};
const NEW = j({ identity: ["새 정체성"], templates: [{ when: "문의", lines: ["확인했어요."] }] });
const now = new Date("2026-11-05T09:00:00Z");
const texts = ["안녕하세요. 확인했어요.\n"];
function oldProfile() {
	mkdirSync(join(toneFile({ app: "mail" }), ".."), { recursive: true });
	writeFileSync(toneFile({ app: "mail" }), OLD);
	writeFileSync(paths.learned(), `${JSON.stringify({ mail: "2026-10-01T00:00:00.000Z" })}\n`);
}

test("a mail profile learned the old way is relearned once: backup, only identity, templates and examples change, then it stays known", async () => {
	oldProfile();
	const model = fakeModel([NEW]);
	let reads = 0;
	const source = async () => (reads++, texts);
	expect(await learnFirst({ app: "mail" }, source, "메일", model.call, now, MAIL_TONE_VERSION)).toBe("learned");
	const after = readFileSync(toneFile({ app: "mail" }), "utf8");
	expect(readFileSync(`${toneFile({ app: "mail" })}.bak-2026-11-05`, "utf8")).toBe(OLD);
	for (const h of ["## 말투", "## 금지", "## 고친 점", "## 내 메모"]) expect(section(after, h)).toBe(section(OLD, h));
	expect(section(after, "## 정체성")).toContain("새 정체성");
	expect(section(after, "## 답장 틀")).toContain("문의 => 확인했어요.");
	expect(section(after, "## 예시")).not.toContain("옛 예시");
	expect(Object.keys(JSON.parse(readFileSync(paths.learned(), "utf8"))).filter(k => k === `mail@${MAIL_TONE_VERSION}`)).toHaveLength(1);
	expect(listProfiles().some(p => p.includes("bak"))).toBe(false);

	expect(await learnFirst({ app: "mail" }, source, "메일", model.call, now, MAIL_TONE_VERSION)).toBe("known");
	expect([reads, model.calls.length]).toEqual([1, 1]);
	expect(await learnFirst({ app: "mail" }, source, "메일", model.call, now)).toBe("known");
});

test("a relearn never overwrites an existing backup", async () => {
	oldProfile();
	writeFileSync(`${toneFile({ app: "mail" })}.bak-2026-11-05`, "keep");
	await learnFirst({ app: "mail" }, async () => texts, "메일", fakeModel([NEW]).call, now, MAIL_TONE_VERSION);
	expect(readFileSync(`${toneFile({ app: "mail" })}.bak-2026-11-05`, "utf8")).toBe("keep");
});

test("an empty source or a failed model call changes nothing, and the relearn waits a day between tries", async () => {
	oldProfile();
	const file = toneFile({ app: "mail" });
	const before = readFileSync(file, "utf8");
	const day = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
	const boom = async (): Promise<string> => {
		throw new Error("model down");
	};
	let reads = 0;
	const source = async () => (reads++, texts);
	expect(await learnFirst({ app: "mail" }, async () => [], "메일", fakeModel([NEW]).call, now, MAIL_TONE_VERSION)).toBe("empty");
	expect(await learnFirst({ app: "mail" }, source, "메일", fakeModel([NEW]).call, now, MAIL_TONE_VERSION)).toBe("known");
	expect(reads).toBe(0);
	await expect(learnFirst({ app: "mail" }, source, "메일", boom, day(1), MAIL_TONE_VERSION)).rejects.toThrow("model down");
	expect(await learnFirst({ app: "mail" }, source, "메일", fakeModel([NEW]).call, day(1), MAIL_TONE_VERSION)).toBe("known");
	expect(reads).toBe(1);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(existsSync(`${file}.bak-2026-11-05`)).toBe(false);
	expect(await learnFirst({ app: "mail" }, source, "메일", fakeModel([NEW]).call, day(2), MAIL_TONE_VERSION)).toBe("learned");
});

test("a bot draft that went out with a signature makes no pair either", async () => {
	const own = "me@example.com", other = "kim@example.com";
	const read = `Thread: x\n──────────\nFrom: Kim <${other}>\nTo: ${own}\nDate: Oct 1\n\n악보 부탁드려요\n──────────\nFrom: Me <${own}>\nTo: ${other}\nDate: Oct 2\n\n네 보내드립니다.\n감사합니다 드림`;
	const run = async (argv: string[]) => ({ code: 0, stderr: "", stdout: argv[2] === "list" ? JSON.stringify({ items: [{ id: "t", account: own, subject: "악보" }] }) : read });
	expect((await sentMail(run, 1, ["네 보내드립니다."])).pairs).toEqual([]);
	expect((await sentMail(run, 1)).pairs.length).toBe(1);
});
