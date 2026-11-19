import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { mailByKey, postMail, type MailDeps } from "./mail.ts";

const deps: MailDeps = { createThread: async () => ({ id: "1430000000000000099" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: () => undefined, wake: () => undefined };

test("the stored mail list is one line of JSON that reads back as the records the hub holds", async () => {
	const posted = await postMail({ source: "zele", id: "compact-1", subject: "저장 시험", from: "Kim <kim@example.com>", to: "me@example.com", body: "본문 하나" }, deps);
	await postMail({ source: "zele", id: "compact-2", subject: "저장 시험 둘", from: "Lee <lee@example.com>", to: "me@example.com", body: "본문 둘" }, deps);
	const raw = readFileSync(join(DATA_DIR, "mail-conversations.json"), "utf8");
	expect(raw.trimEnd()).not.toContain("\n");
	expect(raw.endsWith("\n")).toBe(true);
	const rows = JSON.parse(raw) as { key: string; subject: string }[];
	expect(rows.find(r => r.key === posted.key)?.subject).toBe("저장 시험");
	expect(rows.find(r => r.key === posted.key)).toEqual(JSON.parse(JSON.stringify(mailByKey(posted.key))));
});
