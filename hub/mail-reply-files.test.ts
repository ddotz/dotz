// reply_files on POST /api/mail: files a poster already chose for the reply. Checked at the boundary (parseMail), kept on the record and
// handed to the reply draft (offerDraft), apart from the mail's own attachments.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailError, mailByKey, parseMail, postMail, type MailDeps } from "./mail.ts";

const dir = mkdtempSync(join(tmpdir(), "reply-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const quote = join(dir, "quote.pdf");
writeFileSync(quote, "quote bytes");
writeFileSync(join(dir, "empty.pdf"), "");
mkdirSync(join(dir, "folder"));
symlinkSync(quote, join(dir, "link.pdf"));

const base = { source: "plug", id: "r1", subject: "견적서 부탁드려요" };
const parse = (reply_files: unknown) => parseMail({ ...base, reply_files });

describe("reply_files at the boundary", () => {
	test("absolute paths of readable regular files are kept, and a post without the field has none", () => {
		expect(parse([{ path: quote }]).replyFiles).toEqual([{ path: quote }]);
		expect(parseMail(base).replyFiles).toBeUndefined();
	});

	test.each([
		["not a list", { path: quote }],
		["a relative path", [{ path: "quote.pdf" }]],
		["a path with ..", [{ path: `${dir}/folder/../quote.pdf` }]],
		["a missing file", [{ path: join(dir, "gone.pdf") }]],
		["a folder", [{ path: join(dir, "folder") }]],
		["a symlink", [{ path: join(dir, "link.pdf") }]],
		["an empty file", [{ path: join(dir, "empty.pdf") }]],
		["no path", [{ name: "quote.pdf" }]],
		["more than 10 files", Array.from({ length: 11 }, () => ({ path: quote }))],
	])("%s is refused", (_why, v) => {
		expect(() => parse(v)).toThrow(MailError);
	});
});

function deps(offers: Record<string, any>[]): MailDeps {
	return { createThread: async () => ({ id: "1430000000000000001" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {}, offerDraft: m => void offers.push(m) };
}

describe("reply_files reach the reply draft", () => {
	test("the draft offer carries them and the record keeps them; the mail's own attachments stay as they were", async () => {
		const offers: Record<string, any>[] = [];
		const id = `r${Date.now().toString(36)}`;
		const r = await postMail({ ...base, id, from: "Kim <kim@example.com>", body: "견적서 보내 주세요", attachments: [{ name: "req.txt", data: Buffer.from("hi").toString("base64") }], reply_files: [{ path: quote }] }, deps(offers));
		expect(offers).toHaveLength(1);
		expect(offers[0]!.replyFiles).toEqual([{ path: quote }]);
		expect(offers[0]!.attachments).toEqual([{ name: "req.txt", type: expect.any(String), size: 2 }]);
		expect(mailByKey(r.key)!.replyFiles).toEqual([{ path: quote }]);
		expect(mailByKey(r.key)!.attachments!.map(a => a.name)).toEqual(["req.txt"]);
	});

	test("a post without reply_files offers none", async () => {
		const offers: Record<string, any>[] = [];
		await postMail({ ...base, id: `n${Date.now().toString(36)}`, from: "kim@example.com" }, deps(offers));
		expect(offers[0]!.replyFiles).toBeUndefined();
	});
});
