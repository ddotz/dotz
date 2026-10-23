// Mail attachments (hub/mail.ts): a mail posted with files is listed without stored paths and each file is served through the whole route,
// with the web auth; nothing outside the mail files folder is, whatever the key, index or record says.
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import { MAIL_FILES, mailByKey, postMail, recordMail, type MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";

const DATA = process.env.DOTZ_DIR!;
const deps: MailDeps = { createThread: async () => ({ id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: false, emit: () => {}, wake: () => {} };
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const get = (path: string, opts: { method?: string; auth?: boolean } = {}) => route(new Request(`http://hub.test${path}`, { method: opts.method ?? "GET", headers: opts.auth === false ? {} : { "x-dotz-token": HUB_TOKEN } }));
const b64 = (s: string) => Buffer.from(s).toString("base64");

writeFileSync(join(DATA, "..", "outside-secret.txt"), "not for the web");
const posted = await postMail({
	source: "fixture", id: "att-1", subject: "견적서 보냅니다", from: "Sender <sender@example.com>",
	body: "\n안녕하세요.\n견적서를 첨부합니다.\n\n감사합니다.\n넷째 줄",
	attachments: [{ name: "견적서 2026.txt", type: "text/plain", data: b64("견적 내용") }, { name: "../../evil.zip", data: b64("echo hi") }, { name: "a.png", data: b64("PNGDATA"), type: "image/png" }],
}, deps);
const key = posted.key;

test("a posted mail keeps a preview of its body and lists its files without paths", async () => {
	const rec = mailByKey(key)!;
	expect(rec.preview).toBe("안녕하세요.\n견적서를 첨부합니다.\n감사합니다.");
	expect(rec.attachments!.map(a => [a.name, a.size])).toEqual([["견적서 2026.txt", Buffer.byteLength("견적 내용")], ["evil.zip", 7], ["a.png", 7]]);
	const list = (await (await get("/api/conversations")).json()) as { items: { target: string; mail?: Record<string, any> }[] };
	const mail = list.items.find(i => i.target === posted.target)!.mail!;
	expect(mail.attachments).toEqual(rec.attachments!.map(({ name, type, size }) => ({ name, type, size })));
	expect(JSON.stringify(mail)).not.toContain("mail-files");
	expect(mail.preview).toBe(rec.preview);
});

test("an attachment is served through the whole route: inline for a safe type, as a download on dl=1, HEAD without a body", async () => {
	const ok = await get(`/api/mail/${key}/files/2`);
	expect([ok.status, ok.headers.get("content-type"), await ok.text()]).toEqual([200, "image/png", "PNGDATA"]);
	const text = await get(`/api/mail/${key}/files/0`);
	expect(text.headers.get("content-disposition")).toStartWith("inline;");
	expect(text.headers.get("content-disposition")).toContain(encodeURIComponent("견적서 2026.txt"));
	expect(await text.text()).toBe("견적 내용");
	expect((await get(`/api/mail/${key}/files/0?dl=1`)).headers.get("content-disposition")).toStartWith("attachment;");
	expect((await get(`/api/mail/${key}/files/1`)).headers.get("content-disposition")).toStartWith("attachment;");
	const head = await get(`/api/mail/${key}/files/2`, { method: "HEAD" });
	expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "7", ""]);
});

test("without the web auth nothing is served", async () => {
	expect((await get(`/api/mail/${key}/files/2`, { auth: false })).status).toBe(403);
});

test("an unknown mail, an index out of range or not a number, and traversal keys are 404", async () => {
	for (const p of [`/api/mail/no-such-mail/files/0`, `/api/mail/${key}/files/3`, `/api/mail/${key}/files/-1`, `/api/mail/${key}/files/0%2f..%2f..`, "/api/mail/../files/0", "/api/mail/%2e%2e/files/0", `/api/mail/${key}%2f..%2f${key}/files/0`, "/api/mail/../../mail-conversations.json/files/0"]) {
		expect([p, (await get(p)).status]).toEqual([p, 404]);
	}
});

test("a record that points outside the mail files folder (tampered file, .. or a symlink) serves nothing", async () => {
	mkdirSync(join(MAIL_FILES, "link-mail", "0"), { recursive: true });
	symlinkSync(join(DATA, "..", "outside-secret.txt"), join(MAIL_FILES, "link-mail", "0", "x.txt"));
	const base = { source: "fixture", subject: "t", from: "", at: new Date().toISOString() };
	const at = (name: string, file: string) => ({ ...base, key: name, id: name, attachments: [{ name: "x.txt", type: "text/plain", size: 1, file }] });
	recordMail(at("tamper-up", "../../outside-secret.txt"));
	recordMail(at("tamper-abs", join(DATA, "..", "outside-secret.txt")));
	recordMail(at("tamper-link", "link-mail/0/x.txt"));
	recordMail(at("tamper-data", "../mail-conversations.json"));
	for (const k of ["tamper-up", "tamper-abs", "tamper-link", "tamper-data"]) {
		const r = await get(`/api/mail/${k}/files/0`);
		expect([k, r.status, (await r.text()).includes("not for the web")]).toEqual([k, 404, false]);
	}
});

test("a poster cannot attach a file from outside the mail files folder; a file it put inside is taken", async () => {
	const r = await postMail({ source: "fixture", id: "att-path", subject: "경로", attachments: [{ name: "pw", path: join(DATA, "..", "outside-secret.txt") }, { name: "up", path: "../../outside-secret.txt" }] }, deps);
	expect(mailByKey(r.key)!.attachments).toBeUndefined();
	mkdirSync(join(MAIL_FILES, "drop"), { recursive: true });
	writeFileSync(join(MAIL_FILES, "drop", "r.txt"), "from disk");
	const r2 = await postMail({ source: "fixture", id: "att-path2", subject: "경로2", attachments: [{ name: "r.txt", path: "drop/r.txt" }] }, deps);
	expect(await (await get(`/api/mail/${r2.key}/files/0`)).text()).toBe("from disk");
});

test("a bad attachments field is a 400 for the poster", async () => {
	await expect(postMail({ source: "fixture", id: "att-bad", subject: "x", attachments: "no" }, deps)).rejects.toThrow("attachments must be an array");
	await expect(postMail({ source: "fixture", id: "att-bad", subject: "x", attachments: [{ name: "a" }] }, deps)).rejects.toThrow("exactly one of data");
});
