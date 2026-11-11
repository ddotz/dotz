import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { paths } from "../lib/settings.ts";
import { addDraft, getDraft, isDrafted, listDrafts, markDrafted, setStatus, type DraftRec, type DraftStatus } from "../lib/store.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => rmSync(paths.drafts(), { force: true }));

const rec = (n: number, status: DraftStatus = "pending"): DraftRec =>
	({ id: `R${n}`, kind: "mail", app: "mail", source: "zele", mailId: `m${n}`, ref: `k${n}`, to: "a@example.com", body: "b", status, created: new Date(n * 1000).toISOString(), changes: [], questions: [], item: {} }) as unknown as DraftRec;

test("a backlog past the cap never deletes a pending or held draft", () => {
	addDraft(rec(0));
	addDraft(rec(1, "held"));
	for (let i = 2; i < 260; i++) addDraft(rec(i));
	expect(getDraft("R0")?.status).toBe("pending");
	expect(getDraft("R1")?.status).toBe("held");
	expect(listDrafts()).toHaveLength(260);
});

test("only closed drafts are trimmed, oldest first", () => {
	for (let i = 0; i < 230; i++) addDraft(rec(i));
	for (let i = 0; i < 230; i++) if (i !== 3) setStatus(`R${i}`, "sent");
	addDraft(rec(999));
	const ids = new Set(listDrafts().map(d => d.id));
	expect(ids.has("R3")).toBe(true);
	expect(ids.has("R999")).toBe(true);
	expect(ids.has("R0")).toBe(false);
	expect(listDrafts().filter(d => d.status === "sent")).toHaveLength(200);
});

test("a mail whose draft is still kept stays looked-at even past the key horizon", () => {
	addDraft(rec(0));
	for (let i = 0; i < 2100; i++) markDrafted(`x${i}`);
	expect(isDrafted("k0")).toBe(true);
});
