import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featurePrompt, loadFeatureDirs } from "../../../hub/featuredirs.ts";

const FEATURE = join(import.meta.dir, "..");
const tempDir = () => mkdtempSync(join(tmpdir(), "output-design-"));

test("배포용 기능으로 로드되고 켜진 채이며 setup이 없어요", () => {
	const f = loadFeatureDirs(tempDir()).features.find(x => x.id === "output-design");
	expect(f).toMatchObject({ enabled: true, origin: "shipped", trigger: "메시지 도착", stage: "orchestrator", appliesTo: "all" });
	expect(f?.setup).toBeUndefined();
	expect(f?.name.length).toBeLessThanOrEqual(12);
});

test("feature.md 본문은 360바이트 이내, SKILL.md는 6KB 이내예요", () => {
	const text = readFileSync(join(FEATURE, "feature.md"), "utf8");
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	expect(Buffer.byteLength(body)).toBeLessThanOrEqual(360);
	expect(readFileSync(join(FEATURE, "SKILL.md")).length).toBeLessThanOrEqual(6144);
});

test("프롬프트에 실린 본문이 가리키는 SKILL.md가 실제로 있고 점검 도구도 있어요", () => {
	const prompt = featurePrompt(tempDir(), "orchestrator");
	const path = /(\/\S+features\/output-design\/SKILL\.md)/.exec(prompt)?.[1];
	expect(path && existsSync(path)).toBe(true);
	expect(featurePrompt(tempDir(), "lanes")).toContain("output-design/SKILL.md");
	expect(existsSync(join(FEATURE, "bin", "check.ts"))).toBe(true);
});
