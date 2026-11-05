import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettings } from "../../../hub/app-settings.ts";
import { asksForFile, claimsAttachment } from "../../../hub/draft-approval.ts";
import { composeMail } from "../../../hub/mail-cli.ts";
import { buildPrompt, generateReply, type ReplyItem, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { advance } from "../../../hub/runtime/test-clock.ts";
import { candidatesFor, CANDIDATE_MAX, reviseDraft } from "../lib/flow.ts";
import { matchLibrary } from "../lib/library.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { paths } from "../lib/settings.ts";
import { addStagedFile, brctlArgv, EVICTED_LATER, resumeWantedFiles, stageFiles, stagedFiles, type Want } from "../lib/staged.ts";
import { addDraft, getDraft, listDrafts, type DraftRec } from "../lib/store.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

// What a mail asks for decides the files on its draft: the model chooses among candidates, a file that is slow to download is not lost. Made-up data.
const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-choice-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
for (const f of ["봄노래_문서.pdf", "봄노래_MR.mp3", "여름노래_문서.pdf", "시리즈_1부.pdf", "시리즈_2부.pdf", "시리즈_3부.pdf", "고정.pdf", "봄노래_독서_문서.pdf"]) writeFileSync(join(lib, f), `bytes of ${f}`);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
});

const sink = () => {
	const sent: string[] = [];
	return { sent, send: (_: string, text: string) => void sent.push(text) };
};
const springMail = { ...mailFixture, key: "c-1", subject: "봄노래 문서 부탁드립니다", from: "Kim <kim@example.com>", body: "봄노래 문서 부탁드립니다." };
const answer = (extra: object = {}) => ({ action: "draft", reason: "asks for a score", to: "kim@example.com", subject: "Re: 봄노래 문서 부탁드립니다", body: "봄노래 문서 보내드립니다.", questions: [], ...extra });
const names = (id: string) => stagedFiles(id).map(f => f.name);

describe("(a) the model chooses among the candidates", () => {
	test("only the chosen file is staged, not every file that matched", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const model = fakeModel([j(answer({ files: ["봄노래_문서.pdf"] }))]);
		expect(await offerMailDraft(springMail, { send: sink().send, call: model.call })).toBe("offered");
		expect(model.calls).toHaveLength(1);
		expect(names(listDrafts()[0]!.id)).toEqual(["봄노래_문서.pdf"]);
		expect(model.calls[0]!.user).toContain('"봄노래_MR.mp3"');
		expect(model.calls[0]!.user).not.toContain('"여름노래_문서.pdf"');
	});
	test("a name outside the candidates is dropped; [] chooses none; no key is no choice", async () => {
		const item: ReplyItem = { kind: "mail", from: "Kim <kim@example.com>", subject: "봄노래", text: "봄노래 문서 부탁드립니다", candidates: ["봄노래_문서.pdf", "봄노래_MR.mp3"] };
		const style: ReplyStyle = { samples: [], rules: [], corrections: [], forbidden: [] };
		const chose = async (files?: string[]) => (await generateReply(item, style, fakeModel([j(answer({ body: "확인했어요.", ...(files ? { files } : {}) }))]).call)).files;
		expect(await chose(["봄노래_문서.pdf", "없는 파일.pdf", "봄노래_문서.pdf"])).toEqual(["봄노래_문서.pdf"]);
		expect(await chose([])).toEqual([]);
		expect(await chose()).toBeUndefined();
	});
	test("a body that promises a file when none is chosen is rewritten once", async () => {
		const item: ReplyItem = { kind: "mail", from: "Kim <kim@example.com>", subject: "봄노래", text: "봄노래 문서 부탁드립니다", candidates: ["봄노래_문서.pdf"] };
		const style: ReplyStyle = { samples: [], rules: [], corrections: [], forbidden: [] };
		const model = fakeModel([j(answer({ files: [] })), j(answer({ files: [], body: "어떤 곡인지 알려 주세요." }))]);
		const r = await generateReply(item, style, model.call);
		expect(model.calls).toHaveLength(2);
		expect(r).toMatchObject({ tries: 2, files: [], draft: { body: "어떤 곡인지 알려 주세요." } });
		expect(buildPrompt(item, style).user).toContain('"봄노래_문서.pdf"');
	});
	test("an empty pick from the tie-break means no files", async () => {
		const tie = mkdtempSync(join(tmpdir(), "rd-choice-tie-"));
		for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(tie, `캐논_${n}.pdf`), n);
		expect(await matchLibrary(tie, { subject: "캐논 문서", text: "" }, async () => [])).toEqual([]);
		expect(await matchLibrary(tie, { subject: "캐논 문서", text: "" })).toEqual([]);
		rmSync(tie, { recursive: true, force: true });
	});
});

describe("(c) compose --from-library", () => {
	test("takes the best-matching song only, not the next best ones", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const made = await composeMail({ app: "mail", to: ["kim@example.com"], subject: "문서 보내드려요", body: "안녕하세요. 문서 보내드립니다.", fromLibrary: "봄노래 독서 여름노래", notify: false });
		if (!made.ok) throw new Error(made.error);
		expect(names(made.rec.id)).toEqual(["봄노래_독서_문서.pdf"]);
	});
});

describe("(d) a rule's files are candidates, not a replacement", () => {
	const rule = { name: "고정", when: "문서를 보내 달라는 메일", how: "짧게 답해요", files: ["고정.pdf"] };
	const seriesMail = { ...mailFixture, key: "c-2", subject: "시리즈 1부 2부 3부 문서 부탁드립니다", from: "Kim <kim@example.com>", body: "시리즈 1부 2부 3부 문서 부탁드립니다." };
	test("the rule's file comes first, then the matches, capped", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const c = await candidatesFor({ kind: "mail", from: "x", subject: seriesMail.subject, text: seriesMail.body }, { source: "zele", ref: "c-2" }, { id: "r1", ...rule, on: true });
		expect(c!.files.map(f => f.rel).slice(0, 4)).toEqual(["고정.pdf", "시리즈_1부.pdf", "시리즈_2부.pdf", "시리즈_3부.pdf"]);
		const wide = mkdtempSync(join(tmpdir(), "rd-choice-wide-"));
		for (let n = 0; n < 20; n++) writeFileSync(join(wide, `봄노래_${n}.pdf`), "x");
		enable(env, { attachFolders: { mail: wide } });
		expect((await candidatesFor({ kind: "mail", from: "x", subject: "봄노래", text: "봄노래 문서" }, { source: "zele", ref: "c-2" }))!.files).toHaveLength(CANDIDATE_MAX);
		rmSync(wide, { recursive: true, force: true });
	});
	test("words that say the kind of file do not fill the list: the asked song's score stays on it", async () => {
		const wide = mkdtempSync(join(tmpdir(), "rd-choice-kinds-"));
		for (let n = 0; n < 20; n++) writeFileSync(join(wide, `노래${n}_MR.mp3`), "x");
		writeFileSync(join(wide, "봄노래_MR.mp3"), "x");
		writeFileSync(join(wide, "봄노래_문서.pdf"), "x");
		enable(env, { attachFolders: { mail: wide } });
		const c = await candidatesFor({ kind: "mail", from: "x", subject: "문서 MR 부탁드려요", text: "봄노래 문서와 MR 부탁드립니다" }, { source: "zele", ref: "c-3" });
		expect(c!.files.map(f => f.rel)).toEqual(expect.arrayContaining(["봄노래_MR.mp3", "봄노래_문서.pdf"]));
		expect(c!.files).toHaveLength(CANDIDATE_MAX);
		rmSync(wide, { recursive: true, force: true });
	});
	test("an ask in the subject alone still lets the model choose among the candidates", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const model = fakeModel([j(answer({ body: "시리즈 1부, 2부 보내드립니다.", files: ["시리즈_1부.pdf", "시리즈_2부.pdf"] }))]);
		await offerMailDraft({ ...mailFixture, key: "c-4", subject: "시리즈 문서 요청드립니다", from: "Kim <kim@example.com>", body: "1부, 2부 다 받을 수 있을까요?" }, { send: sink().send, call: model.call });
		expect(names(listDrafts()[0]!.id)).toEqual(["시리즈_1부.pdf", "시리즈_2부.pdf"]);
	});
	test("a mail that asks for three parts gets the three parts the model chose, not the rule's one file", async () => {
		enable(env, { apps: { mail: { auto: false } }, attachFolders: { mail: lib } });
		writeSettings(env.dir, "mail", { draft_rules: [rule], draft_default: "" });
		const model = fakeModel(["1", j(answer({ body: "1부, 2부, 3부 문서 보내드립니다.", files: ["시리즈_1부.pdf", "시리즈_2부.pdf", "시리즈_3부.pdf"] }))]);
		expect(await offerMailDraft(seriesMail, { send: sink().send, call: model.call })).toBe("offered");
		expect(names(listDrafts()[0]!.id)).toEqual(["시리즈_1부.pdf", "시리즈_2부.pdf", "시리즈_3부.pdf"]);
	});
});

describe("(e) 고치기 about the files", () => {
	const draft = (): DraftRec => {
		const rec: DraftRec = { id: "RCHOICE1", kind: "mail", app: "mail", source: "zele", mailId: "T1", ref: "zele-t1", to: "kim@example.com", subject: "Re: 봄노래 문서", body: "문서 보내드립니다.", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "봄노래 문서", text: "봄노래 문서 부탁드립니다" } };
		addDraft(rec);
		addStagedFile(rec.id, join(lib, "봄노래_문서.pdf"));
		addStagedFile(rec.id, join(lib, "봄노래_MR.mp3"));
		return rec;
	};
	test("'one file only' leaves the file the model chose", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const rec = draft();
		const step = await reviseDraft(rec.id, "첨부파일 하나만 보내", { call: fakeModel([j(answer({ body: "문서 보내드립니다.", files: ["봄노래_문서.pdf"] }))]).call });
		expect(step.ok).toBe(true);
		expect(names(step.id!)).toEqual(["봄노래_문서.pdf"]);
	});
	test("a change about wording keeps the files whatever the model says", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const rec = draft();
		const step = await reviseDraft(rec.id, "더 짧게", { call: fakeModel([j(answer({ body: "문서 보내드립니다.", files: ["봄노래_문서.pdf"] }))]).call });
		expect(names(step.id!)).toEqual(["봄노래_문서.pdf", "봄노래_MR.mp3"]);
	});
});

describe("(f) a file that is slow to download is not lost", () => {
	test("brctl gets the real path of a symlinked folder", () => {
		const real = mkdtempSync(join(tmpdir(), "rd-choice-real-"));
		const link = join(tmpdir(), `rd-choice-link-${process.pid}`);
		writeFileSync(join(real, "곡.pdf"), "x");
		symlinkSync(real, link);
		expect(brctlArgv(join(link, "곡.pdf"))).toEqual(["/usr/bin/brctl", "download", join(realpathSync(real), "곡.pdf")]);
		expect(brctlArgv(join(real, "없음.pdf"))).toEqual(["/usr/bin/brctl", "download", join(real, "없음.pdf")]);
		rmSync(link);
		rmSync(real, { recursive: true, force: true });
	});
	const evicted = () => Object.assign(new Error("EDEADLK: resource deadlock avoided, copyfile"), { code: "EDEADLK" });
	test("the card is posted with the file in wantFiles; the background retry stages it, clears wantFiles and calls changed", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const out = sink();
		let away = true;
		const copy = (src: string, to: string) => {
			if (away) throw evicted();
			copyFileSync(src, to);
		};
		let changed = 0;
		const stage = { copy, download: () => undefined, tries: 0, changed: () => void changed++ };
		expect(await offerMailDraft(springMail, { send: out.send, call: fakeModel([j(answer({ files: ["봄노래_문서.pdf"] }))]).call, stage })).toBe("offered");
		const id = listDrafts()[0]!.id;
		expect(out.sent[0]).toContain(EVICTED_LATER("봄노래_문서.pdf"));
		expect(getDraft(id)!.wantFiles?.map(w => w.name)).toEqual(["봄노래_문서.pdf"]);
		expect(names(id)).toEqual([]);
		await advance(30_000);   // still away: nothing lands, the retry goes on
		expect([names(id), changed]).toEqual([[], 0]);
		away = false;
		await advance(30_000);
		expect(changed).toBe(1);
		expect(names(id)).toEqual(["봄노래_문서.pdf"]);
		expect(getDraft(id)!.wantFiles ?? []).toEqual([]);
	});
	test("a failure that is not an eviction is kept in wantFiles too", async () => {
		const want: Want[] = [];
		const why = await stageFiles("RCHOICE2", [join(lib, "고정.pdf")], want, { copy: () => { throw new Error("boom"); }, tries: 0 });
		expect(why).toEqual(["boom"]);
		expect(want.map(w => w.name)).toEqual(["고정.pdf"]);
	});
	test("a pending draft with wantFiles left by another process gets the same retry", async () => {
		enable(env);
		const rec: DraftRec = { id: "RCHOICE3", kind: "mail", app: "mail", source: "zele", mailId: "T3", ref: "zele-t3", to: "kim@example.com", body: "x", status: "pending", created: new Date().toISOString(), changes: [], questions: [], wantFiles: [{ name: "고정.pdf", path: join(lib, "고정.pdf") }], item: { kind: "mail", from: "Kim <kim@example.com>", text: "x" } };
		addDraft(rec);
		let changed = 0;
		resumeWantedFiles({ changed: () => void changed++ });
		await advance(30_000);
		expect(changed).toBe(1);
		expect(names(rec.id)).toEqual(["고정.pdf"]);
		expect(getDraft(rec.id)!.wantFiles ?? []).toEqual([]);
	});
});

describe("(g) phrases that ask for or promise a file", () => {
	test.each(["문서 요청드립니다", "문서 신청해요", "보고서 받을 수 있을까요", "문서집 받고 싶어요", "전체본 부탁드립니다", "MR 부탁드립니다", "음원 보내주세요"])("%s asks for a file", t => {
		expect(asksForFile(t)).toBe(true);
	});
	test.each(["Mr. Kim 잘 부탁드립니다", "회의 신청해요", "안녕하세요 감사합니다"])("%s does not", t => {
		expect(asksForFile(t)).toBe(false);
	});
	test.each(["보고서 보내드립니다", "MR 보내드립니다", "전체본를 보내드릴게요", "문서집 보내드립니다"])("%s is a claim", t => {
		expect(claimsAttachment(t)).toBe(true);
	});
});
