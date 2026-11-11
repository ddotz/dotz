import { expect, test } from "bun:test";
import { keyedSelector } from "./fallback.ts";

test("a selector is keyed only when it runs as a key entry's own <provider>-apikey provider", () => {
	expect(keyedSelector("anthropic-apikey/claude-opus-5-5:medium")).toBe(true);
	expect(keyedSelector("anthropic/claude-opus-5-5:medium")).toBe(false);
	expect(keyedSelector("")).toBe(false);
	expect(keyedSelector(undefined)).toBe(false);
});
