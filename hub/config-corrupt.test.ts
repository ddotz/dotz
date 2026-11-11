// A state file that does not parse is set aside, never deleted or overwritten, and the gateway starts from its last good copy or defaults.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonOrQuarantine, takeRecoveries } from "./config.ts";

let dir = "";
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-corrupt-"))));
afterEach(() => {
	takeRecoveries();
	rmSync(dir, { recursive: true, force: true });
});
const aside = (name: string) => readdirSync(dir).filter(f => f.startsWith(`${name}.corrupt-`));

test("a file that does not parse is kept aside, defaults take over, and one recovery is reported", () => {
	const file = join(dir, "schedules.json");
	writeFileSync(file, '[{"id":"a1","text":"x"');
	expect(readJsonOrQuarantine<unknown[]>(file, () => [])).toEqual([]);
	const [kept] = aside("schedules.json");
	expect(readFileSync(join(dir, kept!), "utf8")).toBe('[{"id":"a1","text":"x"');
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
	expect(takeRecoveries()).toEqual([{ file, moved: join(dir, kept!), restored: false }]);
	expect(takeRecoveries()).toEqual([]);
});

test("the last copy that parsed at an earlier start is put back", () => {
	const file = join(dir, "watches.json");
	writeFileSync(file, '[{"id":"w1"}]');
	expect(readJsonOrQuarantine<unknown[]>(file, () => [])).toEqual([{ id: "w1" }]);
	writeFileSync(file, '[{"id":"w1"');
	expect(readJsonOrQuarantine<unknown[]>(file, () => [])).toEqual([{ id: "w1" }]);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ id: "w1" }]);
	expect(takeRecoveries()).toMatchObject([{ file, restored: true }]);
	expect(aside("watches.json")).toHaveLength(1);
});

test("a big history opts out of the good copy, and its broken original is never overwritten by the empty list", () => {
	const file = join(dir, "mail-conversations.json");
	writeFileSync(file, '[{"key":"m1"');
	expect(readJsonOrQuarantine<unknown[]>(file, () => [], { keepGood: false })).toEqual([]);
	expect(existsSync(`${file}.good`)).toBe(false);
	const [kept] = aside("mail-conversations.json");
	expect(readFileSync(join(dir, kept!), "utf8")).toBe('[{"key":"m1"');
});

test("a missing or readable file is read as is and reports nothing", () => {
	const file = join(dir, "config.json");
	expect(readJsonOrQuarantine(file, () => ({ d: 1 }))).toEqual({ d: 1 });
	writeFileSync(file, '{"a":2}');
	expect(readJsonOrQuarantine(file, () => ({ d: 1 }))).toEqual({ a: 2 });
	expect(takeRecoveries()).toEqual([]);
	expect(aside("config.json")).toEqual([]);
});
