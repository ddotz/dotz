import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { msg as catalog } from "../../../hub/i18n.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messages, sqliteDb } from "../../../hub/kakao/db.ts";
import { makeFixtureDb, OWNER, ROOM } from "../../../hub/kakao/fixture.ts";
import { runDraft } from "../bin/draft.ts";
import { buildDraft, reviseDraft } from "../lib/flow.ts";
import { learnKakaoRoom, type OwnerReader } from "../lib/kakao-tone.ts";
import { readLedger, type LedgerKind } from "../lib/ledger.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { readMailBody, sendWith } from "../lib/senders.ts";
import { HEADINGS, loadStyle, paths, profileBullets, recordCorrection, recordForbidden, recordLearned, recordRule, removeCorrection, removeForbidden, removeRule, roomFile, toneFile, writeExamples } from "../lib/settings.ts";
import { addDraft, getDraft, listDrafts } from "../lib/store.ts";
import { learnTone, zeleEnabled, type Runner } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, seedRules, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.config(), paths.ledger(), paths.legacyStyle(), paths.toneDir(), paths.drafts(), paths.inbox(), join(env.dir, "custom", "sns")]) rmSync(p, { force: true, recursive: true });
});

// Two rooms of the KakaoTalk fixture database: the user's lines (authorId OWNER) and the other side's.
const msg = (n: number, chatId: number, authorId: number, message: string, type = 1) => ({ logId: n, chatId, authorId, message, type, sentAt: 1_700_000_000 + n });
function fixtureReader(): OwnerReader & { reads: number } {
	const file = join(env.dir, "kakao.db");
	rmSync(file, { force: true });
	makeFixtureDb(file, {
		messages: [
			msg(1, ROOM.direct, 2001, "점심 같이 먹을래요?"),
			msg(2, ROOM.direct, OWNER, "좋아요! 열두 시에 봐요."),
			msg(3, ROOM.direct, OWNER, "사진은 나중에 보낼게요.", 2),
			msg(4, ROOM.direct, 2001, "그럼 거기서 만나요."),
			msg(5, ROOM.group, 2002, "회의 자료 확인 부탁드립니다."),
			msg(6, ROOM.group, OWNER, "네, 확인했습니다. 감사합니다."),
		],
	}).close();
	const db = sqliteDb(file);
	const r = { reads: 0, messages: async (chatId: string, limit: number) => (r.reads++, messages(db, chatId, limit, OWNER)) };
	return r;
}

const chatItem = (room: string) => ({ kind: "chat" as const, app: "kakao", room, from: room, text: "내일 볼까요?" });
const chatReply = j({ action: "draft", reason: "r", to: "x", body: "좋아요, 내일 봐요.", questions: [] });

test("the room profile wins when it has samples; a room without samples uses the app, an app without samples the install", () => {
	writeExamples("install", ["설치 전체 문장이에요."]);
	expect(loadStyle({ app: "kakao", room: "r1" })).toMatchObject({ samples: ["설치 전체 문장이에요."], samplesFrom: "install" });
	writeExamples({ app: "kakao" }, ["앱 전체 문장이에요."]);
	expect(loadStyle({ app: "kakao", room: "r1" })).toMatchObject({ samples: ["앱 전체 문장이에요."], samplesFrom: "app" });
	writeExamples({ app: "kakao", room: "r1" }, ["이 방 문장이에요."]);
	expect(loadStyle({ app: "kakao", room: "r1" })).toMatchObject({ samples: ["이 방 문장이에요."], samplesFrom: "room" });
	expect(loadStyle({ app: "kakao", room: "r2" })).toMatchObject({ samples: ["앱 전체 문장이에요."], samplesFrom: "app" });
	expect(loadStyle({ app: "mail" })).toMatchObject({ samples: ["설치 전체 문장이에요."], samplesFrom: "install" });
	rmSync(paths.toneDir(), { recursive: true, force: true });
	expect(loadStyle({ app: "kakao", room: "r1" })).toMatchObject({ samples: [], samplesFrom: "none" });
});

test("rules, corrections and forbidden expressions merge from every level, install first", () => {
	const levels = [
		["install", "install-rule", "install-ban"],
		[{ app: "kakao" }, "app-rule", "app-ban"],
		[{ app: "kakao", room: "r1" }, "room-rule", "room-ban"],
	] as const;
	for (const [key, rule, ban] of levels) seedRules(key, { tone: [rule], ban: [ban] });
	recordCorrection({ app: "kakao", room: "r1" }, "room change", new Date("2030-01-02T00:00:00Z"));
	const s = loadStyle({ app: "kakao", room: "r1" });
	expect(s.rules).toEqual(["install-rule", "app-rule", "room-rule"]);
	expect(s.forbidden).toEqual(["install-ban", "app-ban", "room-ban"]);
	expect(s.corrections).toEqual(["2030-01-02: room change"]);
	expect(loadStyle({ app: "kakao", room: "r2" }).rules).toEqual(["install-rule", "app-rule"]);
});

test("the store layout is install.md, <app>.md and <app>/<room>.md, with a filename-safe room id", () => {
	writeExamples("install", ["a 문장이에요."]);
	writeExamples({ app: "mail" }, ["b 문장이에요."]);
	writeExamples({ app: "kakao", room: "../../etc/x y" }, ["c 문장이에요."]);
	expect(roomFile("../../etc/x y")).toBe("______etc_x_y");
	expect(readdirSync(paths.toneDir()).sort()).toEqual(["install.md", "kakao", "mail.md"]);
	expect(readdirSync(join(paths.toneDir(), "kakao"))).toEqual(["______etc_x_y.md"]);
	expect(() => toneFile({ app: "Bad App" })).toThrow();
});

test("a correction on a room draft lands only in that room file and does not affect another room", async () => {
	enable(env);
	const model = fakeModel([chatReply]);
	const a = await buildDraft(chatItem("r1"), { source: "kakao", mailId: "r1", ref: "chat:r1" }, { call: model.call });
	const b = await buildDraft(chatItem("r2"), { source: "kakao", mailId: "r2", ref: "chat:r2" }, { call: model.call });
	if (a.action !== "draft" || b.action !== "draft") throw new Error("expected drafts");
	addDraft(a.rec);
	addDraft(b.rec);
	expect(a.rec).toMatchObject({ app: "kakao", room: "r1" });
	expect((await reviseDraft(a.rec.id, "더 짧게 써 주세요", { call: model.call })).ok).toBe(true);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections).join("\n")).toContain("더 짧게 써 주세요");
	expect(readLedger().filter(r => r.kind === "correction").map(r => r.scope)).toEqual([{ app: "kakao", room: "r1" }]);
	expect(existsSync(toneFile({ app: "kakao", room: "r2" }))).toBe(false);
	expect(existsSync(toneFile({ app: "kakao" }))).toBe(false);
	expect(existsSync(toneFile({ app: "mail" }))).toBe(false);
	expect(loadStyle({ app: "kakao", room: "r2" }).corrections).toEqual([]);
	expect(getDraft(b.rec.id)!.status).toBe("pending");
	// A draft without a room corrects its app profile.
	const mail = await buildDraft({ kind: "mail", app: "mail", from: "kim@example.com", subject: "문의", text: "질문이에요" }, { source: "zele", mailId: "m1", ref: "m1" }, { call: fakeModel([j(goodReply)]).call });
	if (mail.action !== "draft") throw new Error("expected a draft");
	addDraft(mail.rec);
	await reviseDraft(mail.rec.id, "존댓말로", { call: fakeModel([j(goodReply)]).call });
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections).join("\n")).toContain("존댓말로");
});

test("the kakao source learns only the user's own text lines of that one room", async () => {
	const r = await learnKakaoRoom(String(ROOM.direct), fixtureReader());
	expect(r.examples).toEqual(["좋아요!", "열두 시에 봐요."]);
	expect(loadStyle({ app: "kakao", room: String(ROOM.direct) })).toMatchObject({ samples: r.examples, samplesFrom: "room" });
	const md = readFileSync(toneFile({ app: "kakao", room: String(ROOM.direct) }), "utf8");
	for (const other of ["점심", "만나요", "확인했습니다", "사진은"]) expect(md).not.toContain(other);
	expect(existsSync(toneFile({ app: "kakao" }))).toBe(false);
});

test("two kakao rooms keep separate tones, and the first draft of an empty room learns it once", async () => {
	enable(env);
	const reader = fixtureReader();
	const model = fakeModel([chatReply]);
	const run = (room: number) => runDraft(["new", "--app", "kakao", "--room", String(room), "--kind", "chat"], "내일 볼까요?", { call: model.call, kakaoReader: async () => reader });
	expect(await run(ROOM.direct)).toMatchObject({ code: 0, lines: ["좋아요, 내일 봐요."] });
	expect(reader.reads).toBe(1);
	const prompt = (i: number) => `${model.calls[i]!.system}\n${model.calls[i]!.user}`;
	expect(prompt(0)).toContain("열두 시에 봐요.");
	expect(prompt(0)).not.toContain("확인했습니다");
	await run(ROOM.direct);
	expect(reader.reads).toBe(1);
	await run(ROOM.group);
	expect(reader.reads).toBe(2);
	expect(prompt(2)).toContain("확인했습니다.");
	expect(prompt(2)).not.toContain("열두 시에 봐요.");
	expect(readdirSync(join(paths.toneDir(), "kakao")).sort()).toEqual(["101.md", "102.md"]);
});

test("draft.ts new --kind chat: an unreadable room still drafts with a note, a skip exits 3, off keeps today's behaviour, correct writes into the room", async () => {
	const model = fakeModel([chatReply]);
	const args = ["new", "--app", "kakao", "--room", "9", "--kind", "chat"];
	enable(env, { enabled: false });
	expect((await runDraft(args, "안녕", { call: model.call })).code).toBe(1);
	enable(env);
	const broken = await runDraft(args, "안녕", { call: model.call, kakaoReader: async () => Promise.reject(new Error("앱 없음")) });
	expect(broken.code).toBe(0);
	expect(broken.lines).toEqual(["좋아요, 내일 봐요."]);
	expect(broken.notes!.join("\n")).toContain("앱 없음");
	const skipped = await runDraft(args, "고마워요", { call: fakeModel([j({ action: "skip", reason: "thanks" })]).call, kakaoReader: async () => Promise.reject(new Error("x")) });
	expect(skipped.code).toBe(3);
	expect((await runDraft(["new", "--kind", "chat", "--room", "9"], "안녕", { call: model.call })).code).toBe(2);
	expect((await runDraft(["correct", "--app", "kakao", "--room", "9", "--change", "반말로"], "")).code).toBe(0);
	expect(profileBullets({ app: "kakao", room: "9" }, HEADINGS.corrections).join("\n")).toContain("반말로");
	expect(profileBullets({ app: "kakao" }, HEADINGS.corrections)).toEqual([]);
});

test("a legacy style.md is read as the mail profile until tone/mail.md exists, and carried over by the next write", async () => {
	mkdirSync(join(env.dir, "custom", "reply-drafts"), { recursive: true });
	await Bun.write(paths.legacyStyle(), "## 말투\n\n- 짧게\n\n## 예시\n\n- 옛 문장이에요.\n");
	expect(loadStyle({ app: "mail" })).toMatchObject({ samples: ["옛 문장이에요."], rules: ["짧게"], samplesFrom: "app" });
	expect(loadStyle({ app: "kakao", room: "1" }).samples).toEqual([]);
	recordCorrection({ app: "mail" }, "정중하게", new Date("2030-01-02T00:00:00Z"));
	expect(loadStyle({ app: "mail" })).toMatchObject({ rules: ["짧게"], corrections: ["2030-01-02: 정중하게"] });
	expect(existsSync(toneFile({ app: "mail" }))).toBe(false);
	writeExamples({ app: "mail" }, ["옛 문장이에요."]);
	const md = readFileSync(toneFile({ app: "mail" }), "utf8");
	expect(md).toContain("옛 문장이에요.");
	expect(md).toContain("짧게");
	await Bun.write(paths.legacyStyle(), "## 예시\n\n- 바뀐 옛 문장이에요.\n");
	expect(loadStyle({ app: "mail" }).samples).toEqual(["옛 문장이에요."]);
});

test("youtube/instagram: the app profile wins over the sns tone examples", async () => {
	await Bun.write(join(env.dir, "custom", "sns", "tone.md"), "## 예시\n\n- 고마워요!\n");
	expect(loadStyle({ app: "youtube" }).samplesFrom).toBe("legacy");
	writeExamples({ app: "youtube" }, ["유튜브 문장이에요."]);
	expect(loadStyle({ app: "youtube" })).toMatchObject({ samples: ["유튜브 문장이에요."], samplesFrom: "app" });
	expect(loadStyle({ app: "instagram" }).samplesFrom).toBe("legacy");
});

test("zele send: read first, then reply with --to and --body; a refusal is reported as a stale draft; a failed read sends nothing", async () => {
	const rec = { id: "R1", kind: "mail", app: "mail", source: "zele", mailId: "t-9", ref: "k", to: "kim@example.com", body: "곧 알려 드릴게요.", status: "pending", created: "", changes: [], questions: [], item: { kind: "mail", from: "kim@example.com", text: "" } } as const;
	const argvs: string[][] = [];
	const ok: Runner = async argv => (argv[1] === "whoami" || argvs.push(argv), { code: 0, stdout: "", stderr: "" });
	expect((await sendWith(rec, ok)).ok).toBe(true);
	expect(argvs).toEqual([["zele", "mail", "read", "t-9"], ["zele", "mail", "reply", "t-9", "--to", "kim@example.com", "--body", "곧 알려 드릴게요."]]);
	argvs.length = 0;
	const refuse: Runner = async argv => (argvs.push(argv), argv[2] === "reply" ? { code: 1, stdout: "", stderr: "newer message in thread" } : { code: 0, stdout: "", stderr: "" });
	const refused = await sendWith(rec, refuse);
	expect(refused.ok).toBe(false);
	expect(refused.message).toContain(catalog().sendFail.other);
	expect(refused.message).not.toContain("newer message in thread");
	argvs.length = 0;
	const noRead: Runner = async argv => (argv[1] === "whoami" ? { code: 0, stdout: "", stderr: "" } : (argvs.push(argv), { code: 1, stdout: "", stderr: "not found" }));
	expect((await sendWith(rec, noRead)).ok).toBe(false);
	expect(argvs).toHaveLength(1);
});

test("sent mail is listed with --folder sent then read by id; readMailBody reads zele and webmail sources only", async () => {
	const argvs: string[][] = [];
	const run: Runner = async argv => {
		argvs.push(argv);
		return argv[2] === "list" ? { code: 0, stdout: "items:\n  - id: m1\n    snippet: s\n", stderr: "" } : { code: 0, stdout: "확인했어요. 내일 연락드릴게요.", stderr: "" };
	};
	await learnTone({ app: "mail" }, { run, zeleOn: true });
	expect(argvs[0]).toEqual(["zele", "mail", "list", "--folder", "sent", "--limit", "200"]);
	expect(argvs.slice(1)).toEqual([["zele", "whoami"], ["zele", "mail", "read", "m1"]]);
	argvs.length = 0;
	expect(await readMailBody("zele", "m1", run)).toContain("확인했어요");
	expect(argvs).toEqual([["zele", "mail", "read", "m1"]]);
	argvs.length = 0;
	await readMailBody("webmail:work", "w1", run);
	expect([argvs[0]![0], ...argvs[0]!.slice(-3)]).toEqual(["bun", "work", "read", "w1"]);
	argvs.length = 0;
	expect(await readMailBody("manual", "x", run)).toBeUndefined();
	expect(argvs).toEqual([]);
	expect(await readMailBody("zele", "m1", async () => ({ code: 1, stdout: "", stderr: "" }))).toBeUndefined();
});

test("an offer whose card post fails logs the error and keeps the stored draft; a body that cannot be read is logged too", async () => {
	enable(env);
	const logged: string[] = [];
	const log = (line: string) => void logged.push(line);
	const mail = { ...mailFixture, body: undefined };
	const r = await offerMailDraft(mail, { send: () => Promise.reject(new Error("post failed")), call: fakeModel([j(goodReply)]).call, readBody: () => Promise.reject(new Error("zele down")), log });
	expect(r).toBe("offered");
	expect(listDrafts().map(d => [d.ref, d.status])).toEqual([[mailFixture.key, "pending"]]);
	expect(logged.some(l => l.includes("zele down"))).toBe(true);
	expect(logged.some(l => l.includes("post failed") && l.includes(mailFixture.key))).toBe(true);
});

test("an offer reads the whole thread before the snippet: the sender's newest message is the text, earlier ones and the sender's history reach the prompt", async () => {
	enable(env);
	const rule = "─".repeat(40);
	const thread = ["Subject: s", rule, "From: Pat <pat@example.com>", "Date: Oct 1", "", "First question from Pat", rule, "From: me@example.net", "Date: Oct 2", "", "My earlier answer", rule, "From: Pat <pat@example.com>", "Date: Oct 3", "", "Second question\n-- \nPat, Example Org\n> quoted"].join("\n");
	const seen: string[][] = [];
	const model = fakeModel([j(goodReply)]);
	const mail = { ...mailFixture, from: "Pat <pat@example.com>", to: "me@example.net", body: "short snippet" };
	await offerMailDraft(mail, { send: () => undefined, call: model.call, readBody: async () => thread, history: async (a, account, t) => (seen.push([a, String(account), String(t)]), ["10/1 Hello: a line"]), own: () => ["me@example.net"], log: () => {} });
	const user = model.calls.find(c => c.user.includes("Second question"))?.user ?? "";
	expect(user).toContain("Pat, Example Org");
	expect(user).not.toContain("short snippet");
	expect(user).toContain("My earlier answer");
	expect(user).toContain("10/1 Hello: a line");
	expect(seen).toEqual([["pat@example.com", "undefined", mailFixture.id]]);
});

test("a read with no text of its own (html only) leaves the poster's body, not the subject", async () => {
	enable(env);
	const read = ["Subject: s", "─".repeat(40), "From: Pat <pat@example.com>", "Date: Oct 1", ""].join("\n");
	const model = fakeModel([j(goodReply)]);
	await offerMailDraft({ ...mailFixture, from: "Pat <pat@example.com>", body: "posted snippet" }, { send: () => undefined, call: model.call, readBody: async () => read, log: () => {} });
	expect(model.calls.some(c => c.user.includes("posted snippet"))).toBe(true);
});

test("a category source reads its thread by the id without the count, and only with an account", async () => {
	const argvs: string[][] = [];
	const run: Runner = async argv => (argvs.push(argv), { code: 0, stdout: "text", stderr: "" });
	expect(await readMailBody("manual", "T9.3", run)).toBeUndefined();
	const which = spyOn(Bun, "which").mockReturnValue("/bin/zele");
	try {
		await readMailBody("manual", "T9.3", run, "me@example.net");
	} finally {
		which.mockRestore();
	}
	expect(argvs).toEqual([["zele", "mail", "read", "T9", "--account", "me@example.net"]]);
});

test("a webmail watch's posted body is used as it is, without reading the site again", async () => {
	enable(env);
	mkdirSync(join(env.dir, "custom", "webmail", "site-a"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "webmail", "site-a", "spec.json"), "{}");
	let reads = 0;
	const model = fakeModel([j(goodReply)]);
	await offerMailDraft({ ...mailFixture, source: "site-a", body: "posted whole mail" }, { send: () => undefined, call: model.call, readBody: async () => (reads++, "read again"), log: () => {} });
	expect(reads).toBe(0);
	expect(model.calls.some(c => c.user.includes("posted whole mail"))).toBe(true);
});

test("sent mail is read with zele only when the install's config turned zele on", () => {
	expect(zeleEnabled(undefined)).toBe(false);
	expect(zeleEnabled({})).toBe(false);
	expect(zeleEnabled({ zele: { enabled: false } })).toBe(false);
});

test("a section the code does not know reaches the rules, after the known rule sections, at every level", () => {
	mkdirSync(join(paths.toneDir(), "mail"), { recursive: true });
	seedRules("install", { tone: ["존댓말"] });
	seedRules({ app: "mail" }, { tone: ["짧게"] });
	writeFileSync(toneFile("install"), "## 설치 메모\n\n- 설치 줄\n");
	writeFileSync(toneFile({ app: "mail" }), "## 보낸 사람 신분별\n\n- 학부모에게는 선생님 호칭\n");
	expect(loadStyle({ app: "mail" }).rules).toEqual(["존댓말", "짧게", "설치 줄", "학부모에게는 선생님 호칭"]);
});

test("recordForbidden stores a wording once in that profile's 금지, merged with the install level; removeForbidden takes it out once", () => {
	mkdirSync(paths.toneDir(), { recursive: true });
	seedRules("install", { ban: ["install-ban"] });
	seedRules({ app: "youtube" }, { tone: ["짧게"], correction: ["2030-01-01: 존댓말로"] });
	recordForbidden({ app: "youtube" }, ["행복한 하루 되세요"]);
	recordForbidden({ app: "youtube" }, [" 행복한 하루 되세요 ", "Thanks"]);
	recordForbidden({ app: "youtube" }, ["thanks"]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.forbidden)).toEqual(["행복한 하루 되세요", "Thanks"]);
	const s = loadStyle({ app: "youtube" });
	expect(s.forbidden).toEqual(["install-ban", "행복한 하루 되세요", "Thanks"]);
	expect(s.rules).toEqual(["짧게"]);
	expect(s.corrections).toEqual(["2030-01-01: 존댓말로"]);
	expect(removeForbidden({ app: "youtube" }, " THANKS")).toBe(true);
	expect(removeForbidden({ app: "youtube" }, "thanks")).toBe(false);
	expect(loadStyle({ app: "youtube" }).forbidden).toEqual(["install-ban", "행복한 하루 되세요"]);
	expect(removeForbidden("install", "없는 말")).toBe(false);
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual(["install-ban"]);
	expect(readLedger().filter(r => r.state === "off").map(r => r.text)).toEqual(["Thanks"]);
});

test("recordRule stores a standing rule once, undated, in that profile's 말투 and leaves the other sections alone; removeRule returns what it took out", () => {
	mkdirSync(paths.toneDir(), { recursive: true });
	seedRules("install", { correction: ["2030-01-01: 존댓말로"] });
	recordRule("install", "  끝인사는   짧게 한다 ");
	recordRule("install", "끝인사는 짧게 한다");
	recordRule("install", "끝인사는 짧게 한다".toUpperCase());
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["끝인사는 짧게 한다"]);
	expect(profileBullets("install", HEADINGS.corrections)).toEqual(["2030-01-01: 존댓말로"]);
	expect(removeRule("install", "짧게")).toEqual(["끝인사는 짧게 한다"]);
	expect(removeRule("install", "짧게")).toEqual([]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual([]);
	expect(profileBullets("install", HEADINGS.corrections)).toEqual(["2030-01-01: 존댓말로"]);
});

test("recordLearned keeps a line of the install key as a standing rule and any other key's as a dated correction of that profile", () => {
	const at = new Date("2030-02-03T00:00:00Z");
	expect(recordLearned({ app: "install" }, "어디서나 존댓말", at)).toBe("rule");
	expect(recordLearned({ app: "kakao", room: "r1" }, "이 방은 반말", at)).toBe("correction");
	expect([profileBullets("install", HEADINGS.rules), profileBullets("install", HEADINGS.corrections)]).toEqual([["어디서나 존댓말"], []]);
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections)).toEqual(["2030-02-03: 이 방은 반말"]);
});

test("standing holds the 말투 lines of install, app and room and the hand-added sections, install first, without the learned voice notes", () => {
	mkdirSync(join(paths.toneDir(), "kakao"), { recursive: true });
	seedRules("install", { tone: ["어디서나 존댓말"] });
	seedRules({ app: "kakao", room: "r1" }, { tone: ["이모지 없이"] });
	writeFileSync(toneFile("install"), "## 학습한 말투\n\n- 설치 측정\n");
	writeFileSync(toneFile({ app: "kakao" }), "## 학습한 말투\n\n- 짧게 끊어 쓴다\n\n## 호칭\n\n- 형이라고 부른다\n");
	writeFileSync(toneFile({ app: "kakao", room: "r1" }), "## 대화 이해\n\n- 동아리 방\n");
	const s = loadStyle({ app: "kakao", room: "r1" });
	expect(s.standing).toEqual(["어디서나 존댓말", "이모지 없이", "형이라고 부른다"]);
	expect(s.rules).toEqual([...s.standing, "설치 측정", "짧게 끊어 쓴다", "동아리 방"]);
});

test("a writer adds one record to the ledger in order and leaves the owner's hand-written file byte for byte as it was", () => {
	mkdirSync(paths.toneDir(), { recursive: true });
	const mailMd = "## 금지\n이 줄은 손으로 쓴 설명.\n\n- 가가\n\n## 말투\n- r\n";
	const youtubeMd = "## 말투\n설명만 있다.\n";
	writeFileSync(toneFile({ app: "mail" }), mailMd);
	recordForbidden({ app: "mail" }, ["나나"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.forbidden)).toEqual(["나나"]);
	expect(loadStyle({ app: "mail" }).forbidden).toEqual(["나나", "가가"]);
	expect(readFileSync(toneFile({ app: "mail" }), "utf8")).toBe(mailMd);
	writeFileSync(toneFile({ app: "youtube" }), youtubeMd);
	recordRule({ app: "youtube" }, "짧게");
	recordForbidden({ app: "youtube" }, ["되세요"]);
	expect([profileBullets({ app: "youtube" }, HEADINGS.rules), profileBullets({ app: "youtube" }, HEADINGS.forbidden)]).toEqual([["짧게"], ["되세요"]]);
	expect(removeRule({ app: "youtube" }, "짧게")).toEqual(["짧게"]);
	expect(profileBullets({ app: "youtube" }, HEADINGS.rules)).toEqual([]);
	expect(readLedger().filter(r => r.state === "off").map(r => r.text)).toEqual(["짧게"]);
	expect(readFileSync(toneFile({ app: "youtube" }), "utf8")).toBe(youtubeMd);
});

const SHAPES: { name: string; md: (h: string, b: string) => string; together?: string }[] = [
	{ name: "prose before bullets", md: (h, b) => `# 손으로 쓴 제목\n\n${h}\n이 줄은 손으로 쓴 설명.\n\n- 가가\n${b}\n\n## 기타\n- 다른\n` },
	{ name: "prose after bullets", md: (h, b) => `${h}\n\n- 가가\n${b}\n\n뒤에 붙인 설명 문단.\n\n## 기타\n메모\n` },
	{ name: "numbered lines", md: (h, b) => `${h}\n\n1. 첫째 손 규칙\n2. 둘째 손 규칙\n${b}\n- 가가\n` },
	{ name: "wrapped bullet continuation", md: (h, b) => `${h}\n\n${b}\n- 가가 길게 쓴 줄이\n  다음 줄로 이어진다\n\n## 기타\n- 다른\n`, together: "- 가가 길게 쓴 줄이\n  다음 줄로 이어진다" },
	{ name: "CRLF file", md: (h, b) => `# 제목\r\n\r\n${h}\r\n설명 줄\r\n\r\n- 가가\r\n${b}\r\n\r\n## 기타\r\n- 다른\r\n` },
	{ name: "section last without a trailing newline", md: (h, b) => `## 기타\n- 다른\n\n${h}\n설명\n- 가가\n${b}` },
];
const GONE = "지울 말";
const KIND_OF: Record<string, LedgerKind> = { [HEADINGS.forbidden]: "ban", [HEADINGS.rules]: "tone", [HEADINGS.corrections]: "correction" };
const WRITERS: { name: string; heading: string; run: () => unknown; adds?: string }[] = [
	{ name: "recordForbidden", heading: HEADINGS.forbidden, run: () => recordForbidden({ app: "mail" }, ["새 표현"]), adds: "새 표현" },
	{ name: "removeForbidden", heading: HEADINGS.forbidden, run: () => removeForbidden({ app: "mail" }, GONE) },
	{ name: "recordRule", heading: HEADINGS.rules, run: () => recordRule({ app: "mail" }, "새 규칙"), adds: "새 규칙" },
	{ name: "removeRule", heading: HEADINGS.rules, run: () => removeRule({ app: "mail" }, "지울") },
	{ name: "recordCorrection", heading: HEADINGS.corrections, run: () => recordCorrection({ app: "mail" }, "새 고친 점", new Date("2030-05-06T00:00:00Z")), adds: "2030-05-06: 새 고친 점" },
	{ name: "removeCorrection", heading: HEADINGS.corrections, run: () => removeCorrection({ app: "mail" }, "지울") },
];
test("every writer changes the ledger and leaves a hand-written file byte for byte as it was, whatever the section's shape", () => {
	for (const shape of SHAPES) {
		for (const w of WRITERS) {
			rmSync(paths.toneDir(), { force: true, recursive: true });
			rmSync(paths.ledger(), { force: true });
			mkdirSync(paths.toneDir(), { recursive: true });
			const before = shape.md(w.heading, `- ${GONE}`);
			writeFileSync(toneFile({ app: "mail" }), before);
			seedRules({ app: "mail" }, { [KIND_OF[w.heading]!]: [GONE] });
			w.run();
			const label = `${w.name} / ${shape.name}`;
			expect({ label, file: readFileSync(toneFile({ app: "mail" }), "utf8") === before }).toEqual({ label, file: true });
			const bullets = profileBullets({ app: "mail" }, w.heading);
			if (w.adds) expect({ label, bullets }).toEqual({ label, bullets: [GONE, w.adds] });
			else expect({ label, bullets, off: readLedger().filter(r => r.state === "off").map(r => r.text) }).toEqual({ label, bullets: [], off: [GONE] });
		}
	}
});

const correct = (...args: string[]) => runDraft(["correct", ...args], "", { now: () => new Date("2030-03-04T00:00:00Z") });

test("a stored value is one line: a newline in a ban, a rule or a correction can add no line and no heading to the file", async () => {
	const forged = "ok\n## 말투\n- 가짜 규칙";
	const r = await correct("--app", "mail", "--forbid", forged);
	expect(r.code).toBe(0);
	expect(r.lines.join("\n")).toContain('"ok ## 말투 - 가짜 규칙"');
	recordRule({ app: "mail" }, "규칙\n## 고친 점\n- 가짜 고친 점");
	recordCorrection({ app: "mail" }, "고침\n## 금지\n- 가짜 금지", new Date("2030-01-01T00:00:00Z"));
	recordForbidden({ app: "mail" }, ["둘째\r\n## 정체성\n- 가짜 신분"]);
	expect(existsSync(toneFile({ app: "mail" }))).toBe(false);
	expect(readLedger().map(r => [r.kind, r.text])).toEqual([
		["ban", "ok ## 말투 - 가짜 규칙"],
		["tone", "규칙 ## 고친 점 - 가짜 고친 점"],
		["correction", "2030-01-01: 고침 ## 금지 - 가짜 금지"],
		["ban", "둘째 ## 정체성 - 가짜 신분"],
	]);
	const s = loadStyle({ app: "mail" });
	expect(s.forbidden).toEqual(["ok ## 말투 - 가짜 규칙", "둘째 ## 정체성 - 가짜 신분"]);
	expect(s.rules).toEqual(["규칙 ## 고친 점 - 가짜 고친 점"]);
	expect(s.corrections).toEqual(["2030-01-01: 고침 ## 금지 - 가짜 금지"]);
	expect(s.identity).toEqual([]);
	expect((await correct("--app", "mail", "--forbid", "가\n\n")).code).toBe(1);
	expect((await correct("--app", "mail", "--forbid", `${"가".repeat(20)}\n\n\n${"나".repeat(20)}`)).code).toBe(1);
	expect((await correct("--app", "mail", "--forbid", `${"가".repeat(19)}\n\n\n${"나".repeat(20)}`)).code).toBe(0);
	expect(readLedger().every(r => !/[\r\n]/.test(r.text))).toBe(true);
});

test("correct --forbid stores a wording once at install level, --allow takes it back", async () => {
	const first = await correct("--app", "install", "--forbid", "되세요");
	expect(first).toMatchObject({ code: 0 });
	expect(first.lines.join("\n")).toContain("모든 답장");
	expect(loadStyle({ app: "youtube" }).forbidden).toEqual(["되세요"]);
	await correct("--app", "install", "--forbid", "되세요", "--forbid", " 되세요 ");
	expect(profileBullets("install", HEADINGS.forbidden)).toEqual(["되세요"]);
	const gone = await correct("--app", "install", "--allow", "되세요");
	expect(gone.code).toBe(0);
	expect(loadStyle({ app: "youtube" }).forbidden).toEqual([]);
	const none = await correct("--app", "install", "--allow", "되세요");
	expect(none).toMatchObject({ code: 0 });
	expect(none.lines.join("\n")).toContain("없어서");
});

test("correct refuses a one-character wording and a /regex/ and writes nothing", async () => {
	for (const bad of ["a", " 요 ", "/되세요/", "/x+/i", "가".repeat(41)]) {
		const r = await correct("--app", "youtube", "--change", "존댓말로", "--forbid", "좋은말", "--forbid", bad);
		expect(r.code).toBe(1);
	}
	expect(existsSync(paths.toneDir())).toBe(false);
});

test("correct --forget removes the matching correction lines of that profile only and prints them", async () => {
	recordCorrection({ app: "youtube" }, "즐거운 하루 되세요는 비문", new Date("2030-01-01T00:00:00Z"));
	recordCorrection({ app: "youtube" }, "이모지 쓰지 마", new Date("2030-01-02T00:00:00Z"));
	recordCorrection({ app: "instagram" }, "하루 되세요 얘기 금지", new Date("2030-01-03T00:00:00Z"));
	const r = await correct("--app", "youtube", "--forget", "되세요");
	expect(r.code).toBe(0);
	expect(r.lines.join("\n")).toContain("2030-01-01: 즐거운 하루 되세요는 비문");
	expect(profileBullets({ app: "youtube" }, HEADINGS.corrections)).toEqual(["2030-01-02: 이모지 쓰지 마"]);
	expect(profileBullets({ app: "instagram" }, HEADINGS.corrections)).toHaveLength(1);
	const miss = await correct("--app", "youtube", "--forget", "없는 말");
	expect(miss.code).toBe(0);
	expect(miss.lines.join("\n")).toContain("없어서");
});

test("correct --change alone still records a dated line in the room profile", async () => {
	const r = await correct("--app", "kakao", "--room", "r1", "--change", "반말로");
	expect(r.code).toBe(0);
	expect(r.lines.join("\n")).toContain('기억했어요: "반말로" · 범위: 이 대화방');
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.corrections)).toEqual(["2030-03-04: 반말로"]);
});

test("correct needs one of the four and exits 2 with the usage; install takes no room", async () => {
	for (const args of [["--app", "youtube"], ["--app", "youtube", "--room", "r"], ["--change", "x"], ["--app", "install", "--room", "r", "--forbid", "되세요"]]) {
		expect((await correct(...args)).code).toBe(2);
	}
	expect((await correct("--app", "youtube")).lines[0]).toContain("usage:");
	expect(existsSync(paths.toneDir())).toBe(false);
});

test("correct --rule stores a standing rule at the chosen level, tone lists it under 말투, and --forget takes it out naming its section", async () => {
	const r = await correct("--app", "install", "--rule", "끝인사는 짧게", "--rule", "이모지는 쓰지 않는다");
	expect(r.code).toBe(0);
	expect(r.lines.join("\n")).toContain("모든 답장");
	await correct("--app", "install", "--rule", " 끝인사는  짧게 ");
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["끝인사는 짧게", "이모지는 쓰지 않는다"]);
	expect(profileBullets("install", HEADINGS.corrections)).toEqual([]);
	await correct("--app", "kakao", "--room", "r1", "--rule", "이 방은 반말");
	expect(profileBullets({ app: "kakao", room: "r1" }, HEADINGS.rules)).toEqual(["이 방은 반말"]);
	const tone = (await runDraft(["tone", "--app", "youtube"], "")).lines.join("\n");
	expect(tone.slice(tone.indexOf("말투:"), tone.indexOf("고친 점:"))).toContain("- [install] 끝인사는 짧게");
	await correct("--app", "install", "--change", "끝인사 다시 보기");
	expect(profileBullets("install", HEADINGS.rules)).toContain("끝인사 다시 보기");
	removeRule("install", "끝인사 다시 보기");
	recordCorrection({ app: "install" }, "끝인사 다시 보기", new Date("2030-03-04T00:00:00Z"));
	const gone = await correct("--app", "install", "--forget", "끝인사");
	expect(gone.code).toBe(0);
	const said = gone.lines.join("\n");
	expect(said).toContain("[말투] 끝인사는 짧게");
	expect(said).toContain("[고친 점] 2030-03-04: 끝인사 다시 보기");
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["이모지는 쓰지 않는다"]);
	expect(profileBullets("install", HEADINGS.corrections)).toEqual([]);
});

test("tone lists the bullets of hand-added sections as standing rules with level and section name; --forget leaves them and says which file holds the line", async () => {
	mkdirSync(paths.toneDir(), { recursive: true });
	seedRules("install", { tone: ["어디서나 존댓말"] });
	writeFileSync(toneFile("install"), "## 보낸 사람 신분별\n\n- 팀장에게는 존댓말\n");
	writeFileSync(toneFile({ app: "mail" }), "## 호칭\n\n- 학부모에게는 선생님 호칭\n");
	const tone = (await runDraft(["tone", "--app", "mail"], "")).lines.join("\n");
	const standing = tone.slice(tone.indexOf("말투:"), tone.indexOf("고친 점:"));
	expect(standing).toContain("- [install] 어디서나 존댓말");
	expect(standing).toContain("- [install] (보낸 사람 신분별) 팀장에게는 존댓말");
	expect(standing).toContain("- [app] (호칭) 학부모에게는 선생님 호칭");
	const before = readFileSync(toneFile("install"), "utf8");
	const r = await correct("--app", "install", "--forget", "팀장");
	expect(r.code).toBe(0);
	const said = r.lines.join("\n");
	expect(said).toContain("보낸 사람 신분별");
	expect(said).toContain(toneFile("install"));
	expect(said).toContain("팀장에게는 존댓말");
	expect(readFileSync(toneFile("install"), "utf8")).toBe(before);
	const miss = await correct("--app", "install", "--forget", "없는 말");
	expect(miss.lines.join("\n")).not.toContain(toneFile("install"));
});

test("--forget finds a line however its text or the owner's text is spaced, and echoes on one line", async () => {
	mkdirSync(paths.toneDir(), { recursive: true });
	seedRules({ app: "mail" }, { tone: ["끝인사는  두 줄로", "이모지 없이"] });
	writeFileSync(toneFile({ app: "mail" }), "## 호칭\n\n- 학부모에게는\t선생님 호칭\n");
	const hand = await correct("--app", "mail", "--forget", "학부모에게는 선생님");
	expect(hand.lines.join("\n")).toContain(toneFile({ app: "mail" }));
	const gone = await correct("--app", "mail", "--forget", "끝인사는 두\n줄로");
	expect(gone.lines.join("\n")).toContain("[말투] 끝인사는 두 줄로");
	expect(profileBullets({ app: "mail" }, HEADINGS.rules)).toEqual(["이모지 없이"]);
	const miss = await correct("--app", "mail", "--forget", "없는\n말", "--change", "두 줄\n메모");
	expect(miss.lines.every(l => !l.includes("\n"))).toBe(true);
});

test("tone lists each line with the level it comes from and writes nothing", async () => {
	await correct("--app", "install", "--forbid", "되세요");
	await correct("--app", "youtube", "--change", "이모지 쓰지 마");
	await correct("--app", "youtube", "--room", "c1", "--change", "방 전용");
	const before = JSON.stringify(readLedger());
	const r = await runDraft(["tone", "--app", "youtube"], "");
	expect(r.code).toBe(0);
	const text = r.lines.join("\n");
	expect(text).toContain("- [install] 되세요");
	expect(text).toContain("- [app] 내용: 이모지 쓰지 마");
	expect(text).not.toContain("방 전용");
	expect(text.indexOf("고친 점:")).toBeLessThan(text.indexOf("금지:"));
	expect((await runDraft(["tone", "--app", "youtube", "--room", "c1"], "")).lines.join("\n")).toContain("- [room] 2030-03-04: 방 전용");
	expect((await runDraft(["tone"], "")).code).toBe(2);
	expect(JSON.stringify(readLedger())).toBe(before);
	expect(existsSync(paths.toneDir())).toBe(false);
});
