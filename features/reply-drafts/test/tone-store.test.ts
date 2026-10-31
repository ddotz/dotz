import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { messages, sqliteDb } from "../../../hub/kakao/db.ts";
import { makeFixtureDb, OWNER, ROOM } from "../../../hub/kakao/fixture.ts";
import { runDraft } from "../bin/draft.ts";
import { buildDraft, reviseDraft } from "../lib/flow.ts";
import { learnKakaoRoom, type OwnerReader } from "../lib/kakao-tone.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { readMailBody, sendWith } from "../lib/senders.ts";
import { loadStyle, paths, recordCorrection, roomFile, toneFile, writeExamples } from "../lib/settings.ts";
import { addDraft, getDraft } from "../lib/store.ts";
import { learnTone, zeleEnabled, type Runner } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	process.env.DOTZ_DIR = env.dir;
	for (const p of [paths.config(), paths.legacyStyle(), paths.toneDir(), paths.drafts(), paths.inbox(), join(env.dir, "custom", "sns")]) rmSync(p, { force: true, recursive: true });
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

test("rules, corrections and forbidden expressions merge from every level, install first", async () => {
	const levels = [
		["install", "install-rule", "install-ban"],
		[{ app: "kakao" }, "app-rule", "app-ban"],
		[{ app: "kakao", room: "r1" }, "room-rule", "room-ban"],
	] as const;
	for (const [key, rule, ban] of levels) await Bun.write(toneFile(key), `## 말투\n\n- ${rule}\n\n## 금지\n\n- ${ban}\n`);
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
	expect(readFileSync(toneFile({ app: "kakao", room: "r1" }), "utf8")).toContain("더 짧게 써 주세요");
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
	expect(readFileSync(toneFile({ app: "mail" }), "utf8")).toContain("존댓말로");
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
	expect(readFileSync(toneFile({ app: "kakao", room: "9" }), "utf8")).toContain("반말로");
	expect(existsSync(toneFile({ app: "kakao" }))).toBe(false);
});

test("a legacy style.md is read as the mail profile until tone/mail.md exists, and carried over by the next write", async () => {
	mkdirSync(join(env.dir, "custom", "reply-drafts"), { recursive: true });
	await Bun.write(paths.legacyStyle(), "## 말투\n\n- 짧게\n\n## 예시\n\n- 옛 문장이에요.\n");
	expect(loadStyle({ app: "mail" })).toMatchObject({ samples: ["옛 문장이에요."], rules: ["짧게"], samplesFrom: "app" });
	expect(loadStyle({ app: "kakao", room: "1" }).samples).toEqual([]);
	recordCorrection({ app: "mail" }, "정중하게", new Date("2030-01-02T00:00:00Z"));
	const md = readFileSync(toneFile({ app: "mail" }), "utf8");
	expect(md).toContain("옛 문장이에요.");
	expect(md).toContain("정중하게");
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
	const ok: Runner = async argv => (argvs.push(argv), { code: 0, stdout: "", stderr: "" });
	expect((await sendWith(rec, ok)).ok).toBe(true);
	expect(argvs).toEqual([["zele", "mail", "read", "t-9"], ["zele", "mail", "reply", "t-9", "--to", "kim@example.com", "--body", "곧 알려 드릴게요."]]);
	argvs.length = 0;
	const refuse: Runner = async argv => (argvs.push(argv), argv[2] === "reply" ? { code: 1, stdout: "", stderr: "newer message in thread" } : { code: 0, stdout: "", stderr: "" });
	const refused = await sendWith(rec, refuse);
	expect(refused.ok).toBe(false);
	expect(refused.message).toContain("newer message in thread");
	argvs.length = 0;
	const noRead: Runner = async argv => (argvs.push(argv), { code: 1, stdout: "", stderr: "not found" });
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
	expect(argvs[1]).toEqual(["zele", "mail", "read", "m1"]);
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

test("an offer that fails logs the error and still returns failed; a body that cannot be read is logged too", async () => {
	enable(env);
	const logged: string[] = [];
	const log = (line: string) => void logged.push(line);
	const mail = { ...mailFixture, body: undefined };
	const r = await offerMailDraft(mail, { send: () => Promise.reject(new Error("post failed")), call: fakeModel([j(goodReply)]).call, readBody: () => Promise.reject(new Error("zele down")), log });
	expect(r).toBe("failed");
	expect(logged.some(l => l.includes("zele down"))).toBe(true);
	expect(logged.some(l => l.includes("post failed") && l.includes(mailFixture.key))).toBe(true);
});

test("sent mail is read with zele only when the install's config turned zele on", () => {
	expect(zeleEnabled(undefined)).toBe(false);
	expect(zeleEnabled({})).toBe(false);
	expect(zeleEnabled({ zele: { enabled: false } })).toBe(false);
});
