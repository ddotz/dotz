// POST/GET /api/drafts/<ref>/recipients (hub/draft-recipients.ts): 답장 | 전체 답장 is computed from the recorded mail, a typed 받는 사람·참조
// is checked at the door, and the waiting approval notice is rewritten with the same lines so every card shows one list.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseDraftApproval } from "./draft-approval.ts";
import { draftRecipientsRoute } from "./draft-recipients.ts";
import { emit } from "./events.ts";
import { postMail, type MailDeps } from "./mail.ts";
import { resetOwnAddresses, setOwnAddresses } from "./mail-state.ts";
import { listNotices, resetNoticesForTest } from "./notices.ts";
import { askText } from "../features/reply-drafts/lib/flow.ts";
import { addDraft, getDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";

const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: () => undefined, wake: () => undefined };
let seq = 0;
// The one recorded mail every reply draft of this file answers (postMail keys a mail by source and id).
const REF = "plug-9";

const draft = (patch: Partial<DraftRec> = {}): DraftRec => ({
	id: `RR${++seq}`, kind: "mail", app: "mail", source: "plug", mailId: "9", ref: "plug-9", to: "kim@example.com", subject: "Re: 회의", body: "확인했습니다.", status: "pending", created: "2030-01-01T00:00:00.000Z",
	changes: [], questions: [], item: { kind: "mail", from: "Kim <kim@example.com>", to: ["me@example.net", "lee@example.com"], cc: ["park@example.com"], self: ["me@example.net"], subject: "회의", text: "회의 일정 문의" }, mode: "reply", ...patch,
});

// A recorded mail addressed to the owner and one colleague, with a 참조: what 전체 답장 reads.
const mail = () => postMail({ source: "plug", id: "9", subject: "회의", from: "Kim <kim@example.com>", to: "Me <me@example.net>, Lee <lee@example.com>", cc: "Park <park@example.com>", body: "회의 일정 문의" }, deps);

// The open send approval of the draft, the way the orchestrator posts it.
function ask(id: string): void {
	const rec = getDraft(id)!;
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "alert", text: askText(rec, []) } as never);
}

const post = (ref: string, body: unknown) => draftRecipientsRoute(new Request(`http://x/api/drafts/${ref}/recipients`, { method: "POST", body: JSON.stringify(body) }), ref);
const get = (ref: string) => draftRecipientsRoute(new Request(`http://x/api/drafts/${ref}/recipients`), ref);
const notice = (ref: string) => listNotices(300).items.find(n => n.decision?.draft?.ref === ref)!;

beforeAll(async () => void (await mail()));
beforeEach(() => {
	resetNoticesForTest();
	resetOwnAddresses();
	setOwnAddresses("config", ["me@example.net"]);
});

describe("답장 | 전체 답장", () => {
	test("전체 답장 takes the sender, the original's 받는 사람 and its 참조, without the owner", async () => {
		const rec = draft();
		addDraft(rec);
		expect((await get(rec.id).then(r => r.json())) as object).toEqual({ to: ["kim@example.com"], cc: [], mode: "reply", editable: true, reply: true });
		const r = (await post(rec.id, { mode: "all" }).then(x => x.json())) as { ok: boolean; to: string[]; cc: string[]; mode: string };
		expect(r).toEqual({ ok: true, to: ["kim@example.com", "lee@example.com"], cc: ["park@example.com"], mode: "all", editable: true, reply: true });
		expect(getDraft(rec.id)).toMatchObject({ to: "kim@example.com, lee@example.com", cc: ["park@example.com"], mode: "all" });
		expect((await post(rec.id, { mode: "reply" }).then(x => x.json())) as object).toMatchObject({ to: ["kim@example.com"], cc: [], mode: "reply" });
	});

	test("the waiting card is rewritten in place: its 받는이·참조 lines are the new ones, 제목 and body stay", async () => {
		const rec = draft();
		addDraft(rec);
		ask(rec.id);
		const before = notice(rec.id);
		expect(before.decision!.draft!.cc).toBeUndefined();
		await post(rec.id, { to: ["kim@example.com", "lee@example.com"], cc: ["park@example.com"] });
		const after = notice(rec.id);
		expect(after.id).toBe(before.id);
		expect(after.decision!.draft).toMatchObject({ to: "kim@example.com, lee@example.com", cc: ["park@example.com"] });
		expect(after.text).toContain("> 받는이: kim@example.com, lee@example.com\n> 참조: park@example.com\n");
		expect(after.text).toContain("> 제목: Re: 회의");
		expect(parseDraftApproval(after.text)!.cc).toEqual(["park@example.com"]);
		expect(parseDraftApproval(after.text)!.to).toBe("kim@example.com, lee@example.com");
	});
});

describe("what the owner types", () => {
	test("a typed 참조 that is not on the original is kept, and the draft is marked as his own list", async () => {
		const rec = draft();
		addDraft(rec);
		const r = (await post(rec.id, { cc: ["new@example.org"] }).then(x => x.json())) as { ok: boolean; cc: string[] };
		expect(r).toMatchObject({ ok: true, cc: ["new@example.org"] });
		expect(getDraft(rec.id)).toMatchObject({ cc: ["new@example.org"], ownerRecipients: true });
	});

	test("a bad address, the owner's own address and an empty 받는 사람 are refused with a Korean line and change nothing", async () => {
		const rec = draft();
		addDraft(rec);
		for (const [body, error] of [
			[{ to: ["kim"] }, "'kim'은(는) 메일 주소가 아니에요"],
			[{ cc: ["me@example.net"] }, "me@example.net은(는) 내 주소라서 받는 사람이 될 수 없어요"],
			[{ to: [] }, "받는 사람을 한 명 이상 남겨 주세요"],
		] as const) {
			const r = await post(rec.id, body);
			expect(r.status).toBe(400);
			expect(((await r.json()) as { error: string }).error).toBe(error);
		}
		expect(getDraft(rec.id)).toMatchObject({ to: "kim@example.com" });
	});
});

describe("only a pending mail draft", () => {
	test("a sent draft is refused, and the card reads it read only", async () => {
		const rec = draft({ status: "sent" });
		addDraft(rec);
		expect(((await get(rec.id).then(r => r.json())) as { editable: boolean }).editable).toBe(false);
		const r = await post(rec.id, { to: ["lee@example.com"] });
		expect(r.status).toBe(409);
		expect(((await r.json()) as { error: string }).error).toBe("이 초안은 이미 처리돼서 받는 사람을 바꿀 수 없어요");
		expect(getDraft(rec.id)!.to).toBe("kim@example.com");
	});

	test("an unknown draft is not found", async () => {
		expect((await get("Rnope")).status).toBe(200);
		expect((await get("Rnope").then(r => r.json())) as object).toMatchObject({ editable: false, reply: false });
		expect((await post("Rnope", { to: ["a@example.com"] })).status).toBe(404);
	});

	test("a new mail draft has no 답장 | 전체 답장 to pick", async () => {
		const rec = draft({ ref: `compose-${++seq}`, mailId: `compose-${seq}`, compose: true });
		addDraft(rec);
		expect((await get(rec.id).then(r => r.json())) as object).toMatchObject({ reply: false, editable: true });
		const r = await post(rec.id, { mode: "all" });
		expect(r.status).toBe(400);
		expect((await post(rec.id, { to: ["lee@example.com"] })).status).toBe(200);
	});
});
