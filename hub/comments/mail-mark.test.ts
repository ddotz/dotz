import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, type DraftRec } from "../../features/reply-drafts/lib/store.ts";
import { approvalHash } from "../approval-send.ts";
import { DATA_DIR } from "../config.ts";
import { resetOwnAddresses, setOwnAddresses } from "../mail-state.ts";
import { mailByKey, mailCard, mailTargets, postMail, setMailReply, setMailSuggest, unrepliedMails, type MailDeps } from "../mail.ts";
import { mailAdapter } from "../reply-mail.ts";
import { mailAnsweredLookup, markCommentReplied } from "./mail-mark.ts";

const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {} };
const AT = "2026-11-19T03:04:05.000Z";
let seq = 0;
const uid = () => `18c2f${Date.now().toString(16)}${++seq}`;
let dir: string;
const savedDir = process.env.DOTZ_DIR;
beforeEach(() => {
	setOwnAddresses("zele", ["me@example.com"]);
	dir = mkdtempSync(join(tmpdir(), "mail-comment-mark-"));
	process.env.DOTZ_DIR = dir;
});
afterEach(() => {
	resetOwnAddresses();
	rmSync(dir, { recursive: true, force: true });
	if (savedDir === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = savedDir;
});

async function owedMail(id = uid()) {
	const { key } = await postMail({ source: "zele", id, messageId: `m-${id}`, from: "Fan <fan@example.com>", to: "Me <me@example.com>", subject: "자료 요청", body: "자료를 보내 주실 수 있나요?" }, deps);
	setMailReply(key, "need");
	setMailSuggest(key, { kind: "reply-draft", label: "답장 초안", ref: `R${id}`, state: "draft" });
	return { id, key };
}
const draftOf = (id: string, key: string): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", account: "me@example.com", mailId: key, ref: key, to: "fan@example.com", subject: "Re: 자료 요청", body: "보내드릴게요", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "Fan <fan@example.com>", text: "자료를 보내 주실 수 있나요?", subject: "자료 요청" } }) as unknown as DraftRec;

test("CM-13 a comment reply marks the mail of the matched thread with its time, and its reply state, chip and place in the list stay", async () => {
	const { id, key } = await owedMail();
	const before = mailCard(mailByKey(key)!, true), at = Date.parse(mailByKey(key)!.at);
	const order = mailTargets(), owed = unrepliedMails(new Set(), at).map(m => m.key);
	expect([before.reply, owed.includes(key)]).toEqual(["draft", true]);
	expect(markCommentReplied(id, AT)).toEqual({ key, fresh: true });
	expect(mailCard(mailByKey(key)!, true)).toEqual({ ...before, commentReplyAt: AT });
	expect(mailTargets()).toEqual(order);
	expect(unrepliedMails(new Set(), at).map(m => m.key)).toEqual(owed);
});

test("CM-13 the mark is written to the stored mail list, so a restarted gateway reads it", async () => {
	const { id, key } = await owedMail();
	markCommentReplied(id, AT);
	const stored = JSON.parse(readFileSync(join(DATA_DIR, "mail-conversations.json"), "utf8")) as { key: string; commentReplyAt?: string }[];
	expect(stored.find(r => r.key === key)?.commentReplyAt).toBe(AT);
});

test("CM-13 a thread no mail is recorded under, or a mail the owner sent, gets no mark", async () => {
	const missing = uid();
	expect(markCommentReplied(missing, AT)).toBeUndefined();
	expect(mailByKey(`zele-${missing}`)).toBeUndefined();
	const out = uid();
	const { key } = await postMail({ source: "zele", id: out, from: "Me <me@example.com>", to: "Fan <fan@example.com>", subject: "안내", body: "안내드려요", direction: "out" }, deps);
	expect(markCommentReplied(out, AT)).toBeUndefined();
	expect(mailCard(mailByKey(key)!).commentReplyAt).toBeUndefined();
});

test("CM-13 an older record without the mark reads as no mark on its row and on its reply draft card", async () => {
	const { key } = await owedMail();
	expect("commentReplyAt" in mailCard(mailByKey(key)!)).toBe(false);
	addDraft(draftOf("RCM13A", key));
	expect((await mailAdapter(undefined, mailByKey).get("RCM13A"))!.answeredElsewhere).toBeUndefined();
});

test("CM-13 the mail's reply draft card says 댓글로 이미 답했어요 once the mark lands, a card made after it too, and the approved version does not change", async () => {
	const { id, key } = await owedMail();
	const cards = mailAdapter(undefined, mailByKey);
	addDraft(draftOf("RCM13B", key));
	const open = (await cards.get("RCM13B"))!;
	expect(open.answeredElsewhere).toBeUndefined();
	markCommentReplied(id, AT);
	const marked = (await cards.get("RCM13B"))!;
	expect(marked.answeredElsewhere).toEqual({ via: "comment", at: Date.parse(AT) });
	expect(approvalHash(marked)).toBe(approvalHash(open));
	addDraft(draftOf("RCM13C", key));
	expect((await cards.list()).find(v => v.ref === "RCM13C")?.answeredElsewhere).toEqual({ via: "comment", at: Date.parse(AT) });
});

test("CM-13 the first mark stays: a later comment reply to the same writer neither moves nor rewrites it", async () => {
	const { id, key } = await owedMail();
	markCommentReplied(id, AT);
	expect(markCommentReplied(id, "2026-11-20T00:00:00.000Z")).toEqual({ key, fresh: false });
	expect(mailByKey(key)!.commentReplyAt).toBe(AT);
});

test("CM-13 a matched mail counts as answered by mail when its record says 답장함 or a reply draft of it was sent, and not before", async () => {
	const replied = await owedMail(), drafted = await owedMail(), waiting = await owedMail();
	setMailReply(replied.key, "sent");
	const answered = mailAnsweredLookup(() => new Set([drafted.key]));
	expect([replied.id, drafted.id, waiting.id, uid()].map(answered)).toEqual([true, true, false, false]);
});
