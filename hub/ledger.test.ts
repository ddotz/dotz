import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "./ledger.ts";

const T0 = Date.parse("2026-11-10T09:00:00Z");
let dir: string, file: string, clock: number;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-ledger-"));
	file = join(dir, "ledger.json");
	clock = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const open = () => createLedger({ file, now: () => clock });
const source = { kind: "conversation" as const, ref: "main" };

describe("ledger store", () => {
	test("the file is mode 600, also when an older file with another mode was there", () => {
		const l = open();
		l.add({ what: "WHAT-A", source });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		chmodSync(file, 0o644);
		l.add({ what: "WHAT-B", source });
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("items survive a reload with their fields", () => {
		const added = open().add({ what: "WHAT-A", source: { kind: "mail", ref: "m1", project: "ch:1" }, due: "2026-11-12", next: "NEXT-A" });
		const back = open().list();
		expect(back).toEqual([added]);
		expect(added).toMatchObject({ state: "open", created: new Date(T0).toISOString(), due: "2026-11-12", next: "NEXT-A", source: { kind: "mail", ref: "m1", project: "ch:1" } });
	});

	test("done and cancel set the state and the closed time, and sort after the open items", () => {
		const l = open();
		const a = l.add({ what: "WHAT-A", source }), b = l.add({ what: "WHAT-B", source }), c = l.add({ what: "WHAT-C", source });
		clock += 1000;
		expect(l.done(a.id)).toMatchObject({ state: "done", closed: new Date(T0 + 1000).toISOString() });
		expect(l.cancel(b.id)).toMatchObject({ state: "cancelled", closed: new Date(T0 + 1000).toISOString() });
		expect(open().list().map(x => x.id)).toEqual([c.id, a.id, b.id]);
	});

	test("open items come by due date, those without a due date last", () => {
		const l = open();
		const none = l.add({ what: "WHAT-N", source }), late = l.add({ what: "WHAT-L", source, due: "2026-12-01" }), soon = l.add({ what: "WHAT-S", source, due: "2026-11-11" });
		expect(l.list().map(x => x.id)).toEqual([soon.id, late.id, none.id]);
	});

	test("edit changes fields and null clears due and next", () => {
		const l = open();
		const a = l.add({ what: "WHAT-A", source, due: "2026-11-12", next: "NEXT-A" });
		l.edit(a.id, { what: "WHAT-B", due: null, next: null });
		expect(open().list()[0]).toMatchObject({ id: a.id, what: "WHAT-B" });
		expect(open().list()[0]).not.toHaveProperty("due");
		expect(open().list()[0]).not.toHaveProperty("next");
		l.edit(a.id, { due: "2026-11-20", source: { kind: "mail", ref: "m2" } });
		expect(open().list()[0]).toMatchObject({ due: "2026-11-20", source: { kind: "mail", ref: "m2" } });
	});

	test("a changed due date clears the told marks, an unchanged one keeps them", () => {
		const l = open();
		const a = l.add({ what: "WHAT-A", source, due: "2026-11-12" });
		l.mark([a.id], ["before", "morning"]);
		l.edit(a.id, { due: "2026-11-12", next: "NEXT-A" });
		expect(open().list()[0]!.told?.morning).toBeDefined();
		l.edit(a.id, { due: "2026-11-20" });
		expect(open().list()[0]).not.toHaveProperty("told");
	});

	test("an unknown id throws and a file that does not parse starts empty", () => {
		expect(() => open().done("zzzzzz")).toThrow("zzzzzz");
		writeFileSync(file, "{ not json");
		expect(open().list()).toEqual([]);
	});
});
