// The shipped KakaoTalk feature is off by default: one setup line in the orchestrator prompt, no body, no active deny lines.
// A personal copy with `enabled: true` (what setup writes) turns the body and the send guards on.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedByFeatures, featurePrompt, loadFeatureDirs } from "../featuredirs.ts";

const REPO = join(import.meta.dir, "..", "..");
const SHIPPED = join(REPO, "features", "kakao", "feature.md");

test("shipped kakao feature is off: a setup line for the orchestrator only, guards inactive", () => {
	const data = mkdtempSync(join(tmpdir(), "kk-feat-"));
	const f = loadFeatureDirs(data).features.find(x => x.id === "kakao")!;
	expect(f.enabled).toBe(false);
	expect(f.deny.length).toBeGreaterThanOrEqual(2);
	const orch = featurePrompt(data, "orchestrator");
	expect(orch).toContain(`bun ${REPO}/hub/kakao/cli.ts setup`);
	expect(orch).not.toContain("{repo}");
	expect(orch).not.toContain("kakao chat=<id>");
	expect(featurePrompt(data, "lanes")).not.toContain("카톡");
	expect(blockedByFeatures(data, "kmsg send room hello")).toBeUndefined();
});

test("a personal copy with enabled: true injects the body and blocks a direct kmsg send", () => {
	const data = mkdtempSync(join(tmpdir(), "kk-feat-"));
	mkdirSync(join(data, "features", "kakao"), { recursive: true });
	writeFileSync(join(data, "features", "kakao", "feature.md"), readFileSync(SHIPPED, "utf8").replace(/^enabled: false$/m, "enabled: true"));
	const orch = featurePrompt(data, "orchestrator");
	expect(orch).toContain("kakao chat=<id>");
	expect(orch).toContain(`bun ${REPO}/hub/kakao/cli.ts send --draft`);
	expect(orch).not.toContain(`bun ${REPO}/hub/kakao/cli.ts setup`);
	expect(blockedByFeatures(data, "kmsg send room hello")?.id).toBe("kakao");
	expect(blockedByFeatures(data, "echo x; kakaocli send room hi")?.id).toBe("kakao");
	expect(blockedByFeatures(data, `bun ${REPO}/hub/kakao/cli.ts send --draft KABCD`)).toBeUndefined();
});
