import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, getDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { accountHold } from "../features/reply-drafts/lib/flow.ts";
import { zeleAccountOf } from "../features/reply-drafts/lib/senders.ts";
import { mailHash, mailView } from "../features/reply-drafts/lib/view.ts";
import { approvalHash } from "./approval-send.ts";
import { mailAdapter } from "./reply-mail.ts";

const dir = mkdtempSync(join(tmpdir(), "reply-card-account-"));
const before = process.env.DOTZ_DIR;
process.env.DOTZ_DIR = dir;
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	if (before === undefined) delete process.env.DOTZ_DIR;
	else process.env.DOTZ_DIR = before;
});
beforeEach(() => {
	rmSync(join(dir, "custom"), { recursive: true, force: true });
	rmSync(join(dir, "mail-conversations.json"), { force: true });
	mkdirSync(join(dir, "custom", "reply-drafts"), { recursive: true });
	writeFileSync(join(dir, "custom", "reply-drafts", "config.json"), JSON.stringify({ enabled: true }));
});
const rec = (id: string, ref: string, o: Partial<DraftRec> = {}): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", mailId: id, ref, to: "kim@example.com", subject: "Re: x", body: "본문", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", app: "mail", from: "Kim <kim@example.com>", text: "hi", subject: "x" }, ...o }) as unknown as DraftRec;
const stored = (account: string) => writeFileSync(join(dir, "mail-conversations.json"), JSON.stringify([{ key: "kh1", source: "zele", account }]));
const appAccount = (account: string) => writeFileSync(join(dir, "custom", "apps.json"), JSON.stringify({ mail: { app: "mail", filter: { account } } }));

test("a record with its own account: the card (adapter view), the CLI gate (mailHash) and the queue hash agree", async () => {
	addDraft(rec("RCA0001", "kh0", { account: "x@example.net" }));
	const view = (await mailAdapter().get("RCA0001"))!;
	expect(view.draft.account).toBe("x@example.net");
	expect(approvalHash(view)).toBe(mailHash(getDraft("RCA0001")!));
});

test("a record without an account shows the account the send resolves from the stored mail, and a change of it changes the hash", async () => {
	addDraft(rec("RCA0002", "kh1"));
	stored("x@example.net");
	const r = getDraft("RCA0002")!;
	const first = mailHash(r);
	expect(mailView(r).draft.account).toBe(zeleAccountOf(r)!);
	expect(mailView(r).draft.account).toBe("x@example.net");
	expect(approvalHash((await mailAdapter().get("RCA0002"))!)).toBe(first);
	stored("y@example.net");
	expect(mailView(r).draft.account).toBe("y@example.net");
	expect(mailHash(r)).not.toBe(first);
});

test("a record without an account of an app instance that names one shows it", async () => {
	addDraft(rec("RCA0003", "kh2"));
	appAccount("z@example.net");
	expect(mailView(getDraft("RCA0003")!).draft.account).toBe("z@example.net");
});

test("a send held for a missing account says so on the card; choosing the account later changes the hash", async () => {
	addDraft(rec("RCA0004", "kh3", { accounts: ["a@example.net", "b@example.net"] }));
	const r = getDraft("RCA0004")!;
	expect(accountHold(r)).toBeTruthy();
	const view = mailView(r);
	expect(view.draft.account).toBeUndefined();
	expect(view.draft.accountHeld).toBe(true);
	const held = mailHash(r);
	appAccount("b@example.net");
	expect(accountHold(r)).toBeUndefined();
	const after = mailView(r);
	expect(after.draft.account).toBe("b@example.net");
	expect(after.draft.accountHeld).toBeUndefined();
	expect(mailHash(r)).not.toBe(held);
});

test("a webmail draft names no account", async () => {
	addDraft(rec("RCA0005", "kh5", { source: "webmail:naver" }));
	appAccount("z@example.net");
	expect(mailView(getDraft("RCA0005")!).draft.account).toBeUndefined();
});
