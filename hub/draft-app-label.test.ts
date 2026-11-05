import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftAppOf } from "./approval-wire.ts";
import { addDraft, newId } from "../features/reply-drafts/lib/store.ts";

const DATA = process.env.DOTZ_DIR!;
mkdirSync(join(DATA, "custom"), { recursive: true });
writeFileSync(join(DATA, "custom", "apps.json"), JSON.stringify({ "mail-beta": { app: "mail", label: "베타 메일", filter: { conv: ["mail:beta-"] } } }));
afterAll(() => rmSync(join(DATA, "custom", "apps.json"), { force: true }));

const draft = (app: string, ref: string, extra: object = {}) => {
	const id = newId();
	addDraft({ id, kind: "mail", app, source: "nowhere", mailId: `m-${id}`, ref, to: "friend@example.com", body: "답", status: "pending", created: "2020-01-01T00:00:00.000Z", changes: [], questions: [], item: { kind: "mail", from: "friend@example.com", text: "x" }, ...extra });
	return id;
};

test("a mail draft is named after the mail app instance of its mail, whichever app the record carries", () => {
	expect(draftAppOf(draft("mail", "beta-1"))).toBe("mail-beta");
	expect(draftAppOf(draft("mail-beta", "beta-2"))).toBe("mail-beta");
	expect(draftAppOf(draft("mail", "plain-1"))).toBe("mail");
});

test("a composed mail keeps the app it was written for", () => {
	expect(draftAppOf(draft("mail-beta", "compose-x", { compose: true }))).toBe("mail-beta");
});
