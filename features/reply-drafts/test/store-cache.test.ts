import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { paths } from "../lib/settings.ts";
import { addDraft, getDraft, isDrafted, listDrafts, type DraftRec } from "../lib/store.ts";
import { writeAtomic } from "../lib/settings.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => rmSync(paths.drafts(), { force: true }));

const rec = (n: number): DraftRec =>
	({ id: `R${n}`, kind: "mail", app: "mail", source: "zele", mailId: `m${n}`, ref: `k${n}`, to: "a@example.com", body: "b", status: "pending", created: new Date(n * 1000).toISOString(), changes: [], questions: [], item: { kind: "mail", subject: "s", text: "t", from: "f" } }) as unknown as DraftRec;

// The cards of one request ask for their draft one by one: the file is parsed once while it does not change, not once per question.
test("reading many drafts of an unchanged file parses it once", () => {
	for (let i = 0; i < 20; i++) addDraft(rec(i));
	const parse = spyOn(JSON, "parse");
	for (let i = 0; i < 20; i++) {
		getDraft(`R${i}`);
		isDrafted(`k${i}`);
	}
	const parsed = parse.mock.calls.length;
	parse.mockRestore();
	expect(parsed).toBeLessThanOrEqual(1);
});

test("a write by another process (a new file) shows at once", () => {
	addDraft(rec(1));
	expect(getDraft("R1")?.status).toBe("pending");
	writeAtomic(paths.drafts(), `${JSON.stringify({ drafts: [{ ...rec(1), status: "sent" }], keys: ["k1", "k9"] })}\n`);
	expect(getDraft("R1")?.status).toBe("sent");
	expect(isDrafted("k9")).toBe(true);
});

test("changing a returned draft does not change the stored one", () => {
	addDraft(rec(2));
	getDraft("R2")!.status = "dropped";
	listDrafts()[0]!.body = "x";
	expect(getDraft("R2")?.status).toBe("pending");
	expect(getDraft("R2")?.body).toBe("b");
});
