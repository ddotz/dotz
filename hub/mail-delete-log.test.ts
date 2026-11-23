import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { paths } from "./config.ts";
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
const SUBJECT = "sample-2 분기 정산 안내", FROM = "Sample Sender <sender@example.com>";
const mail = async () => (await postMail({ source: "acme", id: `dl${Date.now().toString(36)}${++seq}`, subject: SUBJECT, from: FROM, summary: "내용", messageId: `m-${seq}` }, deps)).key;
const call = (method: string, path: string, body?: unknown) => routeMail(new Request(`http://hub.test${path}`, { method, headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://hub.test${path}`), { peer: "none" });
const logSize = () => (existsSync(paths.log) ? readFileSync(paths.log, "utf8").length : 0);
const linesSince = (at: number) => readFileSync(paths.log, "utf8").slice(at).split("\n").filter(l => l.includes("mail delete"));

describe("the hub's line for every delete request", () => {
	test("one line per request, with the route, the counts and the keys, and never the subject or the sender", async () => {
		const [one, a, b, old, orig] = [await mail(), await mail(), await mail(), await mail(), await mail()];
		const at = logSize();
		expect((await call("POST", `/api/mail/${one}/action`, { action: "trash" }))!.status).toBe(200);
		expect((await call("POST", "/api/mail/actions", { keys: [a, b, "acme-nosuch"], action: "trash" }))!.status).toBe(200);
		expect((await call("POST", "/api/mail/actions", { keys: [a], action: "read" }))!.status).toBe(200);
		expect((await call("DELETE", `/api/mail/${old}`))!.status).toBe(200);
		expect((await call("POST", "/api/mail/delete-original", { keys: [orig] }))!.status).toBe(200);
		expect([one, a, b, old].map(k => mailByKey(k))).toEqual([undefined, undefined, undefined, undefined]);
		const lines = linesSince(at);
		expect(lines).toHaveLength(4);
		const [l1, l2, l3, l4] = lines as [string, string, string, string];
		expect(l1).toContain("1 asked, 1 deleted, 0 not");
		expect(l1).toContain(one);
		expect(l2).toContain("3 asked, 2 deleted, 1 not");
		for (const k of [a, b, "acme-nosuch"]) expect(l2).toContain(k);
		expect(l3).toContain("1 asked, 1 deleted, 0 not");
		expect(l3).toContain(old);
		expect(l4).toContain("1 asked, 0 deleted, 1 not");
		expect(l4).toContain(orig);
		expect(new Set(lines.map(l => /mail delete (\S+):/.exec(l)?.[1])).size).toBe(4);
		for (const l of lines) for (const secret of [SUBJECT, "sample-2", "Sample Sender", "sender@example.com", "example.com"]) expect(l).not.toContain(secret);
	});
});
