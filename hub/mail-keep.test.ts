import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { mailByKey, mailKeep, recordMail, type MailRecord } from "./mail.ts";

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const mail = (key: string, at: string, extra: Partial<MailRecord> = {}): MailRecord => ({ key, source: "fx", id: key, subject: key, from: "kim@example.com", at, ...extra });

// Dates are in the past on purpose: this file shares the process-wide mail list with other test files, and a record newer than "now" would push theirs out.
test("a mail past the keep horizon is dropped unless a draft or a reply still waits on it", () => {
	const id = uid("keep");
	const old = (n: string, extra: Partial<MailRecord> = {}) => mail(`fx-${id}-${n}`, "2001-01-01T00:00:00.000Z", extra);
	recordMail(old("draft", { suggest: { kind: "reply-draft", label: "답장 초안", ref: "R1" } }));
	recordMail(old("needs", { reply: "needs" }));
	recordMail(old("sent", { suggest: { kind: "reply-draft", label: "답장 초안", ref: "R2", state: "sent" } }));
	recordMail(old("plain"));
	for (let i = 0; i < mailKeep() + 20; i++) recordMail(mail(`fx-${id}-new${i}`, new Date(Date.UTC(2002, 0, 1, 0, 0, i)).toISOString()));
	expect(mailByKey(`fx-${id}-draft`)).toBeDefined();
	expect(mailByKey(`fx-${id}-needs`)).toBeDefined();
	expect(mailByKey(`fx-${id}-plain`)).toBeUndefined();
	expect(mailByKey(`fx-${id}-sent`)).toBeUndefined();
	expect(mailByKey(`fx-${id}-new${mailKeep() + 19}`)).toBeDefined();
});

test("a record written again keeps the list ordered by time and does not duplicate", () => {
	const id = uid("ord");
	const k = (n: number) => `fx-${id}-${n}`;
	recordMail(mail(k(1), "2003-01-01T00:00:01.000Z"));
	recordMail(mail(k(2), "2003-01-01T00:00:03.000Z"));
	recordMail(mail(k(3), "2003-01-01T00:00:02.000Z"));
	recordMail(mail(k(1), "2003-01-01T00:00:04.000Z", { subject: "again" }));
	expect(mailByKey(k(1))!.subject).toBe("again");
	const file = JSON.parse(readFileSync(join(DATA_DIR, "mail-conversations.json"), "utf8")) as MailRecord[];
	const mine = file.filter(r => r.key.startsWith(`fx-${id}-`)).map(r => r.key);
	expect(mine).toEqual([k(3), k(2), k(1)]);
	expect(file.map(r => r.at)).toEqual([...file.map(r => r.at)].sort());
});
