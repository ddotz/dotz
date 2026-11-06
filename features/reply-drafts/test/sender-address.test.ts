import { afterAll, expect, test } from "bun:test";
import { offerMailDraft } from "../lib/offer.ts";
import { askText, ownerWarning, sendDraft } from "../lib/flow.ts";
import { addDraft, getDraft, listDrafts, type DraftRec } from "../lib/store.ts";
import { enable, fakeModel, j, pick, setupEnv } from "./helpers.ts";

// A mail source that reports the sender by a cut-off display name and no address (a webmail list view): the draft still goes to the
// sender's real address, read from the mail itself, and the owner never sees a lint line in English.
const env = setupEnv();
afterAll(env.cleanup);
enable(env, { apps: { mail: { auto: true } } });

const BODY = "안녕하세요. 자료 확인 부탁드립니다.\n\n감사합니다.\nJisoo Han (KR)\nEmail:\njisoo.han@audit.example\n\n보낸 사람: 홍길동 <me@corp.example>";
const mail = { key: "acme-1", target: "main", source: "acme", id: "1", subject: "Re: 자료 요청", from: "Jisoo Han (KR - A", to: "me@corp.example", body: BODY };
const reply = (to: string) => j({ action: "draft", reason: "asks", to, subject: "Re: 자료 요청", body: "확인했습니다.", questions: [] });

test("a name-only, cut-off sender gets a draft to the address the mail's own text names, with no recipient warning", async () => {
	const sent: string[] = [];
	const r = await offerMailDraft(mail, { send: (_t, text) => sent.push(text), call: fakeModel([reply("Jisoo Han (KR - A")]).call });
	expect(r).toBe("offered");
	const d = listDrafts().find(x => x.ref === "acme-1")!;
	expect(d.to).toBe("jisoo.han@audit.example");
	expect(d.item.from).toBe("Jisoo Han <jisoo.han@audit.example>");
	expect(sent[0]).toContain("> 받는이: jisoo.han@audit.example");
	expect(sent[0]).not.toContain("no recipient");
});

const stale = (over: Partial<DraftRec> = {}): DraftRec => ({ id: "ROLD1", kind: "mail", app: "mail", source: "acme", mailId: "2", ref: "acme-2", to: "Jisoo Han (KR - A", subject: "Re: 자료 요청", body: "확인했습니다.", status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", from: "Jisoo Han (KR - A", self: ["me@corp.example"], subject: "Re: 자료 요청", text: BODY }, ...over });

test("a draft made before the fix shows and sends with the recovered address; the stored draft is corrected once", async () => {
	addDraft(stale({ questions: ["The sender's email address is cut off at \"Jisoo Han KR - A\". Please enter the recipient address before sending.", "회신 기한"] }));
	const card = askText(getDraft("ROLD1")!, ["no recipient address in 'to'"]);
	expect(card).toContain("> 받는이: Jisoo Han <jisoo.han@audit.example>");
	expect(card).toContain("정할 것:\n- 회신 기한\n");
	expect(card).not.toContain("cut off");
	expect(askText(getDraft("ROLD1")!, ["no recipient address in 'to'"])).not.toContain("확인:");
	pick(env, "ROLD1", 1);
	const seen: DraftRec[] = [];
	const r = await sendDraft("ROLD1", { send: async rec => (seen.push(rec), { ok: true, message: "보냈어요" }) });
	expect(r.ok).toBe(true);
	expect(seen[0]!.to).toBe("Jisoo Han <jisoo.han@audit.example>");
	expect(getDraft("ROLD1")!.to).toBe("Jisoo Han <jisoo.han@audit.example>");
});

test("no address anywhere: the card asks for it in Korean and 보내기 is refused with a Korean reason, nothing sent", async () => {
	addDraft(stale({ id: "ROLD2", ref: "acme-3", item: { kind: "mail", from: "Jisoo Han (KR - A", self: ["me@corp.example"], subject: "Re: 자료 요청", text: "주소가 없는 본문" } }));
	expect(askText(getDraft("ROLD2")!, ["no recipient address in 'to'"])).toContain("확인: 받는 사람의 메일 주소를 찾지 못했어요");
	pick(env, "ROLD2", 1);
	let called = false;
	const r = await sendDraft("ROLD2", { send: async () => ((called = true), { ok: true, message: "" }) });
	expect(r).toMatchObject({ ok: false });
	expect(r.text).toContain("받는 사람의 메일 주소를 찾지 못했어요");
	expect(called).toBe(false);
});

test("every lint finding reads in Korean on the card", () => {
	for (const w of ["'me@x.co' is the user's own address", "'x@y.co' is not the sender, reply-to or a cc of the original", "the subject must start with 'Re:'", "the body is empty", "the body is 1300 characters; the limit is 1200", "the text contains a placeholder", "it uses the forbidden expression '절대'"])
		expect(ownerWarning(w)).toMatch(/[가-힣]/);
});
