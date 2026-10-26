// tailEvents parsed the whole inbox/outbox tail (up to 4 MB each) on every chat history page, conversation list, decision card and file
// check. It now keeps what it parsed and reads only the appended bytes; the result must stay what a fresh read of the window gives.
import { afterAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailEvents } from "./events.ts";

const dir = mkdtempSync(join(tmpdir(), "dotz-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const line = (n: number, pad = "") => `${JSON.stringify({ ts: `2026-10-26T00:00:${String(n).padStart(6, "0")}Z`, kind: "out", source: "t", text: `m${n}${pad}` })}\n`;
const parses = () => {
	const spy = spyOn(JSON, "parse");
	return { count: () => spy.mock.calls.length, done: () => spy.mockRestore() };
};

test("an unchanged file is not parsed again, and an append parses only the new line", () => {
	const file = join(dir, "a.jsonl");
	writeFileSync(file, Array.from({ length: 500 }, (_, i) => line(i)).join(""));
	expect(tailEvents(file)).toHaveLength(500);
	const p = parses();
	try {
		expect(tailEvents(file)).toHaveLength(500);
		expect(p.count()).toBe(0);
		appendFileSync(file, line(500));
		const after = tailEvents(file);
		expect(p.count()).toBe(1);
		expect(after.at(-1)?.text).toBe("m500");
		expect(after).toHaveLength(501);
	} finally {
		p.done();
	}
});

test("a caller changing the returned list does not change the next answer", () => {
	const file = join(dir, "b.jsonl");
	writeFileSync(file, line(1) + line(2));
	tailEvents(file).length = 0;
	expect(tailEvents(file).map(e => e.text)).toEqual(["m1", "m2"]);
});

test("a rewritten (trimmed) file, a half-written last line and the 4 MB window read the same as a fresh read", () => {
	const file = join(dir, "c.jsonl");
	writeFileSync(file, line(1) + line(2) + line(3));
	tailEvents(file);
	writeFileSync(file, line(3));
	expect(tailEvents(file).map(e => e.text)).toEqual(["m3"]);
	appendFileSync(file, line(4).slice(0, 20));
	expect(tailEvents(file).map(e => e.text)).toEqual(["m3"]);
	appendFileSync(file, line(4).slice(20));
	expect(tailEvents(file).map(e => e.text)).toEqual(["m3", "m4"]);

	const big = join(dir, "d.jsonl");
	const pad = "x".repeat(2000);
	writeFileSync(big, Array.from({ length: 2200 }, (_, i) => line(i, pad)).join(""));
	const first = tailEvents(big);
	for (let i = 2200; i < 2300; i++) appendFileSync(big, line(i, pad));
	const grown = tailEvents(big);
	const fresh = join(dir, "e.jsonl");
	writeFileSync(fresh, Array.from({ length: 2300 }, (_, i) => line(i, pad)).join(""));
	expect(first.length).toBeLessThan(2200);
	expect(grown.map(e => e.text)).toEqual(tailEvents(fresh).map(e => e.text));
	expect(grown.at(-1)?.text).toBe(`m2299${pad}`);
});
