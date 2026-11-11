import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, type Ledger, type LedgerItem } from "./ledger.ts";
import { ledgerApi } from "./ledger-api.ts";

const NOW = new Date(2026, 10, 10, 9, 0).getTime();
let dir: string, store: Ledger;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-ledger-api-"));
	store = createLedger({ file: join(dir, "ledger.json"), now: () => NOW });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (method: string, rest: string[], input: Record<string, unknown> = {}, query = "") => ledgerApi(store, method, rest, new URLSearchParams(query), input, NOW);
const add = (input: Record<string, unknown>) => (call("POST", [], { session: "main", ...input })!.body as { item: LedgerItem }).item;
const status = (fn: () => unknown): number | undefined => {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status ?? 400;
	}
};

describe("add", () => {
	test("what must be a non-empty text of at most 300 characters", () => {
		expect(status(() => add({ what: "  " }))).toBe(400);
		expect(status(() => add({}))).toBe(400);
		expect(status(() => add({ what: "x".repeat(301) }))).toBe(400);
		expect(add({ what: "x".repeat(300) }).what).toHaveLength(300);
	});

	test("due must be a real YYYY-MM-DD date", () => {
		for (const due of ["2026-02-30", "2026-2-3", "tomorrow", "2026-13-01", 20261112]) expect(status(() => add({ what: "WHAT-A", due }))).toBe(400);
		expect(add({ what: "WHAT-A", due: "2028-02-29" }).due).toBe("2028-02-29");
		expect(store.list()).toHaveLength(1);
	});

	test("the source is the mail id, or the conversation the agent session belongs to", () => {
		expect(add({ what: "WHAT-A" }).source).toEqual({ kind: "conversation", ref: "main" });
		expect(add({ what: "WHAT-B", mail: "m-1" }).source).toEqual({ kind: "mail", ref: "m-1" });
		expect(add({ what: "WHAT-C", project: "ch:100" }).source).toEqual({ kind: "conversation", ref: "ch:100", project: "ch:100" });
		expect(status(() => add({ what: "WHAT-D", project: "somewhere" }))).toBe(400);
	});
});

describe("transitions", () => {
	test("done and cancel work from open only; an unknown id is 404", () => {
		const a = add({ what: "WHAT-A" }), b = add({ what: "WHAT-B" });
		expect(call("POST", [a.id, "done"])!.status).toBe(200);
		expect(status(() => call("POST", [a.id, "done"]))).toBe(409);
		expect(status(() => call("POST", [a.id, "cancel"]))).toBe(409);
		expect(status(() => call("PATCH", [a.id], { what: "WHAT-X" }))).toBe(409);
		expect(call("POST", [b.id, "cancel"])!.status).toBe(200);
		expect(status(() => call("POST", ["zzzzzz", "done"]))).toBe(404);
		expect(store.list().map(x => x.state)).toEqual(["done", "cancelled"]);
	});

	test("edit validates like add and null clears due and next", () => {
		const a = add({ what: "WHAT-A", due: "2026-11-12", next: "NEXT-A" });
		expect(status(() => call("PATCH", [a.id], { due: "2026-02-30" }))).toBe(400);
		expect(status(() => call("PATCH", [a.id], { what: "" }))).toBe(400);
		call("PATCH", [a.id], { what: "WHAT-B", due: null, next: null });
		const back = store.list()[0]!;
		expect(back.what).toBe("WHAT-B");
		expect(back).not.toHaveProperty("due");
		expect(back).not.toHaveProperty("next");
	});

	test("a request it does not own is left to the route chain", () => {
		expect(call("DELETE", ["abc123"])).toBeUndefined();
		expect(call("PUT", [])).toBeUndefined();
	});
});

describe("list", () => {
	test("range week keeps what is due within 7 days, overdue ones and those with no due date", () => {
		const overdue = add({ what: "WHAT-O", due: "2026-11-08" }), edge = add({ what: "WHAT-E", due: "2026-11-17" }), far = add({ what: "WHAT-F", due: "2026-11-18" }), none = add({ what: "WHAT-N" });
		const ids = (query: string) => (call("GET", [], {}, query)!.body as { items: LedgerItem[] }).items.map(x => x.id);
		expect(ids("range=week")).toEqual([overdue.id, edge.id, none.id]);
		expect(ids("")).toEqual([overdue.id, edge.id, far.id, none.id]);
	});

	test("closed items show only with state=all; rows have four cells and a pipe in a text does not split one", () => {
		const a = add({ what: "WHAT|A", next: "NEXT-A", due: "2026-11-12" }), b = add({ what: "WHAT-B" });
		call("POST", [b.id, "done"]);
		const text = (query: string) => (call("GET", [], {}, query)!.body as { text: string }).text;
		expect(text("")).toContain("NEXT-A");
		expect(text("").split("\n")).toHaveLength(1);
		const rows = text("state=all").split("\n");
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.split(" | ")).toHaveLength(4);
		expect(rows[0]!.split(" | ")[2]).toBe("11-12");
		expect(a.id).not.toBe(b.id);
	});

	test("an empty list is a line of text, not an empty block", () => {
		expect((call("GET", [])!.body as { text: string }).text.length).toBeGreaterThan(0);
	});
});
