import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mailByKey, parseMail, postMail, type MailDeps } from "./mail.ts";
import { parseReplyTo, zeleReplyTo } from "./zele.ts";

function post(replyTo: string | undefined, id: string) {
	const offers: { replyTo?: string; from?: string }[] = [];
	const deps: MailDeps = { createThread: async () => ({ id: "143000000000000003" }), send: async () => undefined, mailChannel: async () => "1500000000001908450", discordOn: false, threadOn: () => false, emit: () => undefined, wake: () => undefined, offerDraft: m => void offers.push({ replyTo: m.replyTo, from: m.from }) };
	return postMail({ source: "reply-to-test", id, from: "forms@relay.example", to: "owner@example.com", subject: "견적 문의", body: "견적 부탁드립니다", ...(replyTo ? { replyTo } : {}) }, deps).then(r => ({ key: r.key, offers }));
}

describe("Reply-To on a mail post", () => {
	test("POST /api/mail input names it as replyTo", () => {
		const input = parseMail({ source: "s", id: "1", subject: "x", from: "forms@relay.example", replyTo: "person@example.com" });
		expect(input.replyTo).toBe("person@example.com");
		expect(parseMail({ source: "s", id: "2", subject: "x" }).replyTo).toBeUndefined();
	});

	test("the record keeps it and the draft offer gets it, with the From unchanged", async () => {
		const { key, offers } = await post("Person <person@example.com>", `rt-${Date.now()}-a`);
		expect(mailByKey(key)).toMatchObject({ from: "forms@relay.example", replyTo: "Person <person@example.com>" });
		expect(offers).toEqual([{ replyTo: "Person <person@example.com>", from: "forms@relay.example" }]);
	});

	test("a mail with no Reply-To stores none", async () => {
		const { key, offers } = await post(undefined, `rt-${Date.now()}-b`);
		expect(mailByKey(key)?.replyTo).toBeUndefined();
		expect(offers).toEqual([{ replyTo: undefined, from: "forms@relay.example" }]);
	});
});

const raw = (headers: string[], body = "견적 부탁드립니다\r\n") => `${headers.join("\r\n")}\r\n\r\n${body}`;

describe("Reply-To read from a raw message", () => {
	test("a display name is dropped, a bare address stays, the header name has any case", () => {
		expect(parseReplyTo(raw(["From: Forms <forms@relay.example>", "Reply-To: Person <person@example.com>", "Subject: x"])).replyTo).toBe("person@example.com");
		expect(parseReplyTo(raw(["From: forms@relay.example", "REPLY-TO: person@example.com"])).replyTo).toBe("person@example.com");
		expect(parseReplyTo(raw(["reply-to : person@example.com"])).replyTo).toBe("person@example.com");
	});

	test("a folded header is unfolded, the first address of a list is taken, a quoted name holding an @ is skipped", () => {
		expect(parseReplyTo(raw(["From: forms@relay.example", "Reply-To: \"Lee, Person\"", "\t<person@example.com>,", " other@example.com"])).replyTo).toBe("person@example.com");
		expect(parseReplyTo(raw(["Reply-To: \"a@b.example\" <real@example.com>"])).replyTo).toBe("real@example.com");
	});

	test("no Reply-To header gives none, and a Reply-To line in the body after the blank line is ignored", () => {
		expect(parseReplyTo(raw(["From: kim@example.com", "Subject: x"])).replyTo).toBeUndefined();
		expect(parseReplyTo(raw(["From: kim@example.com"], "Reply-To: trap@example.com\r\n")).replyTo).toBeUndefined();
		expect(parseReplyTo("From: kim@example.com\nReply-To: person@example.com\n\nbody").replyTo).toBe("person@example.com");
		expect(parseReplyTo("").replyTo).toBeUndefined();
	});

	test("the From of the same message is returned beside it", () => {
		expect(parseReplyTo(raw(["From: Forms <forms@relay.example>", "Reply-To: person@example.com"]))).toEqual({ from: "forms@relay.example", replyTo: "person@example.com" });
		expect(parseReplyTo(raw(["From: kim@example.com"]))).toEqual({ from: "kim@example.com" });
	});

	test("a (comment) is dropped like a quoted name, and a group without a space after the colon gives its member", () => {
		expect(parseReplyTo(raw(["Reply-To: (on behalf of x@evil.example) real@example.com"])).replyTo).toBe("real@example.com");
		expect(parseReplyTo(raw(["Reply-To: real@example.com (x@evil.example)"])).replyTo).toBe("real@example.com");
		expect(parseReplyTo(raw(["Reply-To: Team:a@example.com;"])).replyTo).toBe("a@example.com");
		expect(parseReplyTo(raw(["Reply-To: Team: a@example.com, b@example.com;"])).replyTo).toBe("a@example.com");
	});
});

describe("zeleReplyTo runs a read, never a reply", () => {
	const argv: string[][] = [];
	let spawn: ReturnType<typeof spyOn>;
	const answer = (stdout: string, code = 0) => {
		spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			argv.push(cmd.slice());
			return { pid: 0, stdout: new Response(stdout).body, stderr: new Response(code ? "boom" : "").body, exited: Promise.resolve(code), kill() {} };
		}) as unknown as typeof Bun.spawn);
	};
	beforeEach(() => void (argv.length = 0));
	afterEach(() => spawn.mockRestore());

	test("the call is `zele mail read <id> --raw` and carries the account", async () => {
		answer(raw(["From: forms@relay.example", "Reply-To: Person <person@example.com>"]));
		expect(await zeleReplyTo("th1", "me@example.net")).toEqual({ from: "forms@relay.example", replyTo: "person@example.com" });
		expect(argv).toHaveLength(1);
		expect(argv[0]).toEqual(["zele", "mail", "read", "th1", "--raw", "--account", "me@example.net"]);
		expect(argv[0]).not.toContain("reply");
	});

	test("a failed read gives none", async () => {
		answer("", 1);
		expect(await zeleReplyTo("th1", "me@example.net")).toBeUndefined();
		expect(argv[0]).not.toContain("reply");
	});
});
