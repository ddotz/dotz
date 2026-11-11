// A state file that is missing is told apart from one that could not be read or parsed: the second is logged and set aside, never taken for
// "nothing there" and then overwritten by the next write (hub/statefile.ts). Temp dirs only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHeld } from "./approval-queue.ts";
import { createStore } from "./comments/store.ts";
import { createDraft, listDrafts, readDrafts } from "./kakao/send.ts";
import { kakaoPaths } from "./kakao/types.ts";
import { readState } from "./statefile.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "state-read-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const asides = (name: string) => readdirSync(dir, { recursive: true }).map(String).filter(f => f.split("/").pop()!.startsWith(`${name}.bad-`));
const GARBAGE = '[{"code": "KAAAA", "chatId"';

test("readState: a missing file is absent and nothing is created or logged", () => {
	const notes: string[] = [];
	expect(readState(join(dir, "none.json"), l => notes.push(l))).toEqual({ state: "absent" });
	expect([readdirSync(dir), notes]).toEqual([[], []]);
});

test("readState: valid JSON is ok; unparseable text and a file that cannot be read are bad, logged, and kept aside", () => {
	const notes: string[] = [];
	writeFileSync(join(dir, "ok.json"), "[1]");
	expect(readState(join(dir, "ok.json"), l => notes.push(l))).toEqual({ state: "ok", value: [1] });
	writeFileSync(join(dir, "torn.json"), GARBAGE);
	expect(readState(join(dir, "torn.json"), l => notes.push(l))).toEqual({ state: "bad" });
	expect(asides("torn.json").map(f => readFileSync(join(dir, f), "utf8"))).toEqual([GARBAGE]);
	// a directory where the file should be: the read fails with a code other than ENOENT
	mkdirSync(join(dir, "dir.json"));
	expect(readState(join(dir, "dir.json"), l => notes.push(l))).toEqual({ state: "bad" });
	expect(asides("dir.json").length).toBe(1);
	expect(notes.length).toBe(2);
	expect(readState(join(dir, "torn.json"), l => notes.push(l))).toEqual({ state: "absent" });
});

test("kakao drafts: a damaged drafts file is kept aside when the next draft is saved, and a missing one leaves nothing aside", async () => {
	const paths = kakaoPaths(dir, dir);
	mkdirSync(join(dir, "kakao"), { recursive: true });
	const deps = { paths, runner: (async () => ({ code: 1, stdout: "", stderr: "" })) as never };
	const input = { chatId: "100", roomName: "방", text: "안녕", basisLogId: "1" };
	await createDraft(input, deps);
	expect(asides("drafts.json")).toEqual([]);
	writeFileSync(paths.drafts, GARBAGE);
	expect(readDrafts(paths)).toEqual([]);
	const saved = await createDraft(input, deps);
	expect((await listDrafts(deps)).map(d => d.code)).toEqual([saved.code]);
	expect(asides("drafts.json").map(f => readFileSync(join(dir, f), "utf8"))).toEqual([GARBAGE]);
	expect(readFileSync(join(dir, "hub.log"), "utf8")).toContain(paths.drafts);
});

test("held approval cards: a damaged file is kept aside instead of read as an empty list", () => {
	const file = join(dir, "held.json");
	const notes: string[] = [];
	expect(loadHeld(file, l => notes.push(l))).toEqual([]);
	writeFileSync(file, GARBAGE);
	expect(loadHeld(file, l => notes.push(l))).toEqual([]);
	expect(asides("held.json").map(f => readFileSync(join(dir, f), "utf8"))).toEqual([GARBAGE]);
	expect(notes.length).toBe(1);
});

test("comments store: a damaged file is kept aside before a write replaces it, a missing one is just empty", () => {
	const store = createStore(join(dir, "c"));
	expect(store.authors()).toEqual({});
	expect(readdirSync(dir, { recursive: true }).map(String).filter(f => f.includes(".bad-"))).toEqual([]);
	mkdirSync(join(dir, "c"), { recursive: true });
	writeFileSync(join(dir, "c", "authors.json"), GARBAGE);
	store.putAuthors({ a1: { username: "x" } });
	expect(Object.keys(store.authors())).toEqual(["a1"]);
	expect(asides("authors.json").map(f => readFileSync(join(dir, f), "utf8"))).toEqual([GARBAGE]);
});
