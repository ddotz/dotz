import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { reviseDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { readArgv, readMailBody, replyArgv, sendArgv, sendWith } from "../lib/senders.ts";
import { paths } from "../lib/settings.ts";
import { addStagedFile, stagedFiles, stagedName } from "../lib/staged.ts";
import { addDraft, answerDrafts, getDraft, listDrafts, type DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, fakeModel, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-acct-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
writeFileSync(join(lib, "(마크추가) 행방불명_공유용.pdf"), "bytes");
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files"), join(env.dir, "custom", "apps.json"), join(env.dir, "mail-conversations.json")]) rmSync(p, { force: true, recursive: true });
});

const A1 = "miseol91@gmail.com";
const A2 = "sara1468@snu.ac.kr";
let seq = 0;
const rec = (patch: Partial<DraftRec> = {}): DraftRec => ({
	id: `RACCT${++seq}A`, kind: "mail", app: "mail", source: "zele", mailId: "T42", ref: "zele-t42", to: "kim@example.com", subject: "Re: 회의", body: "네, 확인했습니다.", status: "pending", created: new Date().toISOString(),
	changes: [], questions: [], item: { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "회의", text: "회의 일정 문의" }, mode: "reply", ...patch,
});
const fake = () => {
	const calls: string[][] = [];
	const run: Runner = async argv => (calls.push(argv), { code: 0, stdout: "ok", stderr: "" });
	return { calls, run };
};
const sink = () => {
	const sent: string[] = [];
	return { sent, send: (_: string, text: string) => void sent.push(text) };
};

describe("zele argv with several accounts", () => {
	test("read, reply and send pass --account when the account is known and nothing when it is not", () => {
		expect(readArgv("T42", A2)).toEqual(["zele", "mail", "read", "T42", "--account", A2]);
		expect(readArgv("T42")).toEqual(["zele", "mail", "read", "T42"]);
		expect(replyArgv("T42", "kim@example.com", "body", [], [], A2)).toEqual(["zele", "mail", "reply", "T42", "--account", A2, "--to", "kim@example.com", "--body", "body"]);
		expect(sendArgv("a@example.com", "제목", "body", [], [], A1)).toEqual(["zele", "mail", "send", "--account", A1, "--to", "a@example.com", "--subject", "제목", "--body", "body"]);
	});

	test("a reply goes through the account the draft recorded, for the read and the reply alike", async () => {
		const f = fake();
		expect((await sendWith(rec({ account: A2 }), f.run)).ok).toBe(true);
		expect(f.calls.map(c => c.slice(0, 6))).toEqual([["zele", "mail", "read", "T42", "--account", A2], ["zele", "mail", "reply", "T42", "--account", A2]]);
	});

	test("an older draft without an account takes the account of its stored mail", async () => {
		writeFileSync(join(env.dir, "mail-conversations.json"), JSON.stringify([{ key: "zele-t42", account: A2 }, { key: "zele-t43", account: A1 }]));
		const f = fake();
		await sendWith(rec(), f.run);
		expect(f.calls.every(c => c.includes("--account") && c[c.indexOf("--account") + 1] === A2)).toBe(true);
	});

	test("a new mail goes through the account of its mail app instance", async () => {
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-2": { app: "mail", label: "학교", filter: { account: A2 } } }));
		const f = fake();
		await sendWith(rec({ app: "mail-2", compose: true, mailId: "compose-x", ref: "compose-x" }), f.run);
		expect(f.calls).toEqual([["zele", "mail", "send", "--account", A2, "--to", "kim@example.com", "--subject", "Re: 회의", "--body", "네, 확인했습니다."]]);
	});

	test("the body read at offer time uses the mail's account", async () => {
		const f = fake();
		await readMailBody("zele", "T42", f.run, A2);
		expect(f.calls).toEqual([["zele", "mail", "read", "T42", "--account", A2]]);
	});
});

describe("files are picked before the words are written", () => {
	const askMail = { ...mailFixture, key: "a-1", subject: "행방불명 악보 부탁드립니다", from: "Student <stu@example.com>", body: "선생님 행방불명 악보 보내 주세요." };
	const claimed = { action: "draft", reason: "asks for a score", to: "stu@example.com", subject: "Re: 행방불명 악보 부탁드립니다", body: "악보 보내드립니다.", questions: ["첨부 폴더를 볼 수 없어 파일을 붙이지 못했습니다", "수업은 언제가 좋으세요?"] };

	test("a model text that says no file can be attached is dropped when a file is attached; other questions stay", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const model = fakeModel([j(claimed)]);
		const out = sink();
		expect(await offerMailDraft(askMail, { send: out.send, call: model.call })).toBe("offered");
		expect(model.calls[0]!.user).toContain('"(마크추가) 행방불명_공유용.pdf"');
		const card = parseDraftApproval(out.sent[0]!)!;
		expect(card.attachments?.map(a => a.name)).toEqual(["(마크추가) 행방불명_공유용.pdf"]);
		expect(card.decide).toEqual(["수업은 언제가 좋으세요?"]);
		expect(listDrafts()[0]!.questions).toEqual(["수업은 언제가 좋으세요?"]);
	});

	test("a folder with nothing that fits tells the model so, and the question stays", async () => {
		const empty = mkdtempSync(join(tmpdir(), "rd-acct-empty-"));
		enable(env, { attachFolders: { mail: empty } });
		const model = fakeModel([j(claimed)]);
		const out = sink();
		await offerMailDraft(askMail, { send: out.send, call: model.call });
		rmSync(empty, { recursive: true, force: true });
		expect(model.calls[0]!.user).toContain("No file in the attachment folder fits");
		expect(parseDraftApproval(out.sent[0]!)?.decide).toHaveLength(2);
	});

	test("revising looks for files again: the owner's change names a piece", async () => {
		const other = mkdtempSync(join(tmpdir(), "rd-acct-other-"));
		writeFileSync(join(other, "행방불명_공유용.pdf"), "bytes");
		enable(env, { attachFolders: { mail: other } });
		const plain = { ...mailFixture, key: "a-2", subject: "회의 일정 문의", body: "다음 주 회의 일정을 알려 주실 수 있을까요?" };
		await offerMailDraft(plain, { send: sink().send, call: fakeModel([j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요.", questions: [] })]).call });
		const first = listDrafts()[0]!;
		expect(stagedFiles(first.id)).toHaveLength(0);
		const step = await reviseDraft(first.id, "행방불명 악보도 같이 붙여 주세요", { call: fakeModel([j({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 회의 일정 문의", body: "확인해 보고 말씀드릴게요. 행방불명 악보도 보내드립니다.", questions: [] })]).call });
		rmSync(other, { recursive: true, force: true });
		expect(step.ok).toBe(true);
		expect(stagedFiles(step.id!).map(f => f.name)).toEqual(["행방불명_공유용.pdf"]);
	});

	test("revising keeps files the owner attached by hand and does not add a second copy", async () => {
		enable(env, { attachFolders: { mail: lib } });
		await offerMailDraft(askMail, { send: sink().send, call: fakeModel([j({ ...claimed, questions: [] })]).call });
		const first = listDrafts()[0]!;
		writeFileSync(join(env.dir, "mine.txt"), "mine");
		addStagedFile(first.id, join(env.dir, "mine.txt"));
		const step = await reviseDraft(first.id, "더 짧게", { call: fakeModel([j({ ...claimed, questions: [], body: "악보 보내드립니다. 감사합니다." })]).call });
		expect(stagedFiles(step.id!).map(f => f.name)).toEqual(["(마크추가) 행방불명_공유용.pdf", "mine.txt"]);
	});

	test("revising a draft that promises a file but has none picks from the library", async () => {
		const empty = mkdtempSync(join(tmpdir(), "rd-acct-late-"));
		enable(env, { attachFolders: { mail: empty } });
		await offerMailDraft(askMail, { send: sink().send, call: fakeModel([j({ ...claimed, questions: [] })]).call });
		const first = listDrafts()[0]!;
		expect(first.libraryMiss).toBe(true);
		writeFileSync(join(empty, "행방불명_공유용.pdf"), "bytes");
		const step = await reviseDraft(first.id, "더 짧게", { call: fakeModel([j({ ...claimed, questions: [], body: "악보 보내드립니다." })]).call });
		rmSync(empty, { recursive: true, force: true });
		expect(stagedFiles(step.id!).map(f => f.name)).toEqual(["행방불명_공유용.pdf"]);
		expect(getDraft(step.id!)!.libraryMiss).toBeUndefined();
	});
});

describe("staged file names", () => {
	test("parentheses and brackets stay; only slashes, control characters and leading dots change", () => {
		expect(stagedName("(마크추가) 행방불명 (1)[a].pdf")).toBe("(마크추가) 행방불명 (1)[a].pdf");
		expect(stagedName("dir/sub\\악보.pdf")).toBe("악보.pdf");
		expect(stagedName(".hidden.pdf")).toBe("hidden.pdf");
		expect(stagedName("a\u0000b.pdf")).toBe("a_b.pdf");
	});

	test("a second file of the same name gets (2) so the receiver can tell them apart", () => {
		writeFileSync(join(env.dir, "x.pdf"), "x");
		const a = addStagedFile("RDUPNAME1", join(env.dir, "x.pdf"));
		const b = addStagedFile("RDUPNAME1", join(env.dir, "x.pdf"));
		expect([a.name, b.name]).toEqual(["x.pdf", "x (2).pdf"]);
	});
});

describe("mail ridden on a comment reply", () => {
	test("compose carries the library notes and libraryMiss; the view carries the warning", async () => {
		enable(env, { attachFolders: { mail: lib } });
		const link = realMailLink({});
		const r = await link.compose({ app: "mail", to: "kim@example.com", subject: "악보 보내드려요", body: "안녕하세요. 악보 보내드립니다.", fromLibrary: "zzqqxx" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.libraryMiss).toBe(true);
		expect(r.notes.join(" ")).toContain("찾지 못했어요");
		expect(link.view(r.id)?.notes?.join(" ")).toContain("찾지 못했어요");
	});
});

describe("answered drafts", () => {
	test("answerDrafts closes the pending and held drafts of a mail as answered, once", () => {
		addDraft(rec({ id: "RANSWER1", ref: "zele-ans" }));
		expect(answerDrafts("zele-ans")).toEqual(["RANSWER1"]);
		expect(getDraft("RANSWER1")!.status).toBe("answered");
		expect(answerDrafts("zele-ans")).toEqual([]);
	});
});
