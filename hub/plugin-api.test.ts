// The runtime exports of hub/plugin-api.ts are what installed plugins import; dropping or renaming one breaks them on the next update.
import { expect, test } from "bun:test";
import * as api from "./plugin-api.ts";
import type { DraftVerdict } from "./plugin-api.ts";

test("plugin-api keeps its runtime exports", () => {
	expect(Object.keys(api).sort()).toEqual(["draftActionOf", "isSealed", "readSealKey", "sealLine"]);
	for (const fn of Object.values(api)) expect(typeof fn).toBe("function");
});

test("plugin-api keeps the DraftVerdict type", () => {
	const none: DraftVerdict = { verdict: "none" };
	expect(none.verdict).toBe("none");
});
