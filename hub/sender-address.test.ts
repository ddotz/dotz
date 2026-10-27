import { expect, test as t2 } from "bun:test";
import { senderAddress, senderName, withSenderAddress } from "./reply-draft.ts";

// A mail source that reports the sender by a display name only, often cut short by its list view.
const SIG = "감사합니다.\n\n이명우 드림\n\nMyungwoo Lee (KR)\nSenior Manager\nEmail:\nmyungwoo.lee@pwc.com\nSamil PricewaterhouseCoopers";
const QUOTED = "보낸 사람: 박현섭 <hyuns@kdb.co.kr>\n받는 사람: Myungwoo Lee (KR - Assurance) <myungwoo.lee@pwc.com>\n참조: Jonghwan Park <jonghwan.j.park@pwc.com>";
const ME = ["hyuns@kdb.co.kr"];

t2("a name-only sender cut short: the display name drops the cut-off '(...' tail", () => {
	expect(senderName("Myungwoo Lee (KR - A")).toBe("Myungwoo Lee");
	expect(senderName("Myungwoo Lee (KR)")).toBe("Myungwoo Lee (KR)");
	expect(senderName('"Lee, Myungwoo" <myungwoo.lee@pwc.com>')).toBe("Lee, Myungwoo");
	expect(senderName("이명우")).toBe("이명우");
});

t2("the address comes from the signature when the local part spells the name; the user's own and other people's addresses never", () => {
	expect(senderAddress("Myungwoo Lee (KR - A", SIG, ME)).toBe("myungwoo.lee@pwc.com");
	expect(senderAddress("Myungwoo Lee (KR - A", `${SIG}\n\n${QUOTED}`, ME)).toBe("myungwoo.lee@pwc.com");
	expect(withSenderAddress("Myungwoo Lee (KR - A", SIG, ME)).toBe("Myungwoo Lee <myungwoo.lee@pwc.com>");
});

t2("a Korean name is matched through a 'name <address>' line of the quoted thread", () => {
	expect(senderAddress("이명우", "보낸 사람: 이명우 <mw.lee@corp.example>\n받는 사람: 박현섭 <hyuns@kdb.co.kr>", ME)).toBe("mw.lee@corp.example");
	expect(senderAddress("박현섭", "보낸 사람: 박현섭 <hyuns@kdb.co.kr>", ME)).toBeUndefined();
});

t2("no guess: no address, only the user's own, or two addresses that fit the name equally", () => {
	expect(senderAddress("Myungwoo Lee", "본문에 주소가 없어요", ME)).toBeUndefined();
	expect(senderAddress("Myungwoo Lee", "연락은 hyuns@kdb.co.kr 로", ME)).toBeUndefined();
	expect(senderAddress("Lee", "lee@a.example 또는 lee@b.example", ME)).toBeUndefined();
	expect(senderAddress("", SIG, ME)).toBeUndefined();
	expect(withSenderAddress("Myungwoo Lee (KR - A", "주소 없음", ME)).toBe("Myungwoo Lee (KR - A");
});

t2("a sender that already has an address is left as it came, upper case and plus tags included", () => {
	expect(withSenderAddress("Kim <Kim+Sales@Example.com>", SIG, ME)).toBe("Kim <Kim+Sales@Example.com>");
	expect(senderAddress("Kim Sales", "kim+sales@example.com", ME)).toBe("kim+sales@example.com");
});

t2("a draft whose model copied the name-only sender into 'to' goes to the recovered address", async () => {
	const { generateReply } = await import("./reply-draft.ts");
	const item = { kind: "mail" as const, from: "Myungwoo Lee <myungwoo.lee@pwc.com>", self: ME, subject: "Re: 문의", text: SIG };
	const out = "```json\n" + JSON.stringify({ action: "draft", reason: "r", to: "Myungwoo Lee (KR - A", subject: "Re: 문의", body: "확인했습니다.", questions: [] }) + "\n```";
	const r = await generateReply(item, { samples: [], rules: [], corrections: [], forbidden: [] }, async () => out);
	expect(r).toMatchObject({ action: "draft", draft: { to: "myungwoo.lee@pwc.com" }, warnings: [] });
});
