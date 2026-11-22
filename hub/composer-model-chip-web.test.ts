import { afterAll, expect, test } from "bun:test";
import { ev, fakeHub, waitFor } from "./test-web.ts";

// The composer's model chip (web/js/14-slash-commands.js modelShort + modelChipText), called on the real page. A long model id
// used to be printed whole and the chip row clipped on a phone (owner 2026-11-03); the label now stays within MODEL_CHIP_MAX.
const hub = fakeHub();
afterAll(() => hub.stop());
const view = await hub.view({}, "/");
await waitFor(view, `typeof modelChipText === "function" && S`);
const call = <T>(expr: string, models: unknown = null) => ev<T>(view, `(M = ${JSON.stringify(models)}, ${expr})`);
const short = (sel: string) => call<string>(`modelShort(${JSON.stringify(sel)})`);
const chipText = (sel: string, models: unknown = null) => call<string>(`modelChipText(${JSON.stringify(sel)})`, models);
const max = () => ev<number>(view, "MODEL_CHIP_MAX");

test("a long model id is shortened to the chip's width instead of being clipped", async () => {
	const label = await short("deepseek/deepseek-v4.1-flash-ultrafast");
	expect(label).toBe("V4.1 flash ultrafast");
	expect(label.length).toBeLessThanOrEqual(await max());
	expect(label).not.toContain("deepseek");
	expect(await short("openai/gpt-5.2-codex")).toBe("Gpt 5.2 codex");
});

test("short ids keep their readable form", async () => {
	expect(await short("anthropic/claude-opus-5-5")).toBe("Opus 5.5");
	expect(await short("anthropic/claude-sonnet-4-5")).toBe("Sonnet 4.5");
	expect(await short("grok-4")).toBe("Grok 4");
	expect(await short("")).toBe("");
});

test("a single word too long for the bar is still cut to the cap rather than left whole", async () => {
	expect((await short("vendor/abcdefghijklmnopqrstuvwxyz012345")).length).toBeLessThanOrEqual(await max());
});

test("the chip adds the effort and prefers a real catalog name over the derived label", async () => {
	expect(await chipText("deepseek/deepseek-v4.1-flash-ultrafast:high")).toBe("V4.1 flash ultrafast · 높음");
	const named = { pickable: [{ selector: "deepseek/deepseek-v4.1-flash-ultrafast", name: "DeepSeek V4.1 Flash" }] };
	expect(await chipText("deepseek/deepseek-v4.1-flash-ultrafast", named)).toBe("DeepSeek V4.1 Flash");
	expect(await chipText("anthropic/claude-opus-5-5", { available: [{ selector: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }] })).toBe("Opus 5.5");
});

test("a catalog entry named after its own id (deepseek) is shortened like a bare id", async () => {
	const sel = "deepseek/deepseek-v4.1-flash-ultrafast";
	expect(await chipText(sel, { available: [{ selector: sel, name: sel }] })).toBe("V4.1 flash ultrafast");
	expect(await call<string>(`modelLabel(${JSON.stringify(sel)}, { name: "Some Very Long Catalog Name For This Model" })`)).toBe("Some Very Long Cata…");
});
