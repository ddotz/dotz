// Which models keep the prompt cache on an effort change, read from OmO's model info (hub/mid-effort.ts) with the old list as the fallback.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { midConvoEffort } from "./mid-effort.ts";

const FALLBACK = /claude-(opus-5|opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1|mythos-5-1)$/;
const agentDir = () => mkdtempSync(join(tmpdir(), "mid-effort-"));
const writeModels = (dir: string, models: { id: string; supportsMidConvoEffort?: boolean }[]) =>
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { local: { models: models.map(m => ({ id: m.id, api: "claude-sdk-oauth", compat: m.supportsMidConvoEffort === undefined ? {} : { supportsMidConvoEffort: m.supportsMidConvoEffort } })) } } }));
const bundledFile = (dir: string) => join(dir, "runtime", "abc123", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "anthropic.json");
const writeBundled = (dir: string, ids: Record<string, boolean>) => {
	const file = bundledFile(dir);
	mkdirSync(join(file, ".."), { recursive: true });
	const models = Object.fromEntries(Object.entries(ids).map(([id, flag]) => [`chat:${id}`, { id, compat: flag ? { supportsMidConvoEffort: true } : {} }]));
	writeFileSync(file, JSON.stringify({ "anthropic-messages": models }));
};

test("a models.json flag wins over the bundled data, an entry without one leaves it to the bundled data; an id in neither is not mid-convo", () => {
	const dir = agentDir();
	writeModels(dir, [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5", supportsMidConvoEffort: false }, { id: "claude-fable-5-2" }]);
	writeBundled(dir, { "claude-sonnet-5-5": true, "claude-opus-5-5": true, "claude-fable-5-1": true });
	expect(midConvoEffort("anthropic/claude-sonnet-5-5", FALLBACK, dir)).toBe(true);
	expect(midConvoEffort("anthropic/claude-opus-5-5", FALLBACK, dir)).toBe(false);
	expect(midConvoEffort("anthropic/claude-fable-5-2", FALLBACK, dir)).toBe(false);
	expect(midConvoEffort("anthropic/claude-fable-5-1", FALLBACK, dir)).toBe(true);
	expect(midConvoEffort("anthropic/claude-fable-9", FALLBACK, dir)).toBe(false);
});

test("the flag in models.json or in the bundled Anthropic data makes a model mid-convo, whatever the old list says", () => {
	const dir = agentDir();
	writeModels(dir, [{ id: "claude-local-1", supportsMidConvoEffort: true }]);
	writeBundled(dir, { "claude-bundled-1": true, "claude-plain-1": false });
	expect(midConvoEffort("anthropic/claude-local-1", FALLBACK, dir)).toBe(true);
	expect(midConvoEffort("anthropic/claude-bundled-1", FALLBACK, dir)).toBe(true);
	expect(midConvoEffort("anthropic/claude-plain-1", FALLBACK, dir)).toBe(false);
});

test("with nothing readable the old list answers", () => {
	const dir = agentDir();
	expect(midConvoEffort("anthropic/claude-opus-5-5", FALLBACK, dir)).toBe(true);
	expect(midConvoEffort("anthropic/claude-fable-5-2", FALLBACK, dir)).toBe(false);
	writeFileSync(join(dir, "models.json"), "{ not json");
	expect(midConvoEffort("anthropic/claude-opus-5-5", FALLBACK, dir)).toBe(true);
});

test("a changed models.json is read again (cache keyed by file mtime)", () => {
	const dir = agentDir();
	writeModels(dir, [{ id: "claude-late-1" }]);
	writeBundled(dir, {});
	expect(midConvoEffort("anthropic/claude-late-1", FALLBACK, dir)).toBe(false);
	writeModels(dir, [{ id: "claude-late-1", supportsMidConvoEffort: true }]);
	const later = new Date(Date.now() + 60_000);
	utimesSync(join(dir, "models.json"), later, later);
	expect(midConvoEffort("anthropic/claude-late-1", FALLBACK, dir)).toBe(true);
});
