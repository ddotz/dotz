import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatureDirs } from "./featuredirs.ts";

// A personal folder with a shipped id switches the shipped feature on or off; it does not freeze the shipped text (onboarding and
// app-off write such copies, and an update must still reach them). `custom: true` keeps an owner's own text.
const shippedText = readFileSync(join(import.meta.dir, "..", "features", "kakao", "feature.md"), "utf8");
const data = () => {
	const d = mkdtempSync(join(tmpdir(), "dotz-feat-"));
	mkdirSync(join(d, "features", "kakao"), { recursive: true });
	return d;
};
const oldCopy = (enabled: boolean, extra = "") => shippedText.replace(/^enabled:\s*\w+\s*$/m, `enabled: ${enabled}${extra}`).replace(/\n---[ \t]*\n[\s\S]*$/, "\n---\n이전 버전의 본문이에요.\n");

test("an old personal copy turns the shipped feature on, and the text is the shipped one of this version", () => {
	const d = data();
	writeFileSync(join(d, "features", "kakao", "feature.md"), oldCopy(true));
	const f = loadFeatureDirs(d).features.find(x => x.id === "kakao")!;
	expect(f.enabled).toBe(true);
	expect(f.origin).toBe("personal");
	expect(f.body).not.toContain("이전 버전의 본문이에요");
	expect(f.body.length).toBeGreaterThan(50);
});

test("custom: true keeps the owner's own text", () => {
	const d = data();
	writeFileSync(join(d, "features", "kakao", "feature.md"), oldCopy(true, "\ncustom: true"));
	const f = loadFeatureDirs(d).features.find(x => x.id === "kakao")!;
	expect(f.body).toContain("이전 버전의 본문이에요");
});
