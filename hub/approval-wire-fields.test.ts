// GET /api/approvals carries, for a mail draft, what the 빠른 처리 screen shows beside the draft (the mail it answers, the sending account, the thread), so the
// screen needs no request per card. Own conversation, so the cards of approval-wire-out.test.ts do not meet these. Names and texts are placeholders.
import { afterAll, expect, test } from "bun:test";
import { draftApprovalBlock } from "./draft-approval.ts";
import { ignoreNotice, listNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { approvalRoute } from "./approval-wire.ts";
import { deleteMail, mailKey, recordMail } from "./mail.ts";
import { addDraft, newId } from "../features/reply-drafts/lib/store.ts";

const CONV = "mail:af-test";
const SOURCE = "af-source";
const route = (path: string) =>
	approvalRoute(new Request(`http://local${path}`), new URL(`http://local${path}`), { login: "owner@example.com", triageMin: 3, deliver: async () => {} });
type Card = { ref: string; kind: string; original?: { from: string; at: string; subject?: string; text: string; cut?: true; files: number }; account?: { label: string; many: boolean }; thread?: { earlier: number; newer: boolean }; comment?: unknown };
const cards = async (): Promise<Card[]> => ((await (await route("/api/approvals"))!.json()) as { groups: { cards: Card[] }[] }).groups.flatMap(g => g.cards).filter(c => refs.includes(c.ref));
const refs: string[] = [];
const draft = (mailId: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
	const id = newId(), ref = mailKey(SOURCE, mailId);
	addDraft({ id, kind: "mail", app: "mail", source: SOURCE, mailId, ref, to: "friend@example.com", body: "답장이에요", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", ...item } as never, ...extra } as never);
	refs.push(id);
	return id;
};
const post = (ref: string, conv = CONV, over: Record<string, unknown> = {}) => out(conv, `[ask] 답장 초안이에요\n${draftApprovalBlock({ to: "friend@example.com", toLabel: "받는이", body: "답장이에요", ref, subject: "Re: 회의", question: "이대로 보낼까요?", ...over })}`);

afterAll(() => {
	for (const n of listNotices(500).items as any[]) if (n.decision?.state === "open" && n.decision.to.startsWith(CONV)) ignoreNotice(n.id);
	for (const k of ["m0", "m1", "m2", "m3"]) deleteMail(mailKey(SOURCE, k));
});

test("a mail draft's card carries the mail it answers (its start, cut at 60 characters), the sending account and the thread, in the one list call", async () => {
	const ref = draft("m1", { subject: "회의", text: "가".repeat(2600) });
	recordMail({ key: mailKey(SOURCE, "m1"), source: SOURCE, id: "m1", subject: "회의", from: "friend@example.com", at: "2019-12-31T00:00:00.000Z", thread: "th-fields", msg: "a2", reopenedAt: "2020-02-01T00:00:00.000Z" } as never);
	recordMail({ key: mailKey(SOURCE, "m0"), source: SOURCE, id: "m0", subject: "회의", from: "friend@example.com", at: "2019-12-30T00:00:00.000Z", thread: "th-fields" } as never);
	await post(ref);
	const card = (await cards()).find(c => c.ref === ref)!;
	expect(card.kind).toBe("mail");
	expect(card.original).toMatchObject({ from: "friend@example.com", subject: "회의", cut: true, files: 0 });
	expect(card.original!.text).toHaveLength(60);
	expect(card.account).toEqual({ label: expect.any(String), many: false });
	expect(card.thread).toEqual({ earlier: 1, newer: true });
});

test("a short mail is not marked cut, a mail with no thread record has no thread, and a new mail answers nothing", async () => {
	const short = draft("m2", { text: "한 줄이에요" });
	const fresh = draft("m3", { text: "" }, { compose: true });
	await post(short);
	await post(fresh, `${CONV}-new`);
	await out(CONV, "정리했어요", undefined, { source: "gateway" });
	await out(`${CONV}-new`, "정리했어요", undefined, { source: "gateway" });
	const got = await cards();
	const a = got.find(c => c.ref === short)!;
	expect(a.original).toMatchObject({ text: "한 줄이에요", files: 0 });
	expect(a.original).not.toHaveProperty("cut");
	expect(a.thread).toBeUndefined();
	const b = got.find(c => c.ref === fresh)!;
	expect(b).toBeDefined();
	expect(b.original).toBeUndefined();
});
