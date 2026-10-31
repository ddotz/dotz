import { expect, test } from "bun:test";
import { capture, type CapturedRequest } from "../lib/capture.ts";
import { fromHar } from "../bin/capture.ts";
import { validateSpec } from "../lib/spec.ts";

const longHtml = `<p>${"hello world ".repeat(20)}</p>`;
const recording: CapturedRequest[] = [
	{
		url: "https://mail.acme.test/mail/mboxes/55/mails",
		status: 200,
		contentType: "application/json",
		responseBody: JSON.stringify({ mails: [
			{ id: 101, subject: "quarterly report", sender: "boss@acme.test", regdate: "2026-10-22T09:00:00Z", isread: "N" },
			{ id: 100, subject: "welcome", sender: "hr@acme.test", regdate: "2026-10-21T09:00:00Z", isread: "Y" },
		] }),
	},
	{ url: "https://mail.acme.test/mail/mails/101?preview=true", status: 200, contentType: "application/json", responseBody: JSON.stringify({ id: 101, content: longHtml }) },
	{ url: "https://mail.acme.test/mail/search?q=report", status: 200, contentType: "application/json", responseBody: JSON.stringify({ mails: [{ id: 101, subject: "quarterly report", sender: "boss@acme.test", regdate: "2026-10-22T09:00:00Z" }] }) },
];

test("the generator builds a valid, personal-data-free spec from a recording", () => {
	const { spec, notes } = capture("acme", recording);
	expect(spec).toBeDefined();
	expect(validateSpec(spec)).toBeUndefined();
	expect(spec!.origin).toBe("https://mail.acme.test");
	expect(spec!.cookieHosts).toContain("mail.acme.test");
	expect(spec!.list.path).toBe("/mail/mboxes/{mailbox}/mails");
	expect(spec!.list.mailbox).toBe("55");
	expect(spec!.list.listPath).toBe("mails");
	expect(spec!.list.fields).toEqual({ id: "id", subject: "subject", from: "sender", time: "regdate", read: "isread" });
	expect(spec!.read.path).toBe("/mail/mails/{id}");
	expect(spec!.read.bodyPath).toBe("content");
	expect(spec!.search?.queryParam).toBe("q");
	expect(notes.length).toBeGreaterThan(0);
});

test("a recording with no mail list yields notes and no spec", () => {
	const { spec, notes } = capture("acme", [{ url: "https://mail.acme.test/ping", status: 200, contentType: "application/json", responseBody: JSON.stringify({ ok: true }) }]);
	expect(spec).toBeUndefined();
	expect(notes.length).toBeGreaterThan(0);
});

test("fromHar normalizes a HAR export into the generator's shape", () => {
	const har = { log: { entries: [{ request: { url: "https://mail.acme.test/mail/mboxes/55/mails", method: "GET" }, response: { status: 200, content: { mimeType: "application/json", text: recording[0].responseBody } } }] } };
	const reqs = fromHar(har);
	expect(reqs).toHaveLength(1);
	expect(reqs[0].url).toBe("https://mail.acme.test/mail/mboxes/55/mails");
	expect(capture("acme", reqs).spec?.list.listPath).toBe("mails");
});
