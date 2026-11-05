import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { featurePrompt, loadFeatureDirs } from "../../../hub/featuredirs.ts";
import { tempDir } from "./synth.ts";

const FEATURE = join(import.meta.dir, "..");

test("배포용 기능으로 로드되고 켜진 채이며 setup이 없어요", () => {
	const f = loadFeatureDirs(tempDir()).features.find(x => x.id === "publish-voice");
	expect(f).toMatchObject({ enabled: true, origin: "shipped", trigger: "메시지 도착", stage: "orchestrator", appliesTo: "orchestrator" });
	expect(f?.setup).toBeUndefined();
	expect(f?.body).toBeTruthy();
});

test("feature.md 본문은 400바이트 이내예요", () => {
	const text = readFileSync(join(FEATURE, "feature.md"), "utf8");
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	expect(Buffer.byteLength(body)).toBeLessThanOrEqual(400);
});

test("프롬프트에 실린 본문이 가리키는 SKILL.md가 실제로 있어요", () => {
	const prompt = featurePrompt(tempDir(), "orchestrator");
	const path = /(\/\S+features\/publish-voice\/SKILL\.md)/.exec(prompt)?.[1];
	expect(path && existsSync(path)).toBe(true);
	expect(featurePrompt(tempDir(), "lanes")).not.toContain("publish-voice/SKILL.md");
});
