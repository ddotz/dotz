import { expect, test as t2 } from "bun:test";
import { senderAddress, senderName, withSenderAddress } from "./reply-draft.ts";

// A mail source that reports the sender by a display name only, often cut short by its list view.
const SIG = "감사합니다.\n\nredacted 드림\n\nredacted Lee (KR)\nSenior Manager\nEmail:\nsomeone@example.com\nredacted redacted";
const QUOTED = "보낸 사람: redacted <someone@example.com>\n받는 사람: redacted Lee (KR - Assurance) <someone@example.com>\n참조: redacted Park <someone@example.com>";
const ME = ["someone@example.com"];

t2("a name-only sender cut short: the display name drops the cut-off '(...' tail", () => {
	expect(senderName("redacted Lee (KR - A")).toBe("redacted Lee");
	expect(senderName("redacted Lee (KR)")).toBe("redacted Lee (KR)");
	expect(senderName('"Lee, redacted" <someone@example.com>')).toBe("Lee, redacted");
	expect(senderName("redacted")).toBe("redacted");
});

t2("the address comes from the signature when the local part spells the name; the user's own and other people's addresses never", () => {
	expect(senderAddress("redacted Lee (KR - A", SIG, ME)).toBe("someone@example.com");
	expect(senderAddress("redacted Lee (KR - A", `${SIG}\n\n${QUOTED}`, ME)).toBe("someone@example.com");
	expect(withSenderAddress("redacted Lee (KR - A", SIG, ME)).toBe("redacted Lee <someone@example.com>");
});

t2("a Korean name is matched through a 'name <address>' line of the quoted thread", () => {
	expect(senderAddress("redacted", "보낸 사람: redacted <redacted@corp.example>\n받는 사람: redacted <someone@example.com>", ME)).toBe("redacted@corp.example");
	expect(senderAddress("redacted", "보낸 사람: redacted <someone@example.com>", ME)).toBeUndefined();
});

t2("no guess: no address, only the user's own, or two addresses that fit the name equally", () => {
	expect(senderAddress("redacted Lee", "본문에 주소가 없어요", ME)).toBeUndefined();
	expect(senderAddress("redacted Lee", "연락은 someone@example.com 로", ME)).toBeUndefined();
	expect(senderAddress("Lee", "lee@a.example 또는 lee@b.example", ME)).toBeUndefined();
	expect(senderAddress("", SIG, ME)).toBeUndefined();
	expect(withSenderAddress("redacted Lee (KR - A", "주소 없음", ME)).toBe("redacted Lee (KR - A");
});

t2("a sender that already has an address is left as it came, upper case and plus tags included", () => {
	expect(withSenderAddress("Kim <Kim+Sales@Example.com>", SIG, ME)).toBe("Kim <Kim+Sales@Example.com>");
	expect(senderAddress("Kim Sales", "kim+sales@example.com", ME)).toBe("kim+sales@example.com");
});

t2("a draft whose model copied the name-only sender into 'to' goes to the recovered address", async () => {
	const { generateReply } = await import("./reply-draft.ts");
	const item = { kind: "mail" as const, from: "redacted Lee <someone@example.com>", self: ME, subject: "Re: 문의", text: SIG };
	const out = "```json\n" + JSON.stringify({ action: "draft", reason: "r", to: "redacted Lee (KR - A", subject: "Re: 문의", body: "확인했습니다.", questions: [] }) + "\n```";
	const r = await generateReply(item, { samples: [], rules: [], corrections: [], forbidden: [] }, async () => out);
	expect(r).toMatchObject({ action: "draft", draft: { to: "someone@example.com" }, warnings: [] });
});
