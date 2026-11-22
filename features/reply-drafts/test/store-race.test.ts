import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { correctionsOf, loadSettings, paths } from "../lib/settings.ts";
import { addDraft, DraftStoreUnreadable, getDraft, isDrafted, listDrafts, unlessUnreadable, type DraftRec } from "../lib/store.ts";
import { setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
const clear = () => {
	const dir = dirname(paths.drafts());
	if (existsSync(paths.drafts())) chmodSync(paths.drafts(), 0o600);
	if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith("drafts.json")) rmSync(join(dir, f), { force: true, recursive: true });
	rmSync(paths.config(), { force: true });
	rmSync(paths.toneDir(), { force: true, recursive: true });
};
beforeEach(clear);
afterEach(clear);

const rec = (id: string, ref: string, created: string): DraftRec =>
	({ id, kind: "mail", app: "mail", source: "zele", mailId: id, ref, to: "a@example.com", body: "b", status: "pending", created, changes: [], questions: [], item: { kind: "mail", from: "a@example.com", text: "t" } }) as DraftRec;

const writers = async (what: string, count: number) => {
	const run = (tag: string) => Bun.spawn(["bun", join(import.meta.dir, "store-writer.ts"), what, tag, String(count)], { env: { ...process.env, DOTZ_DIR: env.dir }, stdout: "ignore", stderr: "pipe", timeout: 60_000 });
	const procs = [run("A"), run("B")];
	await Promise.all(procs.map(p => p.exited));
	for (const p of procs) expect(p.exitCode, await new Response(p.stderr).text()).toBe(0);
};

test("a drafts.json that does not parse is moved aside and logged, and the next draft starts a fresh store", () => {
	for (let i = 0; i < 3; i++) addDraft(rec(`R00000${i}`, `m-${i}`, "2026-11-01T00:00:00.000Z"));
	const good = readFileSync(paths.drafts(), "utf8");
	writeFileSync(paths.drafts(), good.slice(0, -40));
	const logged = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		addDraft(rec("R999999", "m-new", "2026-11-02T00:00:00.000Z"));
		expect(logged.mock.calls.some(c => String(c[0]).includes("did not parse"))).toBe(true);
	} finally {
		logged.mockRestore();
	}
	const aside = readdirSync(dirname(paths.drafts())).filter(f => f.startsWith("drafts.json.corrupt-"));
	expect(aside).toHaveLength(1);
	expect(readFileSync(join(dirname(paths.drafts()), aside[0]!), "utf8")).toBe(good.slice(0, -40));
	expect(listDrafts().map(d => d.id)).toEqual(["R999999"]);
});

test("a drafts.json that cannot be read is neither taken for an empty store nor written over", () => {
	addDraft(rec("R000001", "m-1", "2026-11-01T00:00:00.000Z"));
	const before = readFileSync(paths.drafts(), "utf8");
	chmodSync(paths.drafts(), 0o000);
	expect(() => listDrafts()).toThrow(DraftStoreUnreadable);
	expect(() => isDrafted("m-1")).toThrow(DraftStoreUnreadable);
	expect(() => addDraft(rec("R000002", "m-2", "2026-11-02T00:00:00.000Z"))).toThrow(DraftStoreUnreadable);
	chmodSync(paths.drafts(), 0o600);
	expect(readFileSync(paths.drafts(), "utf8")).toBe(before);
	expect(readdirSync(dirname(paths.drafts())).filter(f => f.startsWith("drafts.json.corrupt-"))).toEqual([]);
});

test("addDraft never makes a newer waiting draft of the same mail stale: the older one it brings is stored stale", () => {
	addDraft(rec("RNEWER1", "m-1", "2026-11-02T00:00:00.000Z"));
	addDraft(rec("ROLDER1", "m-1", "2026-11-01T00:00:00.000Z"));
	expect(getDraft("RNEWER1")?.status).toBe("pending");
	expect(getDraft("ROLDER1")?.status).toBe("stale");
	addDraft(rec("RNEWEST", "m-1", "2026-11-03T00:00:00.000Z"));
	expect(getDraft("RNEWER1")?.status).toBe("stale");
	expect(getDraft("RNEWEST")?.status).toBe("pending");
});

test("a start-up step over a store that cannot be read logs one line and goes on; a readable store gives its value; other errors still throw", () => {
	addDraft(rec("RBOOTAB", "m-1", "2026-11-01T00:00:00.000Z"));
	const lines: string[] = [];
	const count = () => unlessUnreadable(() => listDrafts().length, undefined, line => lines.push(line));
	chmodSync(paths.drafts(), 0o000);
	expect(count()).toBeUndefined();
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain(paths.drafts());
	chmodSync(paths.drafts(), 0o600);
	expect(count()).toBe(1);
	expect(lines).toHaveLength(1);
	expect(() => unlessUnreadable(() => { throw new Error("boom"); }, undefined, line => lines.push(line))).toThrow("boom");
});

test("two processes adding and closing drafts at once lose no draft and no status", async () => {
	await writers("drafts", 50);
	const drafts = listDrafts();
	expect(drafts).toHaveLength(100);
	expect(drafts.filter(d => d.status !== "sent").map(d => d.id)).toEqual([]);
	expect(new Set(drafts.map(d => d.id[0]))).toEqual(new Set(["A", "B"]));
}, 60_000);

test("two processes recording corrections in one tone profile lose none", async () => {
	await writers("tone", 25);
	expect(correctionsOf({ app: "mail" })).toHaveLength(50);
}, 60_000);

test("two processes saving different settings keep each one's last value", async () => {
	await writers("settings", 40);
	const s = loadSettings();
	expect(s.model).toBe("m39");
	expect(s.senders.only).toEqual(["b39@example.com"]);
}, 60_000);
