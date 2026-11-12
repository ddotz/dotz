// telemetryOff: OmO's and senpi's own off switches written into temp files, idempotently, with the owner's file kept.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc, telemetryOff } from "./omo.ts";
import { TELEMETRY_OFF_ENV, ULTRATHINK_OFF_ENV } from "./omo-hosts.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-telemetry-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("turns both switches off, keeps comments and other keys, and a second run writes nothing", () => {
	const cfg = join(dir, "omo.jsonc");
	const settings = join(dir, "agent", "settings.json");
	writeFileSync(cfg, '{\n  // mine\n  "telemetry": { "enabled": true, "other": 1 },\n  "x": 2,\n}\n');
	const first = telemetryOff({}, cfg, settings);
	expect(first.every(l => l.endsWith("(written)"))).toBe(true);
	const text = readFileSync(cfg, "utf8");
	expect(text).toContain("// mine");
	expect(parseJsonc(text)).toEqual({ telemetry: { enabled: false, other: 1 }, x: 2 });
	expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ enableInstallTelemetry: false, tools: { bash: { redactSecretsInOutput: true } } });
	const second = telemetryOff({}, cfg, settings);
	expect(second.every(l => l.endsWith("(already)"))).toBe(true);
	expect(readFileSync(cfg, "utf8")).toBe(text);
});

test("adds the telemetry block to a config without one and keeps existing settings", () => {
	const cfg = join(dir, "omo.json");
	const settings = join(dir, "settings.json");
	writeFileSync(cfg, '{ "profiles": {} }');
	writeFileSync(settings, '{ "theme": "dark" }');
	telemetryOff({}, cfg, settings);
	expect(parseJsonc(readFileSync(cfg, "utf8"))).toEqual({ profiles: {}, telemetry: { enabled: false } });
	expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ theme: "dark", enableInstallTelemetry: false, tools: { bash: { redactSecretsInOutput: true } } });
});

test("the spawn env carries OmO's documented off switches", () => {
	expect(TELEMETRY_OFF_ENV).toEqual({ DO_NOT_TRACK: "1", OMO_DISABLE_TELEMETRY: "1" });
});

test("the spawn env turns the bundled binary's own ultrathink notice off", () => {
	expect(ULTRATHINK_OFF_ENV).toEqual({ CLAUDE_CODE_DISABLE_ULTRATHINK: "1" });
});
