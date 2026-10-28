// The writer identity (owner 2026-10-23): the first use of a source reads a whole batch of the user's own sent texts and analyses it into
// "## 정체성" of that profile; drafts are written as that person; corrections refine it every REFINE_EVERY. Separate per app and per room.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runOnboard } from "../bin/onboard.ts";
import { type CommentAdapter, draftComments } from "../lib/comments.ts";
import { ensureKakaoRoom } from "../lib/kakao-tone.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { corpusFile, maybeRefine, parseIdentity, REFINE_EVERY } from "../lib/persona.ts";
import { identityOf, loadStyle, paths, recordCorrection, templatesOf, toneFile, writeIdentity } from "../lib/settings.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.toneDir(), paths.learned(), paths.corpusDir(), paths.personalFeature(), join(env.dir, "custom", "sns")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const MAIL_ID = ["존댓말(해요체)로 짧게 쓴다", "인사 없이 바로 본론으로 들어간다", "끝은 '확인 부탁드려요.'로 맺는다"];
const sent = ["To: a@example.com\nSubject: 견적\n\n안녕하세요. 견적서 보내드려요.\n확인 부탁드려요.\n\n> 이전 메일 인용", "자료 첨부했어요. 확인 부탁드려요."];

test("the identity drops what could identify someone and keeps at most 12 lines", () => {
	const out = parseIdentity(j({ identity: ["해요체를 쓴다", "메일 끝에 kim@example.com을 적는다", "010-1234-5678로 연락을 받는다", "https://x.example 링크를 붙인다", ...Array.from({ length: 20 }, (_, i) => `습관 ${i}`)] }));
	expect(out[0]).toBe("해요체를 쓴다");
	expect(out.some(l => /@|010-|https/.test(l))).toBe(false);
	expect(out).toHaveLength(12);
	expect(parseIdentity("not json")).toEqual([]);
});

test("the first mail reads the sent mailbox once, analyses it into the mail identity, and the draft is written as that person", async () => {
	const analyze = fakeModel([j({ identity: MAIL_ID, templates: [{ when: "자료 요청", lines: ["{이름}님 안녕하세요.", "요청하신 {자료} 보내드려요.", "문의는 kim@example.com으로"] }] })]);
	const draft = fakeModel([j(goodReply)]);
	let reads = 0;
	const sentTexts = async () => (reads++, sent);
	expect(await offerMailDraft(mailFixture, { send: () => {}, call: draft.call, analyze: analyze.call, sentTexts })).toBe("offered");
	expect(reads).toBe(1);
	expect(analyze.calls[0]!.user).toContain("견적서 보내드려요.");
	expect(analyze.calls[0]!.user).toContain("(answering: 이전 메일 인용)");
	expect(analyze.calls[0]!.system).toContain("templates");
	expect(templatesOf({ app: "mail" })).toEqual(["자료 요청 => {이름}님 안녕하세요. | 요청하신 {자료} 보내드려요."]);
	expect(readFileSync(corpusFile({ app: "mail" }), "utf8")).toContain("견적서 보내드려요.");
	expect(identityOf({ app: "mail" })).toEqual(MAIL_ID);
	expect(readFileSync(toneFile({ app: "mail" }), "utf8")).toContain("- 확인 부탁드려요.");
	expect(draft.calls[0]!.user).toContain("- 존댓말(해요체)로 짧게 쓴다");
	expect(draft.calls[0]!.user).toContain("- 자료 요청 => {이름}님 안녕하세요.");

	expect(await offerMailDraft({ ...mailFixture, key: "m-2" }, { send: () => {}, call: draft.call, analyze: analyze.call, sentTexts })).toBe("offered");
	expect(reads).toBe(1);
	expect(analyze.calls).toHaveLength(1);
});

test("a mailbox with nothing to read yet is asked again with the next mail; a failed analysis still lets the draft go out", async () => {
	let reads = 0;
	const draft = fakeModel([j(goodReply)]);
	const empty = async () => (reads++, [] as string[]);
	await offerMailDraft({ ...mailFixture, key: "e-1" }, { send: () => {}, call: draft.call, analyze: fakeModel(["x"]).call, sentTexts: empty });
	await offerMailDraft({ ...mailFixture, key: "e-2" }, { send: () => {}, call: draft.call, analyze: fakeModel(["x"]).call, sentTexts: empty });
	expect(reads).toBe(2);
	const failing = async () => Promise.reject(new Error("zele down"));
	const logs: string[] = [];
	expect(await offerMailDraft({ ...mailFixture, key: "e-3" }, { send: () => {}, call: draft.call, analyze: fakeModel(["x"]).call, sentTexts: failing, log: l => void logs.push(l) })).toBe("offered");
	expect(logs.join("\n")).toContain("zele down");
});

test("each comment source learns its own identity from its own past replies", async () => {
	enable(env, { apps: { youtube: { auto: true }, instagram: { auto: true } } });
	const adapter = (app: string, texts: string[]): CommentAdapter => ({
		app,
		label: app,
		parse: l => (l.startsWith(`${app}:`) ? { id: l, author: "viewer", text: l.slice(app.length + 1), context: "" } : undefined),
		stage: async c => `job-${c.id}`,
		discard: async () => {},
		ownTexts: async () => texts,
	});
	const reply = j({ action: "draft", reason: "r", to: "viewer", body: "고마워요!", questions: [] });
	await draftComments(adapter("youtube", ["봐 주셔서 고마워요~"]), ["youtube:좋아요"], { call: fakeModel([reply]).call, analyze: fakeModel([j({ identity: ["물결표를 자주 쓴다"] })]).call });
	await draftComments(adapter("instagram", ["감사합니다."]), ["instagram:예뻐요"], { call: fakeModel([reply]).call, analyze: fakeModel([j({ identity: ["마침표로 짧게 끝낸다"] })]).call });
	expect(identityOf({ app: "youtube" })).toEqual(["물결표를 자주 쓴다"]);
	expect(identityOf({ app: "instagram" })).toEqual(["마침표로 짧게 끝낸다"]);
	expect(loadStyle({ app: "youtube" }).identity).toEqual(["물결표를 자주 쓴다"]);
});

test("a kakao room is swept from its history into its own identity; another room keeps its own; the app identity is the fallback", async () => {
	const reader = (lines: string[]) => async () => ({ messages: async () => lines.map((text, i) => ({ fromMe: true, type: 1, text, id: i }) as any) });
	await ensureKakaoRoom("101", reader(["ㅇㅋ 내일 봐"]), fakeModel([j({ identity: ["반말로 짧게 말한다"] })]).call);
	await ensureKakaoRoom("102", reader(["네 확인했습니다."]), fakeModel([j({ identity: ["합니다체로 답한다"] })]).call);
	expect(identityOf({ app: "kakao", room: "101" })).toEqual(["반말로 짧게 말한다"]);
	expect(identityOf({ app: "kakao", room: "102" })).toEqual(["합니다체로 답한다"]);
	writeIdentity({ app: "kakao" }, ["카톡 기본 말투"]);
	expect(loadStyle({ app: "kakao", room: "101" }).identity).toEqual(["반말로 짧게 말한다"]);
	expect(loadStyle({ app: "kakao", room: "999" }).identity).toEqual(["카톡 기본 말투"]);
});

test(`every ${REFINE_EVERY} corrections fold into the identity; a reply that is not an identity keeps the old one`, async () => {
	writeIdentity({ app: "mail" }, MAIL_ID);
	const refine = fakeModel([j({ identity: [...MAIL_ID, "날짜는 숫자로 쓴다"] })]);
	for (let i = 1; i < REFINE_EVERY; i++) {
		recordCorrection({ app: "mail" }, `고침 ${i}`, new Date("2030-01-01"));
		expect(await maybeRefine({ app: "mail" }, refine.call)).toBe(false);
	}
	recordCorrection({ app: "mail" }, "날짜는 숫자로 써 줘", new Date("2030-01-01"));
	expect(await maybeRefine({ app: "mail" }, refine.call)).toBe(true);
	expect(refine.calls[0]!.user).toContain("날짜는 숫자로 써 줘");
	expect(identityOf({ app: "mail" }).at(-1)).toBe("날짜는 숫자로 쓴다");
	for (let i = 0; i < REFINE_EVERY; i++) recordCorrection({ app: "mail" }, `또 ${i}`, new Date("2030-01-02"));
	expect(await maybeRefine({ app: "mail" }, fakeModel(["모르겠어요"]).call)).toBe(false);
	expect(identityOf({ app: "mail" }).at(-1)).toBe("날짜는 숫자로 쓴다");
});

test("onboard on --app youtube reads the past replies and saves the identity with the examples", async () => {
	mkdirSync(join(env.dir, "custom", "sns"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "sns", "config.json"), JSON.stringify({ youtube: { channel_id: "UC0" } }));
	const sns = { connected: () => true, ownTexts: async () => ["영상 봐 주셔서 고마워요.", "다음 영상도 기대해 주세요!"] };
	const out = await runOnboard(["on", "--app", "youtube"], async () => ({ code: 1, stdout: "", stderr: "" }), false, sns, fakeModel([j({ identity: ["밝고 다정하게 답한다"] })]).call);
	expect(out.code).toBe(0);
	expect(identityOf({ app: "youtube" })).toEqual(["밝고 다정하게 답한다"]);
	expect(readFileSync(toneFile({ app: "youtube" }), "utf8")).toContain("- 영상 봐 주셔서 고마워요.");
});
