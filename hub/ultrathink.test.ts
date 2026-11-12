// ownerWantsUltrathink: the keyword counts only in the owner's own plain text.
import { expect, test } from "bun:test";
import { ownerWantsUltrathink as wants } from "./ultrathink.ts";

test("the bare keyword counts, in any case and next to punctuation", () => {
	expect(wants("ultrathink")).toBe(true);
	expect(wants("please ULTRATHINK about this")).toBe(true);
	expect(wants("Ultrathink: why does it fail?")).toBe(true);
	expect(wants("이거 좀 ultrathink 해서 봐줘")).toBe(true);
	expect(wants("first line\nthen ultrathink here")).toBe(true);
});

test("a different word or no keyword does not count", () => {
	expect(wants("")).toBe(false);
	expect(wants("think hard")).toBe(false);
	expect(wants("ultrathinking is a word")).toBe(false);
	expect(wants("nonultrathink")).toBe(false);
});

test("inline code and code blocks do not count", () => {
	expect(wants("the keyword `ultrathink` is special")).toBe(false);
	expect(wants("run:\n```\nultrathink\n```\nplease")).toBe(false);
	expect(wants("```sh\nnot closed ultrathink")).toBe(false);
	expect(wants("the `code` then ultrathink")).toBe(true);
});

test("text inside quotation marks does not count", () => {
	expect(wants('he wrote "ultrathink" in the prompt')).toBe(false);
	expect(wants("he wrote \u201Cultrathink\u201D in it")).toBe(false);
	expect(wants("it says 'ultrathink' there")).toBe(false);
	expect(wants("\u300Cultrathink\u300D\uB77C\uACE0 \uC37C\uC5B4")).toBe(false);
	expect(wants("> ultrathink\nquoted line above")).toBe(false);
	expect(wants('"quoted" and ultrathink')).toBe(true);
	expect(wants("don't stop, ultrathink it")).toBe(true);
});

test("a URL or a file path does not count", () => {
	expect(wants("see https://example.com/ultrathink for details")).toBe(false);
	expect(wants("open docs/ultrathink.md")).toBe(false);
	expect(wants("cat ~/notes/ultrathink")).toBe(false);
	expect(wants("cd /tmp/ultrathink now")).toBe(false);
	expect(wants("C:\\work\\ultrathink\\a.txt")).toBe(false);
	expect(wants("see https://example.com/a and ultrathink")).toBe(true);
});

test("a message that starts with a slash does not count", () => {
	expect(wants("/model ultrathink")).toBe(false);
	expect(wants("  /effort ultrathink")).toBe(false);
	expect(wants("hi /model ultrathink")).toBe(true);
});
