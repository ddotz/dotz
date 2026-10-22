import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featurePrompt, loadFeatureDirs } from "../../../hub/featuredirs.ts";

const emptyData = mkdtempSync(join(tmpdir(), "wm-nofeat-"));

test("the shipped feature loads but is off by default", () => {
	const { features } = loadFeatureDirs(emptyData);
	const f = features.find((x) => x.id === "webmail-no-api");
	expect(f).toBeDefined();
	expect(f!.enabled).toBe(false);
});

test("a disabled feature contributes nothing to the orchestrator prompt", () => {
	const prompt = featurePrompt(emptyData, "orchestrator");
	expect(prompt).not.toContain("API도 IMAP도 zele 지원도");
});
