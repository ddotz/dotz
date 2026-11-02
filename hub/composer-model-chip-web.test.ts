import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The composer's model chip (web/js/14-slash-commands.js modelShort + modelChipText), run on the real source text. A long model id
// used to be printed whole and the chip row clipped on a phone (owner 2026-11-03); the label now stays within MODEL_CHIP_MAX.
const src = readFileSync(join(import.meta.dir, "..", "web", "js", "14-slash-commands.js"), "utf8");
const start = src.indexOf("const MODEL_CHIP_MAX");
const end = src.indexOf("function renderCtxRing");
if (start < 0 || end < 0) throw new Error("modelShort/modelChipText not found in 14-slash-commands.js");

const thinkKo = (level: string) => ({ low: "낮음", medium: "보통", high: "높음", max: "최고" })[level] ?? level;
const build = new Function("thinkKo", "M", `${src.slice(start, end)}\nreturn { modelShort, modelLabel, modelChipText, MODEL_CHIP_MAX };`);
const chip = (models: unknown = null) => build(thinkKo, models) as {
	modelShort: (sel: string) => string;
	modelLabel: (sel: string, a?: { name?: string }) => string;
	modelChipText: (sel: string) => string;
	MODEL_CHIP_MAX: number;
};

test("a long model id is shortened to the chip's width instead of being clipped", () => {
	const { modelShort, MODEL_CHIP_MAX } = chip();
	const label = modelShort("deepseek/deepseek-v4.1-flash-ultrafast");
	expect(label).toBe("V4.1 flash ultrafast");
	expect(label.length).toBeLessThanOrEqual(MODEL_CHIP_MAX);
	const repeated = modelShort("deepseek/deepseek-v4.1-flash-ultrafast");
	expect(repeated).not.toContain("deepseek");
	expect(modelShort("openai/gpt-5.2-codex")).toBe("Gpt 5.2 codex");
});

test("short ids keep their readable form", () => {
	const { modelShort } = chip();
	expect(modelShort("anthropic/claude-opus-5-5")).toBe("Opus 5.5");
	expect(modelShort("anthropic/claude-sonnet-4-5")).toBe("Sonnet 4.5");
	expect(modelShort("grok-4")).toBe("Grok 4");
	expect(modelShort("")).toBe("");
});

test("a single word too long for the bar is still cut to the cap rather than left whole", () => {
	const { modelShort, MODEL_CHIP_MAX } = chip();
	const one = modelShort("vendor/abcdefghijklmnopqrstuvwxyz012345");
	expect(one.length).toBeLessThanOrEqual(MODEL_CHIP_MAX);
});

test("the chip adds the effort and prefers a real catalog name over the derived label", () => {
	expect(chip().modelChipText("deepseek/deepseek-v4.1-flash-ultrafast:high")).toBe("V4.1 flash ultrafast · 높음");
	const named = chip({ pickable: [{ selector: "deepseek/deepseek-v4.1-flash-ultrafast", name: "DeepSeek V4.1 Flash" }] });
	expect(named.modelChipText("deepseek/deepseek-v4.1-flash-ultrafast")).toBe("DeepSeek V4.1 Flash");
	expect(chip({ available: [{ selector: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }] }).modelChipText("anthropic/claude-opus-5-5")).toBe("Opus 5.5");
});

test("a catalog entry named after its own id (deepseek) is shortened like a bare id", () => {
	const sel = "deepseek/deepseek-v4.1-flash-ultrafast";
	const deep = chip({ available: [{ selector: sel, name: sel }] });
	expect(deep.modelChipText(sel)).toBe("V4.1 flash ultrafast");
	expect(deep.modelLabel(sel, { name: "Some Very Long Catalog Name For This Model" })).toBe("Some Very Long Cata…");
});
