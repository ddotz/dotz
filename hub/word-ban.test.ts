import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bannedHits, bannedNote, wordsFile } from "./word-ban.ts";

const dirs: string[] = [];
const fresh = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "word-ban-"));
	dirs.push(dir);
	return dir;
};
const put = (dir: string, content: unknown, mtimeSec?: number): void => {
	mkdirSync(join(dir, "custom"), { recursive: true });
	writeFileSync(wordsFile(dir), typeof content === "string" ? content : JSON.stringify(content));
	if (mtimeSec) utimesSync(wordsFile(dir), mtimeSec, mtimeSec);
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const LIST = { words: [{ word: "빨간 시험", use: "red test" }, { word: "게이트 머리", use: "gate HEAD" }, { word: "plain" }] };

test("no file and an empty list find nothing", () => {
	const dir = fresh();
	expect(bannedHits("빨간 시험", dir)).toEqual([]);
	put(dir, { words: [] });
	expect(bannedHits("빨간 시험", dir)).toEqual([]);
});

test("a listed word is a hit with its replacement; an unlisted text is not", () => {
	const dir = fresh();
	put(dir, LIST);
	expect(bannedHits("방금 빨간 시험을 고쳤어요", dir)).toEqual([{ word: "빨간 시험", use: "red test" }]);
	expect(bannedHits("red test is green", dir)).toEqual([]);
	const note = bannedNote(bannedHits("plain 빨간 시험", dir), dir);
	expect(note).toContain("빨간 시험");
	expect(note).toContain("red test");
	expect(note).toContain("plain");
});

test("matching ignores case and treats a space as any run of whitespace, including none", () => {
	const dir = fresh();
	put(dir, LIST);
	expect(bannedHits("PLAIN", dir).map(h => h.word)).toEqual(["plain"]);
	expect(bannedHits("빨간\n\t 시험", dir).map(h => h.word)).toEqual(["빨간 시험"]);
	expect(bannedHits("빨간시험", dir).map(h => h.word)).toEqual(["빨간 시험"]);
	expect(bannedHits("```\n게이트   머리\n```", dir).map(h => h.word)).toEqual(["게이트 머리"]);
});

test("an edit of the file is picked up when its mtime changes", () => {
	const dir = fresh();
	put(dir, { words: [{ word: "alpha" }] }, 1_700_000_000);
	expect(bannedHits("alpha beta", dir).map(h => h.word)).toEqual(["alpha"]);
	put(dir, { words: [{ word: "beta" }] }, 1_700_000_100);
	expect(bannedHits("alpha beta", dir).map(h => h.word)).toEqual(["beta"]);
	rmSync(wordsFile(dir));
	expect(bannedHits("alpha beta", dir)).toEqual([]);
});

test("a malformed file is an empty list and never throws", () => {
	const dir = fresh();
	put(dir, "{ not json");
	expect(bannedHits("anything", dir)).toEqual([]);
	put(dir, { words: "nope" }, 1_700_000_200);
	expect(bannedHits("anything", dir)).toEqual([]);
	put(dir, { words: [null, 3, { word: "" }, { word: "ok" }] }, 1_700_000_300);
	expect(bannedHits("this is ok", dir).map(h => h.word)).toEqual(["ok"]);
});
