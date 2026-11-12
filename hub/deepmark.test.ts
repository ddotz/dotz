// The line a deep owner message carries: the raise line only on OmO's configured, cache-keeping model, the plain hint line elsewhere.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEEP_TURN } from "../extension/effort-bound.ts";
import { DEEP_HINT, DEEP_RAISE, markDeep } from "./deepmark.ts";

const saved = process.env.OMO_CODING_AGENT_DIR;
beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), "deepmark-"));
	const model = (id: string, flag: boolean) => ({ id, compat: { supportsMidConvoEffort: flag } });
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [model("keeps", true), model("loses", false)] } } }));
	process.env.OMO_CODING_AGENT_DIR = dir;
});
afterAll(() => void (saved === undefined ? delete process.env.OMO_CODING_AGENT_DIR : (process.env.OMO_CODING_AGENT_DIR = saved)));

const session = { name: "orchestrator", runtime: "omo", model: "p/keeps", onFallback: false };
function mark(over: Partial<typeof session> = {}, text = "think hard") {
	const lines: string[] = [];
	return { text: markDeep(text, { ...session, ...over }, line => void lines.push(line)), lines };
}

test("OmO on its configured, cache-keeping model gets the raise line, appended as its own line, and the log names it", () => {
	const { text, lines } = mark();
	expect(text).toBe(`think hard\n\n${DEEP_RAISE}`);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("orchestrator");
	expect(lines[0]).toContain("raise");
});

test("every other case gets the plain hint line and the log says why", () => {
	const cases: [Partial<typeof session>, string][] = [
		[{ runtime: "omp" }, "omp"],
		[{ onFallback: true }, "fallback"],
		[{ model: "p/loses" }, "cache"],
		[{ model: "p/unknown-model" }, "cache"],
	];
	for (const [over, why] of cases) {
		const { text, lines } = mark(over);
		expect(text).toBe(`think hard\n\n${DEEP_HINT}`);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("hint");
		expect(lines[0]).toContain(why);
	}
});

test("the hub's raise line matches the extension's pattern, the plain hint line does not", () => {
	expect(DEEP_TURN.test(`owner text\n\n${DEEP_RAISE}`)).toBe(true);
	expect(DEEP_TURN.test(DEEP_HINT)).toBe(false);
});
