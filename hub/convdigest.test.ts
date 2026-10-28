// The digest main's next prompt carries: what happened in the conversations it does not answer itself, once each, and nothing
// when nothing happened. It is what lets the main session cover the other windows (owner 2026-10-28).
import { expect, test } from "bun:test";
import { createConvDigest, DIGEST_CONVS } from "./convdigest.ts";

test("a conversation's last owner message and answer appear in main's digest, once", () => {
	const d = createConvDigest();
	d.note("mail:k1", "owner", "이 파일 어디 갔어?");
	d.note("mail:k1", "bot", "파일은 그대로 있어요.", Date.now(), "mail:k1");
	const text = d.take("main");
	expect(text).toContain("mail:k1");
	expect(text).toContain("파일 어디 갔어");
	expect(text).toContain("파일은 그대로 있어요");
	expect(text).toContain("dotz_conv read");
	expect(d.take("main")).toBe("");
});

test("an empty digest adds nothing, and a conversation never lists its own exchange", () => {
	const d = createConvDigest();
	expect(d.take("main")).toBe("");
	d.note("mail:k1", "owner", "hello");
	expect(d.take("mail:k1")).toBe("");
	expect(d.take("main")).toContain("mail:k1");
});

test("what a session posted itself is not told back to it", () => {
	const d = createConvDigest();
	d.note("mail:k1", "bot", "main's own note", Date.now(), "main");
	expect(d.take("main")).toBe("");
});

test("the digest names at most 8 conversations, newest first, within its character budget", () => {
	const d = createConvDigest();
	for (let i = 0; i < 12; i++) d.note(`ch:${i}`, "owner", `질문 ${i}`, 1_000 + i);
	const text = d.take("main");
	const keys = [...text.matchAll(/ch:(\d+)/g)].map(m => Number(m[1]));
	expect(keys.length).toBe(DIGEST_CONVS);
	expect(keys[0]).toBe(11);
	expect(text.length).toBeLessThan(1600);
});

test("a later take carries only what is new since the last one", () => {
	const d = createConvDigest();
	d.note("ch:1", "owner", "first", Date.now() - 1000);
	expect(d.take("main")).toContain("first");
	d.note("ch:1", "owner", "second");
	const text = d.take("main");
	expect(text).toContain("second");
	expect(text).not.toContain("first");
});
