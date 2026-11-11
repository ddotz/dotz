// The send gate on a mail whose words and files disagree (hub/attach-check.ts): a plain 1) 보내기 is refused with the reasons and the draft stays pending,
// the 4th option 이대로 보내기 sends it as it is, and `draft.ts attach / detach` fix the files. The sender is a fake: nothing leaves this machine.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisions } from "../../../hub/choices.ts";
import { ATTACH_REFUSED, parseDraftApproval } from "../../../hub/draft-approval.ts";
import { runDraft } from "../bin/draft.ts";
import { askText, draftAttachIssues, sendDraft } from "../lib/flow.ts";
import { paths } from "../lib/settings.ts";
import { addStagedFile, stagedFiles } from "../lib/staged.ts";
import { addDraft, type DraftRec, getDraft } from "../lib/store.ts";
import { enable, setupEnv } from "./helpers.ts";
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
const choose = (id: string, k: number, label: string) =>
	appendSealed(join(env.dir, "inbox.jsonl"), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", text: `${k}) ${label}`, picks: [{ q: `이 답장 보낼까요? (${id})`, n: k, label }] });
function fakeSend() {
	const sent: string[] = [];
	return { sent, send: async (r: DraftRec) => (sent.push(r.id), { ok: true, message: "보냈어요" }) };
}
const PROMISE = "alpha-song 문서 보내드립니다.";

describe("sendDraft with a card posted in a work channel", () => {
	const at = "ch:700000000000000009";
	const log = (file: string, e: Record<string, unknown>, ms: number) => (file === "inbox.jsonl" ? appendSealed : (f: string, o: Record<string, unknown>) => appendFileSync(f, `${JSON.stringify(o)}\n`))(join(env.dir, file), { ts: new Date(Date.now() + ms).toISOString(), ...e });
	const posted = (rec: DraftRec) => log("outbox.jsonl", { kind: "out", source: "orchestrator", target: at, text: askText(rec, []) }, 1000);
	test("the card alone sends nothing; his typed answer under it sends once", async () => {
		const rec = draft("확인했습니다.");
		posted(rec);
		const f = fakeSend();
		expect((await sendDraft(rec.id, f)).ok).toBe(false);
		expect(f.sent).toEqual([]);
		log("inbox.jsonl", { kind: "message", source: "discord", channel: at, text: "1) 보내기" }, 2000);
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

	test("a typed 이대로 보내 in the draft's conversation sends it as it is, where a typed 보내 is refused like the pick", async () => {
		const typed = (id: string, text: string) => appendSealed(join(env.dir, "inbox.jsonl"), { ts: new Date(Date.now() + 5000).toISOString(), kind: "message", source: "web", channel: `mail:ref-${id}`, text });
		const rec = draft(PROMISE);
		typed(rec.id, "보내");
		const s = fakeSend();
		expect((await sendDraft(rec.id, { send: s.send })).ok).toBe(false);
		typed(rec.id, "이대로 보내");
		expect((await sendDraft(rec.id, { send: s.send })).ok).toBe(true);
		expect(s.sent).toEqual([rec.id]);
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
		const rec = draft(PROMISE, { wantFiles: [{ name: "beta-other.pdf", path: join(lib, "beta-other.pdf") }] });
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
