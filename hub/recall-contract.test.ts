import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallContract } from "./recall-contract.ts";

// What a session re-reads after a compaction (extension/index.ts recall()): the whole contract, or, where the runtime keeps identity and MODE in its system
// prompt (caps.modeInSystem, DOTZ_MODE_IN_SYSTEM), the rest of it. The parts are measured whole either way (hub/prompt-health.ts).
const root = mkdtempSync(join(tmpdir(), "dotz-recall-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// One install: a data dir with a marker per part and a package dir with a MODE file per shipped language.
function install(name: string, language: string): { data: string; pkg: string } {
	const data = join(root, name, "data");
	const pkg = join(root, name, "pkg");
	mkdirSync(join(data, "identity"), { recursive: true });
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(data, "config.json"), JSON.stringify({ identity: { language } }));
	writeFileSync(join(data, "identity", "IDENTITY.md"), "identity marker 7f3a");
	writeFileSync(join(data, "RULES.md"), "rule marker 41c9");
	writeFileSync(join(data, "LESSONS.md"), "lesson marker 88d2");
	writeFileSync(join(data, "channel-setups.json"), JSON.stringify([{ name: "ops", channel: "1", purpose: "setup marker 2b6d" }]));
	writeFileSync(join(data, "state.json"), JSON.stringify({ open_tasks: [{ id: "t1", what: "state marker 5e10" }] }));
	writeFileSync(join(pkg, "MODE.md"), "# Mode\n\n## Inputs\nmode marker en\n");
	writeFileSync(join(pkg, "MODE.ko.md"), "# 모드\n\n## 입력\nmode marker ko\n");
	return { data, pkg };
}

const KEPT = ["rule marker 41c9", "lesson marker 88d2", "setup marker 2b6d", "state marker 5e10"];

test("English: the flag leaves identity and MODE out of the re-read, keeps the rest and says where the two are", () => {
	const { data, pkg } = install("en", "en");
	const whole = recallContract(data, pkg);
	expect(whole.text.startsWith("[dotz] Contract re-read after compaction:\n\nIdentity:\nidentity marker 7f3a\n\n# Mode")).toBe(true);
	for (const part of ["mode marker en", "Owner rules:\nrule marker 41c9", "Lessons:\nlesson marker 88d2", "Current state.json:\nopen_tasks:\n- t1: state marker 5e10"]) expect(whole.text).toContain(part);

	const rest = recallContract(data, pkg, { modeInSystem: true });
	for (const gone of ["identity marker 7f3a", "mode marker en", "Identity:", "# Mode"]) expect(rest.text).not.toContain(gone);
	for (const kept of KEPT) expect(rest.text).toContain(kept);
	expect(rest.text.startsWith("[dotz] Contract re-read after compaction (your identity and the contract are in your system prompt):\n\nOwner rules:\nrule marker 41c9")).toBe(true);
	expect(rest.text.length).toBeLessThan(whole.text.length);
	expect(rest.parts).toEqual(whole.parts); // what prompt-health measures does not move with the layout
});

test("Korean: the same, in the Korean text", () => {
	const { data, pkg } = install("ko", "ko");
	const whole = recallContract(data, pkg);
	expect(whole.text.startsWith("[dotz] 컨텍스트 압축 뒤 계약을 다시 읽어요:\n\n정체성:\nidentity marker 7f3a\n\n# 모드")).toBe(true);

	const rest = recallContract(data, pkg, { modeInSystem: true });
	for (const gone of ["identity marker 7f3a", "mode marker ko", "정체성:", "# 모드"]) expect(rest.text).not.toContain(gone);
	for (const kept of KEPT) expect(rest.text).toContain(kept);
	expect(rest.text.startsWith("[dotz] 컨텍스트 압축 뒤 계약을 다시 읽어요 (정체성과 계약은 시스템 프롬프트에 있어요):\n\n오너 규칙:\nrule marker 41c9")).toBe(true);
	expect(rest.parts).toEqual(whole.parts);
});

test("another language keeps its reply line either way", () => {
	const { data, pkg } = install("ja", "ja");
	const line = "Reply to the owner in Japanese (ja).";
	expect(recallContract(data, pkg).text.endsWith(line)).toBe(true);
	const rest = recallContract(data, pkg, { modeInSystem: true }).text;
	expect(rest.endsWith(line)).toBe(true);
	expect(rest).not.toContain("mode marker en");
});

test("the re-read carries the owner memory: owner.md and every boundaries.md entry, bracketed date or not, never the bare template", () => {
	const { data, pkg } = install("memory", "en");
	mkdirSync(join(data, "memory"));
	writeFileSync(join(data, "memory", "owner.md"), "# Owner\n\n- [2026-11-01] owner marker 3c1e\n");
	writeFileSync(join(data, "memory", "boundaries.md"), "# Boundaries\n\ntemplate note 0f7e\n");
	expect(recallContract(data, pkg).text).not.toContain("template note 0f7e");

	writeFileSync(join(data, "memory", "boundaries.md"), `# Boundaries\n\n- [10-17] "bracketed marker 22c4"\n- 2026-11-05: "bare marker 9a0b"\n`);
	const rest = recallContract(data, pkg, { modeInSystem: true }).text;
	for (const marker of ["owner marker 3c1e", "bracketed marker 22c4", "bare marker 9a0b"]) expect(rest).toContain(marker);
	expect(rest.indexOf("Owner memory:")).toBeLessThan(rest.indexOf("bare marker 9a0b"));
});
