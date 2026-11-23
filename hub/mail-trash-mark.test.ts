import { describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { mailByKey, postMail, type MailDeps } from "./mail.ts";
import { routeMail } from "./routes-mail.ts";

const deps: MailDeps = {
	createThread: async () => ({ id: "143000000000000001" }),
	send: async () => undefined,
	mailChannel: async () => undefined,
	discordOn: false,
	emit: e => emit("inbox", e as Parameters<typeof emit>[1]),
	wake: () => undefined,
};
let seq = 0;
const id = () => `tm${Date.now().toString(36)}${++seq}`;
const post = async (mailId: string, messageId?: string) => (await postMail({ source: "acme", id: mailId, subject: "sample-2 일정", from: "Sample Two <two@example.com>", summary: "내용", ...(messageId ? { messageId } : {}) }, deps)).key;
const call = async (method: string, path: string, body?: unknown) => {
	const res = (await routeMail(new Request(`http://hub.test${path}`, { method, headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://hub.test${path}`), { peer: "none" }))!;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const cardMark = async (key: string) => {
	const { body } = await call("GET", `/api/conversations?target=${encodeURIComponent(`mail:${key}`)}`);
	const items = body.items as { target: string; mail?: { mark?: unknown } }[];
	return items.find(it => it.target === `mail:${key}`)?.mail?.mark;
};

describe("삭제 deletes only the message the page saw", () => {
	test("the list card carries the mark of the mail's newest message", async () => {
		const key = await post(id(), "m-1");
		expect(await cardMark(key)).toBe("m-1");
		await post(key.slice("acme-".length), "m-2");
		expect(await cardMark(key)).toBe("m-2");
	});

	test("a newer reply that came after the page drew the mail stops the delete, one mail and many", async () => {
		const mailId = id(), key = await post(mailId, "m-1");
		await post(mailId, "m-2");
		const one = await call("POST", `/api/mail/${key}/action`, { action: "trash", mark: "m-1" });
		expect(one.status).toBe(409);
		expect(one.body).toMatchObject({ newer: true });
		expect(typeof one.body.error).toBe("string");
		expect(mailByKey(key)).toBeDefined();
		const many = await call("POST", "/api/mail/actions", { keys: [key], action: "trash", marks: { [key]: "m-1" } });
		expect(many.body.results).toEqual([expect.objectContaining({ key, ok: false, newer: true })]);
		expect(mailByKey(key)).toBeDefined();
		expect((await call("POST", `/api/mail/${key}/action`, { action: "trash", mark: "m-2" })).status).toBe(200);
		expect(mailByKey(key)).toBeUndefined();
	});

	test("the mark the page saw deletes; a mail without message ids, and a page that sends no mark, delete as before", async () => {
		const [a, b, c] = [await post(id(), "m-1"), await post(id()), await post(id(), "m-1")];
		const many = await call("POST", "/api/mail/actions", { keys: [a, b], action: "trash", marks: { [a]: "m-1", [b]: await cardMark(b) } });
		expect(many.body.results).toEqual([expect.objectContaining({ key: a, ok: true }), expect.objectContaining({ key: b, ok: true })]);
		expect((await call("POST", `/api/mail/${c}/action`, { action: "trash" })).status).toBe(200);
		expect([a, b, c].map(k => mailByKey(k))).toEqual([undefined, undefined, undefined]);
	});

	test("a mail that is already gone answers gone, so the page drops it without a word", async () => {
		const key = await post(id(), "m-1");
		expect((await call("POST", `/api/mail/${key}/action`, { action: "trash", mark: "m-1" })).status).toBe(200);
		const again = await call("POST", `/api/mail/${key}/action`, { action: "trash", mark: "m-1" });
		expect(again.status).toBe(404);
		expect(again.body).toMatchObject({ gone: true });
		const many = await call("POST", "/api/mail/actions", { keys: [key], action: "trash" });
		expect(many.body.results).toEqual([expect.objectContaining({ key, ok: false, gone: true })]);
	});
});
