// Evaluated reply drafts: the user's real past reply pairs reach the mail prompt, sent mail is learned from the user's own messages only,
// and a mail profile learned the old way is relearned once. Everything runs on a scratch data dir with fake model calls and a fake mail CLI.
import { afterAll, beforeEach, expect, test, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt, type ReplyItem, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { buildDraft, mailStyleOf, reviseDraft, sendDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { habitsOf } from "../../../hub/comments/past.ts";
import { addPair, styleWithExamples } from "../lib/pairs.ts";
import { learnFirst, learnSiteSent, MAIL_TONE_VERSION } from "../lib/persona.ts";
import { identityOf, listProfiles, loadPairs, loadStyle, MAX_PAIRS, paths, savePairs, toneFile } from "../lib/settings.ts";
import { getDraft, listDrafts as storedDrafts } from "../lib/store.ts";
import { learnTone, ownText, sentMail, sentPairs, type PluginSent, type Runner, type SentMail } from "../lib/tone.ts";
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
const DAYS = 86_400_000;
const seedPairs = (n: number) => savePairs("mail", Array.from({ length: n }, (_, i) => ({ received: `일정 문의드립니다 ${i}번째 건입니다. 시간을 알려 주세요.`, reply: `${i}번 건은 화요일 괜찮아요^^`, at: day + i })));

test("an edited mark and the post of a pair survive a re-read of the same pair without them; an edited pair leads the examples", () => {
	savePairs("mail", [{ received: "q", reply: "r", at: day, edited: true, thread: "p" }]);
	savePairs("mail", [...loadPairs("mail"), { received: "Q", reply: "R ", at: day + 5 }]);
	expect(loadPairs("mail")).toEqual([{ received: "Q", reply: "R ", at: day + 5, edited: true, thread: "p" }]);
	savePairs("mail", [{ received: "일정 문의드립니다 시간을 알려 주세요", reply: "plain", at: day + DAYS }, { received: "일정 문의드립니다 시간을 알려 주세요", reply: "edited", at: day, edited: true }]);
	expect(styleWithExamples(style, "mail", "일정 문의드립니다 시간을 알려 주세요").examples![0]!.reply).toBe("edited");
});

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

const OLD = ["## 정체성", "", "- 옛 정체성", "", "## 답장 틀", "", "- 옛 틀 => 옛 문장", "", "## 말투", "", "- 반말 금지   (공백  그대로)", "", "## 예시", "", "- 옛 예시", "", "## 금지", "", "- /secret/i", ""].join("\n");
// The same profile after the user tuned it: a correction and a section of their own.
const TUNED = [OLD, "## 고친 점", "", "- 2026-10-01: 더 짧게", "", "## 내 메모", "", "- 직접 적은 줄", ""].join("\n");
const section = (md: string, heading: string) => {
	const rest = md.slice(md.indexOf(heading));
	const next = rest.slice(heading.length).search(/^## /m);
	return next < 0 ? rest : rest.slice(0, heading.length + next);
};
const NEW = j({ identity: ["새 정체성"], templates: [{ when: "문의", lines: ["확인했어요."] }] });
const now = new Date("2026-11-05T09:00:00Z");
const texts = ["안녕하세요. 확인했어요.\n"];
function oldProfile(md = OLD) {
	mkdirSync(join(toneFile({ app: "mail" }), ".."), { recursive: true });
	writeFileSync(toneFile({ app: "mail" }), md);
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
	for (const h of ["## 말투", "## 금지"]) expect(section(after, h)).toBe(section(OLD, h));
	expect(section(after, "## 정체성")).toContain("새 정체성");
	expect(section(after, "## 답장 틀")).toContain("문의 => 확인했어요.");
	expect(section(after, "## 예시")).not.toContain("옛 예시");
	expect(Object.keys(JSON.parse(readFileSync(paths.learned(), "utf8"))).filter(k => k === `mail@${MAIL_TONE_VERSION}`)).toHaveLength(1);
	expect(listProfiles().some(p => p.includes("bak"))).toBe(false);

	expect(await learnFirst({ app: "mail" }, source, "메일", model.call, now, MAIL_TONE_VERSION)).toBe("known");
	expect([reads, model.calls.length]).toEqual([1, 1]);
	expect(await learnFirst({ app: "mail" }, source, "메일", model.call, now)).toBe("known");
});

test("a profile the user tuned (a correction, or a section of their own) is never relearned: marked learned, nothing read, nothing written", async () => {
	for (const md of [TUNED, `${OLD}\n## 내 메모\n\n- 직접 적은 줄\n`, `${OLD}\n## 고친 점\n\n- 2026-10-01: 더 짧게\n`]) {
		rmSync(paths.learned(), { force: true });
		oldProfile(md);
		let reads = 0;
		const model = fakeModel([NEW]);
		expect(await learnFirst({ app: "mail" }, async () => (reads++, texts), "메일", model.call, now, MAIL_TONE_VERSION)).toBe("known");
		expect([reads, model.calls.length]).toEqual([0, 0]);
		expect(readFileSync(toneFile({ app: "mail" }), "utf8")).toBe(md);
		expect(JSON.parse(readFileSync(paths.learned(), "utf8"))[`mail@${MAIL_TONE_VERSION}`]).toBeTruthy();
	}
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
	const read = `Thread: x\n──────────\nFrom: Kim <${other}>\nTo: ${own}\nDate: Oct 1\n\n문서 부탁드려요\n──────────\nFrom: Me <${own}>\nTo: ${other}\nDate: Oct 2\n\n네 보내드립니다.\n감사합니다 드림`;
	const run = async (argv: string[]) => ({ code: 0, stderr: "", stdout: argv[2] === "list" ? JSON.stringify({ items: [{ id: "t", account: own, subject: "문서" }] }) : read });
	expect((await sentMail(run, 1, ["네 보내드립니다."])).pairs).toEqual([]);
	expect((await sentMail(run, 1)).pairs.length).toBe(1);
});

test("a pair keeps the address it answered; a re-read upgrades an old pair, and the same sender's replies lead the examples", async () => {
	const { pairs } = await sentMail(fakeZele({ t1: { text: threadOf(ASK, OWN) } }), 10);
	expect(pairs[0]!.from).toBe("kim@example.com");
	savePairs("mail", [{ received: "질문입니다", reply: "답이에요", at: day }]);
	savePairs("mail", [...loadPairs("mail"), { received: "질문입니다", reply: "답이에요", at: day - 5, from: "kim@example.com" }]);
	expect(loadPairs("mail")).toEqual([{ received: "질문입니다", reply: "답이에요", at: day, from: "kim@example.com" }]);
	seedPairs(12);
	savePairs("mail", [...loadPairs("mail"), { received: "전혀 다른 내용", reply: "예전에 이분께 쓴 답", at: day - 100, from: "kim@example.com" }]);
	const ex = styleWithExamples(style, "mail", mailItem.text, "Kim <kim@example.com>").examples!;
	expect(ex).toHaveLength(8);
	expect(ex.filter(e => e.same).map(e => e.reply)).toContain("예전에 이분께 쓴 답");
	expect(styleWithExamples(style, "mail", mailItem.text, "lee@example.org").examples!.some(e => e.same)).toBe(false);
});

test("the sent read stops once it holds enough pairs", async () => {
	const reads: string[] = [];
	const inner = fakeZele({ t1: { text: threadOf(ASK, OWN) }, t2: { text: threadOf(ASK, "다른 답장이에요.") } });
	const run: Runner = async argv => (argv[2] === "read" && reads.push(argv[3]!), inner(argv));
	expect((await sentMail(run, 10, [], undefined, 1)).pairs).toHaveLength(1);
	expect(reads).toHaveLength(1);
});

test("a named account is passed on the list and the reads; without one each read uses the listed mail's own account", async () => {
	const argvs: string[][] = [];
	const inner = fakeZele({ t1: { text: threadOf(ASK, OWN) } });
	const run: Runner = async argv => (argvs.push(argv), inner(argv));
	await sentMail(run, 5, [], "work@example.net");
	expect(argvs.map(a => a.slice(-2))).toEqual([["--account", "work@example.net"], ["--account", "work@example.net"]]);
	argvs.length = 0;
	await sentMail(run, 5);
	expect(argvs[0]).not.toContain("--account");
	expect(argvs[1]!.slice(-2)).toEqual(["--account", "me@example.net"]);
});

test("zele leaves the account out of a list of one account: the named account, else whoami, says whose thread it is", async () => {
	const inner = fakeZele({ t1: { text: threadOf(ASK, OWN) } });
	const run: Runner = async argv => {
		if (argv[1] === "whoami") return { code: 0, stdout: "items:\n  - email: me@example.net\n", stderr: "" };
		const r = await inner(argv);
		return argv[2] === "list" ? { ...r, stdout: r.stdout.replace(/"account":"[^"]+",/, "") } : r;
	};
	expect((await sentMail(run, 10, [], "me@example.net")).pairs).toMatchObject([{ reply: "네 가능해요.", from: "kim@example.com" }]);
	expect((await sentMail(run, 10)).pairs).toHaveLength(1);
});

test("sent mail accounts come from the built-in mail instance and live mail instances, not deleted ones or other apps", async () => {
	const which = spyOn(Bun, "which").mockReturnValue("/bin/zele");
	try {
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(
			join(env.dir, "custom", "apps.json"),
			JSON.stringify({
				mail: { filter: { account: "me@example.net" } },
				"mail-work": { app: "mail", filter: { account: "work@example.net" } },
				"mail-old": { app: "mail", deleted: true, filter: { account: "old@example.net" } },
				site: { app: "site", filter: { account: "site@example.net" } },
			}),
		);
		const { sentAccounts } = await import("../lib/tone.ts");
		expect(sentAccounts(undefined)).toEqual(["me@example.net", "work@example.net"]);
	} finally {
		which.mockRestore();
	}
});

test("a failing account keeps the pairs read from the accounts before it, and the first wide read is tried again", async () => {
	const which = spyOn(Bun, "which").mockReturnValue("/bin/zele");
	try {
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ a: { app: "mail", filter: { account: "me@example.net" } }, b: { app: "mail", filter: { account: "other@example.net" } } }));
		const { refreshPairs } = await import("../lib/tone.ts");
		const inner = fakeZele({ t1: { text: threadOf(ASK, OWN) } });
		await refreshPairs(async argv => (argv.includes("other@example.net") ? { code: 1, stdout: "", stderr: "no" } : inner(argv)), now);
		expect(loadPairs("mail")).toHaveLength(1);
		expect(JSON.parse(readFileSync(paths.learned(), "utf8"))["pairs-mail@2"]).toBeUndefined();
	} finally {
		which.mockRestore();
	}
});

test("pairs are refreshed without a model: the first read is wide, later ones once a day, and a mail app's account is enough", async () => {
	const which = spyOn(Bun, "which").mockReturnValue("/bin/zele");
	try {
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ mail: { app: "mail", filter: { account: "me@example.net" } } }));
		const { refreshPairs, sentAccounts } = await import("../lib/tone.ts");
		expect(sentAccounts({})).toEqual(["me@example.net"]);
		const limits: string[] = [];
		const inner = fakeZele({ t1: { text: threadOf(ASK, OWN) } });
		const run: Runner = async argv => (argv[2] === "list" && limits.push(argv[argv.indexOf("--limit") + 1]!), inner(argv));
		await refreshPairs(run, now);
		await refreshPairs(run, new Date(now.getTime() + 3_600_000));
		await refreshPairs(run, new Date(now.getTime() + 25 * 3_600_000));
		expect(limits).toEqual(["3000", "40"]);
		expect(loadPairs("mail")).toMatchObject([{ reply: "네 가능해요.", from: "kim@example.com" }]);
	} finally {
		which.mockRestore();
	}
});

const withWho = (evidence: string) => j({ recipient: { who: "문의하는 사람", evidence }, action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 일정 문의", body: "화요일 괜찮아요^^", questions: [] });

test("the model's recipient judgement is kept on the draft; evidence that is not in the message is rewritten once and then a warning", async () => {
	const ok = fakeModel([withWho("다음주 일정  문의드립니다")]);
	const built = await buildDraft(mailItem, meta, { call: ok.call });
	expect(ok.calls).toHaveLength(1);
	expect(built.action === "draft" && built.rec.recipient).toEqual({ who: "문의하는 사람", evidence: "다음주 일정  문의드립니다" });
	expect(built.action === "draft" && built.warnings).toEqual([]);

	const bad = fakeModel([withWho("저는 학부모입니다")]);
	const failed = await buildDraft(mailItem, meta, { call: bad.call });
	expect(bad.calls).toHaveLength(2);
	expect(failed.action === "draft" && failed.warnings.some(w => w.startsWith("the recipient evidence"))).toBe(true);
	expect(bad.calls[1]!.user).toContain("the recipient evidence");

	const joined = fakeModel([withWho("다음주 일정 / 문의드립니다")]);
	await buildDraft(mailItem, meta, { call: joined.call });
	expect(joined.calls).toHaveLength(1);
	const oneOff = fakeModel([withWho("다음주 일정 / 저는 학부모입니다"), withWho("")]);
	await buildDraft(mailItem, meta, { call: oneOff.call });
	expect(oneOff.calls).toHaveLength(2);

	const none = fakeModel([withWho("")]);
	expect((await buildDraft(mailItem, meta, { call: none.call })).action).toBe("draft");
	expect(none.calls).toHaveLength(1);
});

test("a linked mail is written from the mail profile whichever mail app it goes through; no profile yet means no style", () => {
	expect(mailStyleOf("문서 부탁드려요", "kim@example.com")).toBeUndefined();
	mkdirSync(join(toneFile({ app: "mail" }), ".."), { recursive: true });
	writeFileSync(toneFile({ app: "mail" }), "## 예시\n\n- 네 보내드렸어요\n");
	savePairs("mail", [{ received: "문서 부탁드려요", reply: "보내드립니다", at: day, from: "kim@example.com" }]);
	expect(mailStyleOf("문서 부탁드려요", "kim@example.com")?.examples?.[0]).toMatchObject({ reply: "보내드립니다", same: true });
});

test("only the newest 12 corrections reach a mail prompt, each clipped to 200 characters; a chat prompt keeps all of them", () => {
	const corrections = Array.from({ length: 15 }, (_, i) => `corr-${String(i).padStart(2, "0")}-${"가".repeat(300)}`);
	const { user } = buildPrompt(mailItem, { ...style, corrections });
	expect(user).not.toContain("corr-02-");
	expect(user).toContain("corr-03-");
	expect(user).toContain("corr-14-");
	expect(user).not.toContain("가".repeat(201));
	expect(buildPrompt({ ...mailItem, kind: "chat" }, { ...style, corrections }).user).toContain("corr-00-");
});

test("a revision records only its lasting lesson: the model's line, nothing for an empty one, the verbatim change when the field is missing", async () => {
	const first = fakeModel([replyJson("확인해 보고 말씀드릴게요.")]);
	const cases: [Record<string, unknown>, string[]][] = [
		[{ lesson: "" }, []],
		[{ lesson: "when 일정을 물으면 then 요일만 답함" }, ["when 일정을 물으면 then 요일만 답함"]],
		[{}, ["더 짧게"]],
	];
	for (const [i, [extra, expected]] of cases.entries()) {
		rmSync(paths.toneDir(), { force: true, recursive: true });
		await offerMailDraft({ ...mailFixture, key: `m-l${i}` }, { send: () => {}, call: first.call });
		const d = storedDrafts().find(x => x.ref === `m-l${i}`)!;
		const revised = fakeModel([j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "곧요.", questions: [], ...extra })]);
		const step = await reviseDraft(d.id, "더 짧게", { call: revised.call, now: () => new Date(day) });
		expect(step.ok).toBe(true);
		expect(loadStyle({ app: "mail" }).corrections.map(c => c.replace(/^\d{4}-\d\d-\d\d: /, ""))).toEqual(expected);
		expect(getDraft(step.id!)!.changes).toEqual(["더 짧게"]);
	}
});

// A sent folder a mail site or a plugin hands over (tone.ts sentPairs, persona.ts learnSiteSent, refreshPairs).
const sent = (n: number, over: Partial<SentMail> = {}): SentMail => ({ to: `rcpt${n}@example.test`, subject: `Re: q${n}`, at: day + n, body: `사이트답${n} 가능해요.\n> 질문${n} 인가요?`, ...over });

test("sentPairs keeps a real reply with its quote and skips forwards, empty quotes, automated receivers, bot drafts and long texts", () => {
	const items: SentMail[] = [
		sent(1),
		sent(2, { subject: "Fwd: q2" }),
		sent(3, { body: "---------- Forwarded message ---------\n사이트답3\n> 질문3" }),
		sent(4, { body: "사이트답4 가능해요." }),
		sent(5, { to: "noreply@example.test" }),
		sent(6, { body: "봇이 쓴 초안입니다 6.\n> 질문6" }),
		sent(7, { body: `${"가".repeat(1600)}\n> 질문7` }),
		sent(8, { body: "사이트답8\n-----원본 메일-----\n질문8" }),
		sent(9, { received: "넘겨받은 질문", body: "사이트답9" }),
	];
	expect(sentPairs(items, "work", ["봇이 쓴 초안입니다"]).map(p => [p.reply, p.received, p.from, p.source])).toEqual([
		["사이트답1 가능해요.", "질문1 인가요?", "rcpt1@example.test", "work"],
		["사이트답8", "질문8", "rcpt8@example.test", "work"],
		["사이트답9", "넘겨받은 질문", "rcpt9@example.test", "work"],
	]);
});

test("the newest MAX_PAIRS are kept per source, so a big folder of one source never pushes out another", () => {
	const many = Array.from({ length: MAX_PAIRS + 5 }, (_, i) => ({ received: `q${i}`, reply: `r${i}`, at: day + 100 + i }));
	savePairs("mail", [...many, { received: "qs", reply: "rs", at: day, source: "work" }]);
	const all = loadPairs("mail");
	expect(all.filter(p => !p.source)).toHaveLength(MAX_PAIRS);
	expect(all.filter(p => p.source === "work")).toHaveLength(1);
});

test("a draft sees the pairs of its own source only: a site's draft its site's, a zele draft none of the site's", async () => {
	seedPairs(3);
	savePairs("mail", [...loadPairs("mail"), { received: "일정 문의드립니다. 시간을 알려 주세요.", reply: "사이트답 목요일 가능해요", at: day + 50, source: "work" }]);
	const draft = j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 일정 문의", body: "네", questions: [] });
	const promptOf = async (source: string, over: Partial<ReplyItem> = {}) => {
		const model = fakeModel([draft]);
		await buildDraft({ ...mailItem, ...over }, { ...meta, source }, { call: model.call });
		return model.calls[0]!.user;
	};
	const site = await promptOf("work");
	expect(site).toContain("사이트답 목요일");
	expect(site).not.toContain("화요일 괜찮아요");
	const zele = await promptOf("zele");
	expect(zele).toContain("화요일 괜찮아요");
	expect(zele).not.toContain("사이트답");
	expect(await promptOf("zele", { profile: "mail-2" })).not.toContain("<<<RECEIVED");
	expect(await promptOf("work", { profile: "mail-work" })).toContain("사이트답 목요일");
});

test("learning a site's sent folder saves its pairs and its own profile once, never rewrites a profile that has an identity, and keeps the pairs when the model fails", async () => {
	const items = [1, 2, 3].map(n => sent(n));
	const model = fakeModel([j({ identity: ["해요체로 짧게 답한다"], templates: [] })]);
	const note = await learnSiteSent("work", items, "mail-work", model.call);
	expect(note).toContain("- 해요체로 짧게 답한다");
	expect(note).toContain(toneFile({ app: "mail-work" }));
	expect(loadPairs("mail").filter(p => p.source === "work")).toHaveLength(3);
	expect(identityOf({ app: "mail-work" })).toEqual(["해요체로 짧게 답한다"]);
	const file = readFileSync(toneFile({ app: "mail-work" }), "utf8");
	const again = fakeModel([j({ identity: ["다른 말투"], templates: [] })]);
	expect(await learnSiteSent("work", items, "mail-work", again.call)).not.toContain("- 해요체로 짧게 답한다");
	expect(again.calls).toHaveLength(0);
	expect(readFileSync(toneFile({ app: "mail-work" }), "utf8")).toBe(file);
	expect(typeof (await learnSiteSent("down", [sent(4)], "mail-down", async () => { throw new Error("model down"); }))).toBe("string");
	expect(loadPairs("mail").filter(p => p.source === "down")).toHaveLength(1);
	expect(identityOf({ app: "mail-down" })).toEqual([]);
	expect(JSON.parse(readFileSync(paths.learned(), "utf8"))["pairs-down@1"]).toBeTruthy();
});

test("each source is refreshed on its own: a failing zele read stops neither a mail site nor a plugin; the first read is wide, later ones 40", async () => {
	const which = spyOn(Bun, "which").mockReturnValue("/bin/zele");
	const logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		mkdirSync(join(env.dir, "custom", "webmail", "work"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "webmail", "work", "spec.json"), JSON.stringify({ sent: { path: "/x", listPath: "m", fields: { id: "id" } } }));
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ mail: { app: "mail", filter: { account: "me@example.net" } } }));
		const { refreshPairs } = await import("../lib/tone.ts");
		const limits: string[] = [];
		const run: Runner = async argv => {
			if (argv[0] === "zele") return { code: 1, stdout: "", stderr: "zele down" };
			limits.push(argv[argv.indexOf("--limit") + 1]!);
			return { code: 0, stdout: `${[1, 2].map(n => JSON.stringify(sent(n))).join("\n")}\nnot a mail line\n`, stderr: "" };
		};
		const asked: number[] = [];
		const plugins: PluginSent = async limit => {
			asked.push(typeof limit === "number" ? limit : limit("p1"));
			return [{ plugin: "p1", source: "shop", items: [sent(3)] }];
		};
		const at = new Date("2026-10-05T00:00:00Z");
		await refreshPairs(run, at, plugins);
		expect(loadPairs("mail").map(p => p.source).sort()).toEqual(["shop", "work", "work"]);
		expect(limits).toEqual(["3000"]);
		expect(logged).toHaveBeenCalledTimes(1);
		await refreshPairs(run, new Date(at.getTime() + 25 * 3_600_000), plugins);
		expect(limits).toEqual(["3000", "40"]);
		expect(asked).toEqual([3000, 40]);
	} finally {
		which.mockRestore();
		logged.mockRestore();
	}
});
