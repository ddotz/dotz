// A mail of an onboarded webmail-no-api site (posted by its watch with `source` = the site name) cannot carry files: its approval card says so
// in the 첨부 row and names the files that stay behind, a send that holds files is refused, a text reply goes through the site's own commands,
// and a zele reply keeps the plain 첨부: 없음 row.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANNOT_ATTACH, CANNOT_ATTACH_WARNING, parseDraftApproval } from "../../../hub/draft-approval.ts";
import { askText } from "../lib/flow.ts";
import { offerMailDraft } from "../lib/offer.ts";
import { canAttach, sendWith } from "../lib/senders.ts";
import { addStagedFile } from "../lib/staged.ts";
import { paths } from "../lib/settings.ts";
import { listDrafts } from "../lib/store.ts";
import type { Runner } from "../lib/tone.ts";
import { enable, fakeModel, goodReply, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
const files = mkdtempSync(join(tmpdir(), "rd-wm-files-"));
afterAll(() => {
	env.cleanup();
	rmSync(files, { recursive: true, force: true });
});
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
	mkdirSync(join(env.dir, "custom", "webmail", "corp"), { recursive: true });
	writeFileSync(join(env.dir, "custom", "webmail", "corp", "spec.json"), "{}");
});

const scoreMail = { ...mailFixture, key: "corp-7", source: "corp", id: "7", subject: "악보 부탁드립니다", from: "Student <stu@example.com>", body: "센과 치히로 ost 악보 부탁드립니다." };
const scoreReply = { action: "draft", reason: "asks for a score", to: "stu@example.com", subject: "Re: 악보 부탁드립니다", body: "요청하신 악보 보내드립니다.", questions: [] };
const sink = () => {
	const sent: string[] = [];
	return { sent, send: (_target: string, text: string) => void sent.push(text) };
};
const recorder = () => {
	const calls: string[][] = [];
	const run: Runner = async (argv) => {
		calls.push(argv);
		return { code: 0, stdout: argv.includes("draft") ? "초안 저장: d-1" : "ok", stderr: "" };
	};
	return { calls, run };
};

test("a reply that promises a file on a webmail site says the site cannot attach", async () => {
	enable(env);
	expect(canAttach("corp")).toBe(false);
	const out = sink();
	await offerMailDraft(scoreMail, { send: out.send, call: fakeModel([j(scoreReply)]).call });
	expect(out.sent[0]).toContain(`> 첨부: 없음 (${CANNOT_ATTACH} · 본문에는 보낸다고 썼어요)`);
	const card = parseDraftApproval(out.sent[0]!)!;
	expect(card.attachments).toBeUndefined();
	expect(card.warning).toBe(CANNOT_ATTACH_WARNING);
});

test("files staged on a webmail draft are named as missing and the send is refused", async () => {
	enable(env);
	await offerMailDraft(scoreMail, { send: sink().send, call: fakeModel([j(scoreReply)]).call });
	const rec = listDrafts()[0]!;
	writeFileSync(join(files, "캐논.pdf"), "pdf");
	addStagedFile(rec.id, join(files, "캐논.pdf"));
	const text = askText(rec, []);
	expect(text).toContain(`> 첨부: 없음 (${CANNOT_ATTACH} · 빠진 파일: 캐논.pdf · 본문에는 보낸다고 썼어요)`);
	expect(text).toContain("파일이 붙어 있어 보내지 않아요");
	expect(parseDraftApproval(text)!.attachments).toBeUndefined();
	const r = recorder();
	const sent = await sendWith(rec, r.run);
	expect(sent.ok).toBe(false);
	expect(sent.message).toContain("첨부파일을 보낼 수 없어서");
	expect(r.calls).toEqual([]);
});

test("a text reply of a webmail site goes through that site's draft, approve and send", async () => {
	enable(env);
	await offerMailDraft({ ...scoreMail, key: "corp-8", id: "8", subject: "회의 일정", body: "회의 언제 할까요?" }, { send: sink().send, call: fakeModel([j({ ...goodReply, to: "stu@example.com" })]).call });
	const rec = listDrafts()[0]!;
	expect(askText(rec, [])).toMatch(/^> 첨부: 없음$/m);
	const r = recorder();
	expect((await sendWith(rec, r.run)).ok).toBe(true);
	expect(r.calls.map((c) => c.slice(2, 4))).toEqual([["corp", "draft"], ["corp", "approve"], ["corp", "send"]]);
});

test("a zele reply keeps the plain 첨부: 없음 row", async () => {
	enable(env);
	const out = sink();
	await offerMailDraft(mailFixture, { send: out.send, call: fakeModel([j(goodReply)]).call });
	expect(out.sent[0]).toMatch(/^> 첨부: 없음$/m);
	expect(out.sent[0]).not.toContain(CANNOT_ATTACH);
	expect(parseDraftApproval(out.sent[0]!)!.warning).toBeUndefined();
});
