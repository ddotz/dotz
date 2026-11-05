import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realMailLink } from "../../../hub/comments/mail-link.ts";
import { parseDraftApproval } from "../../../hub/draft-approval.ts";
import { composeMail } from "../../../hub/mail-cli.ts";
import { loadPlugins } from "../../../hub/plugins.ts";
import { runDraft } from "../bin/draft.ts";
import { ACCOUNT_HELD, askText, reviseDraft, sendDraft } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { readArgv, readMailBody, replyArgv, sendArgv, sendWith, zeleAccountOf } from "../lib/senders.ts";
import { paths } from "../lib/settings.ts";
import { addStagedFile, stagedFiles, stagedName } from "../lib/staged.ts";
import { addDraft, answerDrafts, getDraft, listDrafts, type DraftRec } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

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
const emitApproval = (id: string) => writeFileSync(paths.inbox(), `${JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), kind: "message", source: "web", channel: "mail:x", text: "1) 보내기", picks: [{ q: `이 답장 보낼까요? (${id})`, n: 1, label: "보내기" }] })}\n`);
const sink = () => {
	const sent: string[] = [];
	return { sent, send: (_: string, text: string) => void sent.push(text) };
};

// Two accounts behind zele: `whoami` names them, and a thread opens only on the account that holds it.
const twoAccounts = (holders: string[] = []) => {
	const calls: string[][] = [];
	const run: Runner = async argv => {
		calls.push(argv);
		if (argv[1] === "whoami") return { code: 0, stdout: `${A1}\n${A2}\n`, stderr: "" };
		const at = argv.indexOf("--account");
		const found = argv[2] !== "read" || (at > 0 && holders.includes(argv[at + 1]!));
		return { code: found ? 0 : 1, stdout: found ? "ok" : "", stderr: found ? "" : "Multiple accounts matched" };
	};
	return { calls, run };
};
const stored = (rows: unknown[]) => writeFileSync(join(env.dir, "mail-conversations.json"), JSON.stringify(rows));

describe("a mail of an install with several accounts", () => {
	test("a draft of app mail takes the account of the instance of its source; the plain zele source is no instance", () => {
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-score": { app: "mail", filter: { source: "score", account: A1 } }, "mail-all": { app: "mail", filter: { source: "zele", account: A2 } } }));
		expect(zeleAccountOf(rec({ source: "score", ref: "score-t42" }))).toBe(A1);
		expect(zeleAccountOf(rec())).toBeUndefined();
	});

	test("a new mail with an origin goes through the account of the origin mail", () => {
		stored([{ key: "zele-t42", account: A2 }]);
		expect(zeleAccountOf(rec({ compose: true, ref: "compose-x", origin: { kind: "mail", id: "zele-t42", text: "메일 답장에 이어서" } }))).toBe(A2);
	});

	test("a waiting draft reads the account from the stored mail's recipient, without reading the thread", async () => {
		stored([{ key: "zele-t42", to: `Owner <${A2}>` }]);
		const f = twoAccounts([A2]);
		expect((await sendWith(rec(), f.run)).ok).toBe(true);
		expect(f.calls.map(c => c.slice(1, 3).join(" "))).toEqual(["whoami", "mail read", "mail reply"]);
		expect(f.calls.slice(1).every(c => c[c.indexOf("--account") + 1] === A2)).toBe(true);
	});

	test("with nothing stored, the one account that opens the thread sends it", async () => {
		const f = twoAccounts([A2]);
		expect((await sendWith(rec({ source: "zele", mailId: "T42" }), f.run)).ok).toBe(true);
		expect(f.calls.at(-1)!.slice(0, 6)).toEqual(["zele", "mail", "reply", "T42", "--account", A2]);
	});

	test("no account or both accounts open the thread: nothing is sent and the refusal names the accounts", async () => {
		for (const holders of [[], [A1, A2]]) {
			const f = twoAccounts(holders);
			const out = await sendWith(rec(), f.run);
			expect(out.ok).toBe(false);
			expect(out.message).toContain(A1);
			expect(out.message).toContain(A2);
			expect(f.calls.some(c => c[2] === "reply")).toBe(false);
		}
	});

	test("a new mail with no account to go by is refused; it has no thread to look for", async () => {
		const f = twoAccounts();
		const out = await sendWith(rec({ compose: true, ref: "compose-y" }), f.run);
		expect(out.ok).toBe(false);
		expect(out.message).toContain(A2);
		expect(f.calls.map(c => c[1])).toEqual(["whoami"]);
	});

	test("one account: no probing and no --account", async () => {
		const calls: string[][] = [];
		const run: Runner = async argv => (calls.push(argv), { code: 0, stdout: argv[1] === "whoami" ? A1 : "ok", stderr: "" });
		expect((await sendWith(rec(), run)).ok).toBe(true);
		expect(calls.map(c => c.includes("--account"))).toEqual([false, false, false]);
	});

	test("a failed send says so, for the CLI to tell the owner", async () => {
		addDraft(rec({ id: "RFAILED1" }));
		const f = twoAccounts();
		emitApproval("RFAILED1");
		expect(await sendDraft("RFAILED1", { run: f.run })).toMatchObject({ ok: false, sendFailed: true });
	});
});

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

	test("a failed send names zele's error, not the runtime warning printed before it", async () => {
		const stderr = "(node:72075) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\nMultiple accounts matched\n";
		const out = await sendWith(rec({ compose: true, mailId: "compose-x", ref: "compose-x" }), async () => ({ code: 1, stdout: "", stderr }));
		expect(out).toMatchObject({ ok: false, message: "보내지 못했어요: Multiple accounts matched" });
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

	test("a category instance (filter.source score) composes a new mail through zele, on its account", async () => {
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ "mail-score": { app: "mail", label: "악보·MR 요청", filter: { source: "score", account: A1 } } }));
		enable(env, {});
		const r = await realMailLink({}).compose({ app: "mail-score", to: "kim@example.com", subject: "악보 보내드려요", body: "안녕하세요. 악보 보내드립니다." });
		if (!r.ok) throw new Error(r.reason);
		const made = getDraft(r.id)!;
		expect(made).toMatchObject({ app: "mail-score", source: "zele", compose: true });
		const f = fake();
		await sendWith(made, f.run);
		expect(f.calls[0]!.slice(0, 5)).toEqual(["zele", "mail", "send", "--account", A1]);
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

	test("a sale-only sheet is never picked; a buyer gets only the MR of the one song, or nothing and 확인 필요", async () => {
		const songs = mkdtempSync(join(tmpdir(), "rd-acct-songs-"));
		for (const [dir, name] of [["Golden 골든 기악합주/악보", "Golden 공유용.pdf"], ["Golden 골든 기악합주/악보", "Golden 총보.pdf"], ["Golden 골든 기악합주/악보", "Golden 피아노 반주 악보.pdf"], ["Golden 골든 기악합주/MR", "골든Golden_MR.mp3"], ["봄날 기악합주/MR", "봄날_MR.mp3"]]) {
			mkdirSync(join(songs, dir!), { recursive: true });
			writeFileSync(join(songs, dir!, name!), "bytes");
		}
		enable(env, { attachFolders: { mail: songs } });
		const link = realMailLink({});
		const names = (id: string) => stagedFiles(id).map(f => f.name).sort();
		const spec = { app: "mail", to: "kim@example.com", subject: "악보 보내드려요", body: "안녕하세요. 악보 보내드립니다." };
		const any = await link.compose({ ...spec, fromLibrary: "Golden 골든 총보 피아노 악보" });
		if (!any.ok) throw new Error(any.reason);
		expect(names(any.id)).toEqual(["Golden 공유용.pdf", "골든Golden_MR.mp3"]);
		const buyer = await link.compose({ ...spec, fromLibrary: "Golden 골든 구매했어요 MR", library: "mr" });
		if (!buyer.ok) throw new Error(buyer.reason);
		expect(names(buyer.id)).toEqual(["골든Golden_MR.mp3"]);
		const unsure = await link.compose({ ...spec, fromLibrary: "구매했어요 기악합주 MR", library: "mr" });
		if (!unsure.ok) throw new Error(unsure.reason);
		expect(names(unsure.id)).toEqual([]);
		expect(unsure.notes.join(" ")).toContain("확인 필요");
		rmSync(songs, { recursive: true, force: true });
	});
});

describe("the account of a draft is settled when the draft is made", () => {
	const offer = async (key: string, run?: Runner) => {
		enable(env, {});
		const out = sink();
		expect(await offerMailDraft({ ...mailFixture, key, id: "T42" }, { send: out.send, call: fakeModel([j(goodReply)]).call, run })).toBe("offered");
		return { card: out.sent[0]!, made: listDrafts().find(d => d.ref === key)! };
	};

	test("the draft records the account its stored mail came to", async () => {
		stored([{ key: "acct-stored", account: A2 }]);
		expect((await offer("acct-stored")).made.account).toBe(A2);
	});

	test("the draft records the one account that opens the thread, and the card stays quiet", async () => {
		const { made, card } = await offer("acct-probe", twoAccounts([A2]).run);
		expect(made.account).toBe(A2);
		expect(card).not.toContain(A1);
	});

	test("undecided among several accounts: the card names them and says it will not send, until an account is set", async () => {
		const { made, card } = await offer("acct-none", twoAccounts().run);
		expect(made.accounts).toEqual([A1, A2]);
		expect(card).toContain(`${A1}, ${A2}`);
		expect(card).toContain(ACCOUNT_HELD);
		mkdirSync(join(env.dir, "custom"), { recursive: true });
		writeFileSync(join(env.dir, "custom", "apps.json"), JSON.stringify({ mail: { app: "mail", filter: { account: A1 } } }));
		expect(askText(made, [])).not.toContain(ACCOUNT_HELD);
	});

	test("draft.ts new settles the account too", async () => {
		enable(env, {});
		const out = await runDraft(["new", "--mail", "zele-t77", "--from", "kim@example.com", "--source", "zele", "--id", "T77"], "회의 일정 알려 주세요", { call: fakeModel([j(goodReply)]).call, run: twoAccounts().run });
		expect(out.lines[0]).toContain(ACCOUNT_HELD);
	});

	test("a new mail composed by the CLI says so too", async () => {
		const made = await composeMail({ app: "mail", to: ["kim@example.com"], subject: "안내", body: "안녕하세요. 안내드립니다.", notify: false }, { run: twoAccounts().run });
		if (!made.ok) throw new Error(made.error);
		expect(askText(made.rec, [])).toContain(ACCOUNT_HELD);
	});

	test("a revised draft keeps saying so", async () => {
		const { made } = await offer("acct-rev", twoAccounts().run);
		const step = await reviseDraft(made.id, "더 짧게", { call: fakeModel([j(goodReply)]).call });
		expect(step.text).toContain(ACCOUNT_HELD);
	});

	test("an older stored mail with no account: a plugin mailer gets the one account it was addressed to", async () => {
		stored([{ key: "score-t42", to: `Owner <${A2}>` }]);
		mkdirSync(join(env.dir, "custom", "plugins"), { recursive: true });
		const plugin = join(env.dir, "custom", "plugins", "acct.ts");
		writeFileSync(plugin, `export default { reply: async d => (globalThis.__acctGot = d.account, { ok: true, message: "보냈어요" }) };`);
		await loadPlugins(env.dir);
		const got = globalThis as { __acctGot?: string };
		expect((await sendWith(rec({ source: "score", ref: "score-t42" }), twoAccounts().run)).ok).toBe(true);
		expect(got.__acctGot).toBe(A2);
		delete got.__acctGot;
		rmSync(plugin);
		await loadPlugins(env.dir);
	});

	test("a mailer that cannot even start is a failed send: the reason is reported and the draft stays unsent", async () => {
		addDraft(rec({ id: "RTHROWN1", account: A1 }));
		emitApproval("RTHROWN1");
		const out = await sendDraft("RTHROWN1", { run: async () => { throw new Error("zele not found"); } });
		expect(out).toMatchObject({ ok: false, sendFailed: true });
		expect(out.text).toContain("zele not found");
		expect(getDraft("RTHROWN1")!.status).toBe("pending");
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
