import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureEnabled, mailFeatureOn } from "./app-feature-flags.ts";
import { mailByKey, postMail, type MailDeps } from "./mail.ts";

// The question every feature path asks (featureEnabled) and the mail route that asks it: off = the mail is not posted, no thread, no wake.
const data = mkdtempSync(join(tmpdir(), "app-flags-"));
afterAll(() => rmSync(data, { recursive: true, force: true }));
const apps = (v: unknown) => {
	mkdirSync(join(data, "custom"), { recursive: true });
	writeFileSync(join(data, "custom/apps.json"), JSON.stringify(v));
};

test("a declared feature is on until its switch says off, per instance; an undeclared one is on", () => {
	apps({});
	expect(featureEnabled(data, "mail", "new_mail")).toBe(true);
	apps({ mail: { features: { new_mail: false } } });
	expect(featureEnabled(data, "mail", "new_mail")).toBe(false);
	expect(featureEnabled(data, "mail", "nothing_here")).toBe(true);
	apps({ "mail-2": { app: "mail", label: "회사", filter: { source: "work" }, features: { new_mail: false } } });
	expect(featureEnabled(data, "mail", "new_mail")).toBe(true);
	expect(featureEnabled(data, "mail-2", "new_mail")).toBe(false);
});

test("새 메일 off: postMail posts nothing and wakes nobody; on again, it posts", async () => {
	apps({ mail: { features: { new_mail: false } } });
	const seen = { wake: 0, thread: 0, emit: 0 };
	const deps: MailDeps = {
		createThread: async () => (seen.thread++, { id: "1" }), send: async () => {}, mailChannel: async () => undefined, discordOn: true,
		emit: () => void seen.emit++, wake: () => void seen.wake++,
		newMailOn: (_s, key) => mailFeatureOn(data, key, "new_mail"),
	};
	const mail = { source: "fixture-flag", id: "flag-1", subject: "꺼진 메일", wake: true };
	const off = await postMail(mail, deps);
	expect(off).toMatchObject({ ok: true, skipped: true });
	expect(mailByKey(off.key)).toBeUndefined();
	expect(seen).toEqual({ wake: 0, thread: 0, emit: 0 });
	apps({});
	const on = await postMail(mail, deps);
	expect(on.skipped).toBeUndefined();
	expect(mailByKey(on.key)?.subject).toBe("꺼진 메일");
});
