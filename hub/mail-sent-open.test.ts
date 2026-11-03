// A sent mail opens on itself: it has no conversation event, so GET /api/history of `mail:<key>` leads with sentMailEvent, and a sent mail first
// reported without its body takes the body when it is reported again with one.
import { describe, expect, test } from "bun:test";
import { mailBodyRoute, mailByKey, postMail, sentMailEvent, type MailDeps } from "./mail.ts";

let seq = 0;
const uid = () => `sent${Date.now().toString(36)}${++seq}`;

function deps(): { deps: MailDeps; events: Record<string, unknown>[] } {
	const events: Record<string, unknown>[] = [];
	return {
		events,
		deps: {
			createThread: async () => ({ id: "143000000000000001" }),
			send: async () => undefined,
			mailChannel: async () => "000000000000000000",
			discordOn: true,
			threadOn: () => true,
			emit: e => void events.push(e as Record<string, unknown>),
			wake: () => {},
			offerDraft: () => {},
			now: () => "2030-01-01T00:00:00.000Z",
		},
	};
}

describe("opening a sent mail", () => {
	test("a sent mail with no conversation opens on the mail itself, body included", async () => {
		const { deps: d, events } = deps();
		const id = uid();
		const r = await postMail({ source: "company", id, from: "Owner <owner@example.com>", to: "Kim <kim@example.com>", subject: "회계처리 문의", body: "안녕하세요.\n반대채권 매수 건 문의드립니다.", direction: "out" }, d);
		expect(r).toMatchObject({ direction: "out", html: true });
		expect(events).toEqual([]);
		const ev = sentMailEvent(r.key);
		expect(ev).toMatchObject({ kind: "mail", dir: "out", mail: r.key, conv: r.target, subject: "회계처리 문의", to: "Kim <kim@example.com>", html: true });
		expect(String(ev!.text)).toContain("회계처리 문의");
		expect(await mailBodyRoute(r.key).text()).toContain("반대채권 매수 건 문의드립니다.");
	});

	test("a sent mail reported without its body takes it when reported again", async () => {
		const { deps: d } = deps();
		const id = uid();
		const bare = { source: "company", id, from: "Owner <owner@example.com>", to: "Lee <lee@example.com>", subject: "자료 송부", direction: "out" as const };
		const first = await postMail(bare, d);
		expect(mailByKey(first.key)?.html).toBeUndefined();
		expect(sentMailEvent(first.key)).toMatchObject({ subject: "자료 송부", to: "Lee <lee@example.com>" });
		const again = await postMail({ ...bare, body: "첨부와 같이 자료 송부드립니다." }, d);
		expect(again).toMatchObject({ key: first.key, duplicate: true, html: true });
		expect(mailByKey(first.key)).toMatchObject({ html: true, preview: expect.stringContaining("자료 송부드립니다") });
		expect(sentMailEvent(first.key)).toMatchObject({ html: true });
		expect(await mailBodyRoute(first.key).text()).toContain("첨부와 같이 자료 송부드립니다.");
	});

	// A poster marks a sent mail done only on `html` in the answer: a body-less record must not answer it, one that holds its body must.
	test("a repost answers html only when the body is kept", async () => {
		const { deps: d } = deps();
		const bare = { source: "company", id: uid(), from: "Owner <owner@example.com>", to: "Park <park@example.com>", subject: "검토의견", direction: "out" as const };
		await postMail(bare, d);
		expect((await postMail(bare, d)).html).toBeUndefined();
		await postMail({ ...bare, body: "검토의견 송부드립니다." }, d);
		expect(await postMail({ ...bare, body: "검토의견 송부드립니다." }, d)).toMatchObject({ duplicate: true, html: true });
	});
});
