// The send gate on a mail whose words and files disagree (hub/attach-check.ts): a plain 1) 보내기 is refused with the reasons and the draft stays pending,
// the 4th option 이대로 보내기 sends it as it is, and `draft.ts attach / detach` fix the files. The sender is a fake: nothing leaves this machine.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsAttachment } from "../../../hub/attach-claim.ts";
import { attachIssues } from "../../../hub/attach-check.ts";
import { parseDecisions } from "../../../hub/choices.ts";
import { ATTACH_REFUSED, parseDraftApproval } from "../../../hub/draft-approval.ts";
import { generateReply, type ModelCall, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { runDraft } from "../bin/draft.ts";
import { askText, draftAttachIssues, sendDraft } from "../lib/flow.ts";
import { paths } from "../lib/settings.ts";
import { addStagedFile, stagedFiles } from "../lib/staged.ts";
import { addDraft, type DraftRec, getDraft } from "../lib/store.ts";
import { enable, setupEnv } from "./helpers.ts";
import { mailHash } from "../lib/view.ts";
import { appendSealed } from "../../../hub/approval-seal.ts";

const env = setupEnv();
const lib = mkdtempSync(join(tmpdir(), "rd-gate-lib-"));
afterAll(() => {
	env.cleanup();
	rmSync(lib, { recursive: true, force: true });
});
writeFileSync(join(lib, "alpha-song.pdf"), "pdf bytes");
writeFileSync(join(lib, "beta-other.pdf"), "pdf bytes");
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "outbox.jsonl"), join(env.dir, "draft-files"), join(env.dir, "custom", "reply-drafts", "sending")]) rmSync(p, { force: true, recursive: true });
	enable(env, { attachFolders: { mail: lib } });
});

let n = 0;
function draft(body: string, extra: Partial<DraftRec> = {}): DraftRec {
	const id = `G${++n}`;
	const rec: DraftRec = { id, kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: `ref-${id}`, to: "teacher@example.com", subject: "Re: alpha-song 문서", body, status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "teacher@example.com", text: "alpha-song 문서 부탁드립니다" } as never, ...extra };
	addDraft(rec);
	return rec;
}
// A pick names the version the card showed: the draft as stored when it is made.
const choose = (id: string, k: number, label: string) =>
	appendSealed(join(env.dir, "inbox.jsonl"), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: `${k}) ${label}`, picks: [{ q: `이 답장 보낼까요? (${id})`, n: k, label, hash: mailHash(getDraft(id)!) }] });
function fakeSend() {
	const sent: string[] = [];
	return { sent, send: async (r: DraftRec) => (sent.push(r.id), { ok: true, message: "보냈어요" }) };
}
const PROMISE = "alpha-song 문서 보내드립니다.";

describe("sendDraft with a card posted in a work channel", () => {
	const at = "ch:700000000000000009";
	const log = (file: string, e: Record<string, unknown>, ms: number) => (file === "inbox.jsonl" ? appendSealed : (f: string, o: Record<string, unknown>) => appendFileSync(f, `${JSON.stringify(o)}\n`))(join(env.dir, file), { ts: new Date(Date.now() + ms).toISOString(), ...e });
	const posted = (rec: DraftRec) => log("outbox.jsonl", { kind: "out", source: "orchestrator", target: at, text: askText(rec, []) }, 1000);
	// Typed chat is the model's to read (the reply intent design, 2026-11-16): the gate counts the owner's pick only.
	test("the card alone and his typed answer under it send nothing; his pick sends once", async () => {
		const rec = draft("확인했습니다.", { item: { kind: "mail", from: "teacher@example.com", text: "안부 인사드립니다" } as never });
		posted(rec);
		const f = fakeSend();
		expect((await sendDraft(rec.id, f)).ok).toBe(false);
		log("inbox.jsonl", { kind: "message", source: "discord", channel: at, text: "1) 보내기" }, 2000);
		expect((await sendDraft(rec.id, f)).ok).toBe(false);
		expect(f.sent).toEqual([]);
		choose(rec.id, 1, "보내기");
		expect((await sendDraft(rec.id, f)).ok).toBe(true);
		expect(f.sent).toEqual([rec.id]);
	});
	test("a question under the card, or a typed send in another channel, sends nothing", async () => {
		const rec = draft("확인했습니다.");
		posted(rec);
		log("inbox.jsonl", { kind: "message", source: "discord", channel: at, text: "보내?" }, 2000);
		log("inbox.jsonl", { kind: "message", source: "discord", channel: "ch:700000000000000008", text: "보내" }, 3000);
		const f = fakeSend();
		expect((await sendDraft(rec.id, f)).ok).toBe(false);
		expect(f.sent).toEqual([]);
	});
});

describe("sendDraft with a mail whose files disagree with its words", () => {
	test("1) 보내기 is refused with the reasons, nothing is sent, and the draft stays pending", async () => {
		const rec = draft(PROMISE);
		choose(rec.id, 1, "보내기");
		const s = fakeSend();
		const r = await sendDraft(rec.id, { send: s.send });
		expect(r.ok).toBe(false);
		expect(r.text).toStartWith(`${ATTACH_REFUSED} 본문에 문서 파일을 보낸다고 썼지만 첨부파일이 없어요`);
		expect(r.text).toContain("이대로 보내기");
		expect(s.sent).toEqual([]);
		expect(getDraft(rec.id)!.status).toBe("pending");
	});

	test("4) 이대로 보내기 sends the same draft as it is", async () => {
		const rec = draft(PROMISE);
		choose(rec.id, 4, "이대로 보내기");
		const s = fakeSend();
		expect((await sendDraft(rec.id, { send: s.send })).ok).toBe(true);
		expect(s.sent).toEqual([rec.id]);
		expect(getDraft(rec.id)!.status).toBe("sent");
	});

	test("a typed 보내 or 이대로 보내 in the draft's conversation sends nothing: only the 4) 이대로 보내기 pick does", async () => {
		const typed = (id: string, text: string) => appendSealed(join(env.dir, "inbox.jsonl"), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", channel: `mail:ref-${id}`, text });
		const rec = draft(PROMISE);
		typed(rec.id, "보내");
		typed(rec.id, "이대로 보내");
		const s = fakeSend();
		expect((await sendDraft(rec.id, { send: s.send })).ok).toBe(false);
		expect([s.sent, getDraft(rec.id)!.status]).toEqual([[], "pending"]);
	});

	test("with the file on the draft, 1) 보내기 sends", async () => {
		const rec = draft(PROMISE);
		addStagedFile(rec.id, join(lib, "alpha-song.pdf"));
		choose(rec.id, 1, "보내기");
		const s = fakeSend();
		expect((await sendDraft(rec.id, { send: s.send })).ok).toBe(true);
		expect(s.sent).toEqual([rec.id]);
	});

	test("a file chosen but not on the draft yet holds the send, by name", async () => {
		const rec = draft(PROMISE, { wantFiles: [{ name: "beta-other.pdf", path: join(lib, "not-here", "beta-other.pdf") }] });
		addStagedFile(rec.id, join(lib, "alpha-song.pdf"));
		expect(draftAttachIssues(getDraft(rec.id)!)).toEqual(["아직 못 붙인 파일: beta-other.pdf"]);
		choose(rec.id, 1, "보내기");
		const s = fakeSend();
		const r = await sendDraft(rec.id, { send: s.send });
		expect([r.ok, s.sent]).toEqual([false, []]);
		expect(r.text).toContain("아직 못 붙인 파일: beta-other.pdf");
	});

	test("a wanted file that got on the draft another way no longer holds the send", () => {
		const rec = draft(PROMISE, { wantFiles: [{ name: "alpha-song.pdf", path: join(lib, "alpha-song.pdf") }] });
		addStagedFile(rec.id, join(lib, "alpha-song.pdf"));
		expect(draftAttachIssues(getDraft(rec.id)!)).toEqual([]);
	});

	test("the reply + mail card's mail: withReply is refused unless the owner picked as-is", async () => {
		const rec = draft(PROMISE);
		const s = fakeSend();
		const refused = await sendDraft(rec.id, { send: s.send }, { withReply: true });
		expect([refused.ok, refused.text.startsWith(ATTACH_REFUSED), s.sent]).toEqual([false, true, []]);
		expect((await sendDraft(rec.id, { send: s.send }, { withReply: true, asIs: true })).ok).toBe(true);
		expect(s.sent).toEqual([rec.id]);
	});

	test("a source that cannot carry files, and a chat draft, have nothing to check", () => {
		expect(draftAttachIssues(draft(PROMISE, { source: "webmail:site-one" }))).toEqual([]);
		expect(draftAttachIssues(draft(PROMISE, { kind: "comment" }))).toEqual([]);
	});
});

const FILE_CLAIMS: [string, boolean][] = [
	["견적서 보내드립니다.", true],
	["견적서를 첨부합니다.", true],
	["견적서를 첨부했습니다.", true],
	["견적서 첨부드립니다.", true],
	["견적서 보내드렸습니다.", true],
	["견적서는 아래와 같이 보냈습니다.", true],
	["견적서 첨부해서 보냅니다", true],
	["PDF로 보내드릴게요", true],
	["Please find the attached quote.", true],
	["I've attached the quote.", true],
	["See attached.", true],
	["Attached is the quote.", true],
	["I'll send the PDF tomorrow.", true],
	["Here is the invoice you asked for.", true],
	["계약 서류 보내드립니다.", true],
	["요청하신 wav 보내드립니다.", true],
	["견적서 송부드립니다.", true],
	["견적서를 송부합니다.", true],
	["견적서를 송부했습니다.", true],
	["견적서 첨부드렸습니다.", true],
	["견적서를 첨부해 드렸습니다.", true],
	["견적서를 발송했습니다.", true],
	["견적서를 발송합니다.", true],
	["자료 공유드립니다.", true],
	["I have enclosed the quote.", true],
	["Enclosed is the quote.", true],
	["Please see the attachment.", true],
	["Thanks for the attached file.", false],
	["I received the attached quote.", false],
	["In the attached file you sent, row 3 is wrong.", false],
	["Regarding the file you attached, thanks.", false],
	["I will not be attaching anything.", false],
	["견적서를 첨부하지 못했어요.", false],
	["첨부 파일은 없습니다.", false],
	["이름을 알려 주시면 보내드리겠습니다.", false],
	["견적서입니다.", false],
	["아래 파일 확인해 주세요.", false],
];

describe("a draft with no file: the gate refuses what the card warns about", () => {
	test("attachIssues reports a missing file for exactly the phrases the card calls a claim", () => {
		for (const [body, claimed] of FILE_CLAIMS) {
			expect([body, claimsAttachment(body)]).toEqual([body, claimed]);
			expect([body, attachIssues({ body, files: [], request: "안부 인사드립니다" }).some(i => i.kind === "missing")]).toEqual([body, claimed]);
		}
	});

	test.each(["견적서를 첨부했습니다.", "I've attached the quote."])("%s: 1) 보내기 is refused, 이대로 보내기 sends", async body => {
		const rec = draft(body, { item: { kind: "mail", from: "teacher@example.com", text: "안부 인사드립니다" } as never });
		choose(rec.id, 1, "보내기");
		const s = fakeSend();
		const refused = await sendDraft(rec.id, { send: s.send });
		expect([refused.ok, refused.code, s.sent, getDraft(rec.id)!.status]).toEqual([false, "attach_mismatch", [], "pending"]);
		expect((await sendDraft(rec.id, { send: s.send }, { withReply: true, asIs: true })).ok).toBe(true);
		expect(s.sent).toEqual([rec.id]);
	});

	test("a reply's echoed subject is the received mail's words, not a claim; a subject the draft wrote is", () => {
		const body = "확인했습니다. 곧 연락드릴게요.";
		for (const subject of ["Re: 견적서 첨부합니다", "RE: Fwd: Please find the attached quote", "회신: 견적서 보내드립니다"]) expect([subject, attachIssues({ subject, body, files: [], request: "안부 인사드립니다" })]).toEqual([subject, []]);
		expect(attachIssues({ subject: "견적서 첨부합니다", body, files: [], request: "안부 인사드립니다" }).map(i => i.kind)).toEqual(["missing"]);
	});

	test("a subject that echoes the received mail behind a tag or a reply word is not a claim of the draft", () => {
		const body = "확인했습니다. 곧 연락드릴게요.";
		for (const subject of ["[External] Re: 견적서 첨부합니다", "[Re] 견적서 첨부합니다", "Reply: 견적서 보내드립니다", "[External] [Ext] RE: Fwd: Please find the attached quote"]) expect([subject, attachIssues({ subject, body, files: [], request: "안부 인사드립니다" })]).toEqual([subject, []]);
		for (const subject of ["[견적] 견적서 첨부합니다", "[External] 견적서 첨부합니다"]) expect([subject, attachIssues({ subject, body, files: [], request: "안부 인사드립니다" }).map(i => i.kind)]).toEqual([subject, ["missing"]]);
	});

	test("a phrase that refers back to an earlier mail's file is noted on the card but holds no send", () => {
		for (const body of ["보내드린 문서는 출처를 표기해 주세요.", "보낸 PDF는 확인해 주세요"]) {
			expect([body, claimsAttachment(body)]).toEqual([body, true]);
			expect([body, attachIssues({ body, files: [], request: "안부 인사드립니다" })]).toEqual([body, []]);
		}
		expect(attachIssues({ body: "보내드린 견적서 외에 계약서도 첨부합니다.", files: [], request: "안부 인사드립니다" }).map(i => i.kind)).toEqual(["missing"]);
	});
});

describe("a mail that asks for a file, answered with a draft that has none", () => {
	const asking = "alpha-song 문서 보내주세요. 부탁드립니다.";
	const item = { kind: "mail", from: "teacher@example.com", text: asking } as never;

	test("a neutral body is a skipped issue naming the kind asked for", () => {
		expect(attachIssues({ subject: "견적서 요청", body: "확인했습니다. 곧 연락드릴게요.", files: [], request: "견적서 보내주세요. 부탁드립니다." })).toEqual([{ kind: "skipped", text: "받은 메일이 요청한 문서 파일이 안 붙었어요" }]);
	});

	test("a body that says it will send later, or a mail that asks for nothing, has no issue", () => {
		expect(attachIssues({ body: "이름을 알려 주시면 보내드리겠습니다.", files: [], request: asking })).toEqual([]);
		expect(attachIssues({ body: "확인했습니다. 곧 연락드릴게요.", files: [], request: "안부 인사드립니다" })).toEqual([]);
	});

	test("a mail that asks to look at a file it attached, or a subject alone, does not ask for one back", () => {
		const body = "확인했습니다. 감사합니다.";
		for (const request of ["첨부한 계약서 확인 부탁드립니다.", "계약서에 서명 후 회신 부탁드립니다.", "Please review the attached PDF.", "문서 내용 확인 부탁드립니다.", "청구서 확인해 주세요."]) expect([request, attachIssues({ subject: "Re: 문의", body, files: [], request })]).toEqual([request, []]);
		for (const subject of ["Re: 견적서 검토 요청", "Re: 사진 보내주세요"]) expect([subject, attachIssues({ subject, body, files: [], request: "안녕하세요. 내일 뵙겠습니다." })]).toEqual([subject, []]);
		for (const request of ["견적서 보내 주세요.", "계약서 송부 부탁드립니다.", "음원 공유해 주세요.", "견적서를 받을 수 있을까요?", "Please send me the PDF."]) expect([request, attachIssues({ subject: "Re: 문의", body, files: [], request }).map(i => i.kind)]).toEqual([request, ["skipped"]]);
	});

	test("only a sentence that talks about sending and says later or if exempts: an unrelated closer or a price note does not", () => {
		const request = "견적서 보내주세요. 부탁드립니다.";
		for (const body of ["I will send the file later.", "Will send the quote separately.", "견적서는 내일 따로 보내드리겠습니다.", "확인했습니다. 나중에 보내드릴게요."]) expect([body, attachIssues({ body, files: [], request })]).toEqual([body, []]);
		for (const body of ["확인했습니다. 더 필요하시면 말씀해 주세요.", "확인했습니다. 문의 사항 있으시면 연락 주세요.", "판매 가격은 별도입니다. 확인했습니다.", "괜찮으면 내일 통화해요. 확인했습니다.", "견적서를 따로 첨부했습니다."]) expect([body, attachIssues({ body, files: [], request }).map(i => i.kind)]).toEqual([body, [body.includes("첨부했") ? "missing" : "skipped"]]);
		expect(attachIssues({ body: "서류는 내일 따로 보내드리겠습니다.", files: [], request: "안부 인사드립니다" })).toEqual([]);
		expect(attachIssues({ body: "견적서 보내드립니다. 나머지는 내일 따로 보내드리겠습니다.", files: [], request: "안부 인사드립니다" }).map(i => i.kind)).toEqual(["missing"]);
	});

	test("draft generation does not call the model a second time for a file the draft deliberately left off", async () => {
		let calls = 0;
		const call: ModelCall = async () => {
			calls++;
			return `\`\`\`json\n${JSON.stringify({ action: "draft", reason: "asks a file", to: "kim@example.com", subject: "Re: 문의", body: "어떤 곡인지 알려 주세요.", questions: [], files: [] })}\n\`\`\``;
		};
		const style: ReplyStyle = { samples: ["확인해 보고 말씀드릴게요."], rules: [], corrections: [], forbidden: [] };
		const r = await generateReply({ kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "문의", text: "견적서 보내주세요. 부탁드립니다.", candidates: ["봄노래 문서.pdf"] }, style, call);
		expect([calls, r.tries, r.action === "draft" && r.draft.body]).toEqual([1, 1, "어떤 곡인지 알려 주세요."]);
	});

	test("1) 보내기 is refused, 이대로 보내기 sends", async () => {
		const rec = draft("확인했습니다. 곧 연락드릴게요.", { item });
		choose(rec.id, 1, "보내기");
		const s = fakeSend();
		const refused = await sendDraft(rec.id, { send: s.send });
		expect([refused.ok, refused.code, s.sent]).toEqual([false, "attach_mismatch", []]);
		expect(refused.text).toContain("받은 메일이 요청한 문서 파일이 안 붙었어요");
		expect((await sendDraft(rec.id, { send: s.send }, { withReply: true, asIs: true })).ok).toBe(true);
		expect(s.sent).toEqual([rec.id]);
	});
});

describe("the card every rendering carries", () => {
	test("askText shows the finding and the 4th option each time it is rendered, and not once the file is on", () => {
		const rec = draft(PROMISE);
		for (const text of [askText(rec, ["the subject must start with 'Re:'"]), askText(rec, [])]) {
			expect(text).toContain("-# ⚠️ 첨부 확인: 본문에 문서 파일을 보낸다고 썼지만 첨부파일이 없어요");
			expect(parseDraftApproval(text)?.attachIssues).toHaveLength(1);
			expect(parseDecisions(text).blocks[0]!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기", "이대로 보내기"]);
		}
		addStagedFile(rec.id, join(lib, "alpha-song.pdf"));
		const fixed = askText(rec, []);
		expect(fixed).not.toContain("첨부 확인");
		expect(parseDecisions(fixed).blocks[0]!.options.map(o => o.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	});
});

describe("draft.ts attach / detach", () => {
	test("attach by a name in the 첨부 파일 폴더 puts the file on the draft and prints the refreshed card; detach by number takes it off", async () => {
		const rec = draft(PROMISE);
		const on = await runDraft(["attach", rec.id, "alpha-song.pdf"], "");
		expect(on.code).toBe(0);
		expect(stagedFiles(rec.id).map(f => f.name)).toEqual(["alpha-song.pdf"]);
		expect(on.lines[0]).toContain("> 첨부: alpha-song.pdf");
		expect(on.lines[0]).not.toContain("첨부 확인");
		const off = await runDraft(["detach", rec.id, "1"], "");
		expect(off.code).toBe(0);
		expect(stagedFiles(rec.id)).toEqual([]);
		expect(off.lines[0]).toContain("-# ⚠️ 첨부 확인");
	});

	test("detach by name takes off a file that was waited for and will not come", async () => {
		const rec = draft(PROMISE, { wantFiles: [{ name: "beta-other.pdf", path: join(lib, "gone.pdf") }] });
		addStagedFile(rec.id, join(lib, "alpha-song.pdf"));
		expect(draftAttachIssues(getDraft(rec.id)!)).toEqual(["아직 못 붙인 파일: beta-other.pdf"]);
		expect((await runDraft(["detach", rec.id, "beta-other.pdf"], "")).code).toBe(0);
		expect(draftAttachIssues(getDraft(rec.id)!)).toEqual([]);
		expect(stagedFiles(rec.id).map(f => f.name)).toEqual(["alpha-song.pdf"]);
	});

	test("attach by an absolute path, detach by name; a file that is not there or a draft that is not pending says so", async () => {
		const rec = draft(PROMISE);
		const elsewhere = mkdtempSync(join(tmpdir(), "rd-gate-file-"));
		mkdirSync(elsewhere, { recursive: true });
		writeFileSync(join(elsewhere, "extra-one.pdf"), "x");
		expect((await runDraft(["attach", rec.id, join(elsewhere, "extra-one.pdf")], "")).code).toBe(0);
		expect((await runDraft(["detach", rec.id, "extra-one.pdf"], "")).code).toBe(0);
		expect(stagedFiles(rec.id)).toEqual([]);
		rmSync(elsewhere, { recursive: true, force: true });
		expect((await runDraft(["attach", rec.id, "nothing-here.pdf"], "")).code).toBe(1);
		expect((await runDraft(["detach", rec.id, "9"], "")).code).toBe(1);
		expect((await runDraft(["attach", "NOPE", "alpha-song.pdf"], "")).code).toBe(1);
	});
});
