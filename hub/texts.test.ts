// Text overrides of the custom layer (hub/texts.ts) against temp data folders and the real catalogs; the new-mail wake text.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGS, LOCKED_TEXTS } from "./i18n.ts";
import { applyTexts, defaultHash, reportTexts, setText, textProblems, textsPath } from "./texts.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-texts-"));
	mkdirSync(join(dir, "custom"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (doc: unknown) => writeFileSync(textsPath(dir), JSON.stringify(doc));

const shipped = { greeting: "hello", mail: (to: string, n: number) => `mail ${to} ${n}`, youAre: "lead", nested: { a: "x" } };

test("override replaces a string and fills the arguments of a function key; locked, nested and unknown keys stay shipped", () => {
	expect(applyTexts(shipped, dir)).toBe(shipped);
	write({ greeting: "hi", mail: { text: "to={1} n={2} again={1}" }, youAre: "x", nested: "x", nothing: "x" });
	const t = applyTexts(shipped, dir, new Set(["youAre"]));
	expect(t.greeting).toBe("hi");
	expect(t.mail("a@b", 3)).toBe("to=a@b n=3 again=a@b");
	expect(t.youAre).toBe("lead");
	expect(t.nested).toEqual({ a: "x" });
	expect(applyTexts(shipped, dir, new Set(["youAre"]))).toBe(t);
});

test("a changed file is picked up without a restart", () => {
	write({ greeting: "one" });
	expect(applyTexts(shipped, dir).greeting).toBe("one");
	write({ greeting: "two, longer" });
	expect(applyTexts(shipped, dir).greeting).toBe("two, longer");
});

test("a stale default or a vanished key is reported once; the override keeps applying", () => {
	const hash = defaultHash(shipped, "greeting");
	write({ greeting: { text: "hi", default: hash }, mail: { text: "m {1}", default: "00000000" }, gone: { text: "x", default: "11111111" } });
	expect(textProblems(shipped, dir).map(p => `${p.key}:${p.kind}`).sort()).toEqual(["gone:missing", "mail:stale"]);
	const first = reportTexts(shipped, dir);
	expect(first).toHaveLength(2);
	expect(first.join("\n")).toContain("mail");
	expect(first.join("\n")).toContain("gone");
	expect(reportTexts(shipped, dir)).toEqual([]);
	expect(applyTexts(shipped, dir).mail("a", 1)).toBe("m a");

	const newer = { ...shipped, greeting: "hello there" };
	const again = reportTexts(newer, dir);
	expect(again).toHaveLength(1);
	expect(again[0]).toContain("greeting");
	expect(reportTexts(newer, dir)).toEqual([]);
});

test("setText stores the current default hash, so the override is not stale until the shipped text changes", () => {
	setText(shipped, dir, "mail", "x {2} {1}");
	expect(textProblems(shipped, dir)).toEqual([]);
	expect(textProblems({ ...shipped, mail: (to: string, n: number) => `changed ${to} ${n}` }, dir).map(p => p.kind)).toEqual(["stale"]);
	expect(() => setText(shipped, dir, "youAre", "x", new Set(["youAre"]))).toThrow();
});

test("the real catalogs: inboxMail can be overridden and youAre cannot", () => {
	for (const c of Object.values(CATALOGS)) {
		expect(defaultHash(c, "inboxMail", LOCKED_TEXTS)).toBeString();
		expect(defaultHash(c, "youAre", LOCKED_TEXTS)).toBeUndefined();
	}
	write({ inboxMail: { text: "mail for {1}", default: defaultHash(CATALOGS.ko, "inboxMail") }, youAre: "x" });
	const t = applyTexts(CATALOGS.ko, dir, LOCKED_TEXTS);
	expect(t.inboxMail("th:7")).toBe("mail for th:7");
	expect(t.youAre).toBe(CATALOGS.ko.youAre);
	expect(textProblems(CATALOGS.ko, dir, LOCKED_TEXTS).map(p => `${p.key}:${p.kind}`)).toEqual(["youAre:locked"]);
});

test("the real catalogs: the notes that send a session's card back keep their own keys, so an install's wording for them applies", () => {
	const keys = ["askRefused", "askTitleRefused", "askLongTitleRefused", "askLeadRefused", "askProseRefused"] as const;
	for (const c of Object.values(CATALOGS)) for (const key of keys) expect(defaultHash(c, key, LOCKED_TEXTS)).toBeString();
	write({ askTitleRefused: { text: "제목 {1}에 주제를 넣어 주세요.\n{2}", default: defaultHash(CATALOGS.ko, "askTitleRefused") } });
	const t = applyTexts(CATALOGS.ko, dir, LOCKED_TEXTS);
	expect(t.askTitleRefused("어떻게 할까요?", "본문")).toBe("제목 어떻게 할까요?에 주제를 넣어 주세요.\n본문");
	expect(textProblems(CATALOGS.ko, dir, LOCKED_TEXTS)).toEqual([]);
	for (const key of keys) setText(CATALOGS.ko, dir, key, `${key} {1}`, LOCKED_TEXTS);
	expect(applyTexts(CATALOGS.ko, dir, LOCKED_TEXTS).askLeadRefused(3, "본문")).toBe("askLeadRefused 3");
});

test("the new-mail wake text names its conversation, the draft command and the revise marker in both languages", () => {
	for (const c of Object.values(CATALOGS)) {
		const t = c.inboxMail("th:7");
		for (const part of ["th:7", "draft.ts draft", "[revise "]) expect(t).toContain(part);
	}
});
