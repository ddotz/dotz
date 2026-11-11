import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featurePrompt, INLINE_MAX, loadFeatureDirs } from "./featuredirs.ts";

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

test("a switch copy is told apart from the owner's own, and the prompt still names the shipped file", () => {
	const d = data();
	const copy = join(d, "features", "kakao", "feature.md");
	writeFileSync(copy, oldCopy(true));
	const f = loadFeatureDirs(d).features.find(x => x.id === "kakao")!;
	expect(f.switchFile).toBe(copy);
	expect(f.file).toBe(join(import.meta.dir, "..", "features", "kakao", "feature.md"));
	expect(featurePrompt(d, f.appliesTo === "lanes" ? "lanes" : "orchestrator")).toContain(`(${f.file}`);
});

test("custom: true keeps the owner's own text", () => {
	const d = data();
	writeFileSync(join(d, "features", "kakao", "feature.md"), oldCopy(true, "\ncustom: true"));
	const f = loadFeatureDirs(d).features.find(x => x.id === "kakao")!;
	expect(f.body).toContain("이전 버전의 본문이에요");
	expect(f.switchFile).toBeUndefined();
});

test("a long feature body costs one line and its path in the prompt; a short one goes in whole", () => {
	const d = mkdtempSync(join(tmpdir(), "dotz-feat-"));
	const write = (id: string, body: string) => {
		mkdirSync(join(d, "features", id), { recursive: true });
		writeFileSync(join(d, "features", id, "feature.md"), `---\nname: ${id}\nwhat: does ${id}\ntrigger: 메시지 도착\nstage: s\napplies_to: orchestrator\ncustom: true\n---\n${body}\n`);
	};
	write("zz-long", "L".repeat(INLINE_MAX + 1));
	write("zz-short", "short body");
	const prompt = featurePrompt(d, "orchestrator");
	expect(prompt).not.toContain("L".repeat(INLINE_MAX + 1));
	expect(prompt).toContain(join(d, "features", "zz-long", "feature.md"));
	expect(prompt).toContain("does zz-long.");
	expect(prompt).toContain("short body");
});
