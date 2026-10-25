import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatureDirs } from "../../../hub/featuredirs.ts";

const emptyData = mkdtempSync(join(tmpdir(), "wm-nofeat-"));

test("the shipped feature loads but is off by default", () => {
	const { features } = loadFeatureDirs(emptyData);
	const f = features.find((x) => x.id === "webmail-no-api");
	expect(f).toBeDefined();
	expect(f!.enabled).toBe(false);
});
