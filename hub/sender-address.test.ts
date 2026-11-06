import { expect, test as t2 } from "bun:test";
import { senderAddress, senderName, withSenderAddress } from "./reply-draft.ts";

// A mail source that reports the sender by a display name only, often cut short by its list view.
const SIG = "감사합니다.\n\n한지수 드림\n\nJisoo Han (KR)\nSenior Manager\nEmail:\njisoo.han@audit.example\nExample Audit Partners";
const QUOTED = "보낸 사람: 홍길동 <owner@corp.example>\n받는 사람: Jisoo Han (KR - Assurance) <jisoo.han@audit.example>\n참조: Alex Park <alex.j.park@audit.example>";
const ME = ["owner@corp.example"];

t2("a name-only sender cut short: the display name drops the cut-off '(...' tail", () => {
	expect(senderName("Jisoo Han (KR - A")).toBe("Jisoo Han");
	expect(senderName("Jisoo Han (KR)")).toBe("Jisoo Han (KR)");
	expect(senderName('"Han, Jisoo" <jisoo.han@audit.example>')).toBe("Han, Jisoo");
	expect(senderName("한지수")).toBe("한지수");
});

t2("the address comes from the signature when the local part spells the name; the user's own and other people's addresses never", () => {
	expect(senderAddress("Jisoo Han (KR - A", SIG, ME)).toBe("jisoo.han@audit.example");
	expect(senderAddress("Jisoo Han (KR - A", `${SIG}\n\n${QUOTED}`, ME)).toBe("jisoo.han@audit.example");
	expect(withSenderAddress("Jisoo Han (KR - A", SIG, ME)).toBe("Jisoo Han <jisoo.han@audit.example>");
});

t2("a Korean name is matched through a 'name <address>' line of the quoted thread", () => {
	expect(senderAddress("한지수", "보낸 사람: 한지수 <js.han@corp.example>\n받는 사람: 홍길동 <owner@corp.example>", ME)).toBe("js.han@corp.example");
	expect(senderAddress("홍길동", "보낸 사람: 홍길동 <owner@corp.example>", ME)).toBeUndefined();
});

t2("no guess: no address, only the user's own, or two addresses that fit the name equally", () => {
	expect(senderAddress("Jisoo Han", "본문에 주소가 없어요", ME)).toBeUndefined();
	expect(senderAddress("Jisoo Han", "연락은 owner@corp.example 로", ME)).toBeUndefined();
	expect(senderAddress("Lee", "lee@a.example 또는 lee@b.example", ME)).toBeUndefined();
	expect(senderAddress("", SIG, ME)).toBeUndefined();
	expect(withSenderAddress("Jisoo Han (KR - A", "주소 없음", ME)).toBe("Jisoo Han (KR - A");
});

t2("a sender that already has an address is left as it came, upper case and plus tags included", () => {
	expect(withSenderAddress("Kim <Kim+Sales@Example.com>", SIG, ME)).toBe("Kim <Kim+Sales@Example.com>");
	expect(senderAddress("Kim Sales", "kim+sales@example.com", ME)).toBe("kim+sales@example.com");
});

t2("a draft whose model copied the name-only sender into 'to' goes to the recovered address", async () => {
	const { generateReply } = await import("./reply-draft.ts");
	const item = { kind: "mail" as const, from: "Jisoo Han <jisoo.han@audit.example>", self: ME, subject: "Re: 문의", text: SIG };
	const out = "```json\n" + JSON.stringify({ action: "draft", reason: "r", to: "Jisoo Han (KR - A", subject: "Re: 문의", body: "확인했습니다.", questions: [] }) + "\n```";
	const r = await generateReply(item, { samples: [], rules: [], corrections: [], forbidden: [] }, async () => out);
	expect(r).toMatchObject({ action: "draft", draft: { to: "jisoo.han@audit.example" }, warnings: [] });
});
