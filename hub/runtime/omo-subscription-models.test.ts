// The Claude-login models OmO's catalog lacks (Mythos) are added to the agent dir's models.json, never touching what is there.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION_MODELS, listWithSubscriptionModels, syncSubscriptionModels } from "./omo-settings.ts";

let dir: string;
const file = () => join(dir, "models.json");
const read = () => JSON.parse(readFileSync(file(), "utf8"));
const ids = () => read().providers["anthropic-subscription"].models.map((m: { id: string }) => m.id);
const login = { "anthropic-subscription": { type: "oauth" } };
const listing = (...ids: string[]) => ["provider  model  context  max-out  thinking  images", ...ids.map(id => `anthropic-subscription  ${id}  1M  128K  yes  yes`)].join("\n");
const none = listing();
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-omo-models-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("with the Claude login and no models.json, every Mythos model is written complete, api included", () => {
	expect(syncSubscriptionModels(dir, login, none)).toEqual(["claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2"]);
	const models = read().providers["anthropic-subscription"].models;
	expect(models).toEqual(SUBSCRIPTION_MODELS);
	for (const m of models) {
		expect(m.api).toBe("claude-sdk-oauth");
		expect(m.baseUrl).toBe("claude-sdk-oauth");
		expect(m.cost.input).toBeGreaterThan(0);
	}
});

test("the owner's entries and other providers stay exactly as written; only missing ids are appended", () => {
	const own = { id: "claude-mythos-5-2", name: "mine", api: "claude-sdk-oauth", baseUrl: "claude-sdk-oauth", custom: 1 };
	const other = { anthropic: { models: [{ id: "claude-sonnet-5-5", api: "anthropic-messages" }] } };
	writeFileSync(file(), JSON.stringify({ top: true, providers: { ...other, "anthropic-subscription": { headers: { a: "b" }, models: [own] } } }));
	expect(syncSubscriptionModels(dir, login, none)).toEqual(["claude-mythos-5", "claude-mythos-5-1"]);
	const doc = read();
	expect(doc.top).toBe(true);
	expect(doc.providers.anthropic).toEqual(other.anthropic);
	expect(doc.providers["anthropic-subscription"].headers).toEqual({ a: "b" });
	expect(doc.providers["anthropic-subscription"].models[0]).toEqual(own);
	expect(ids()).toEqual(["claude-mythos-5-2", "claude-mythos-5", "claude-mythos-5-1"]);
});

test("an id OmO's catalog already lists is not added, and a second run writes nothing", () => {
	expect(syncSubscriptionModels(dir, login, `${listing("claude-mythos-5")}\nanthropic  claude-mythos-5-1  1M  128K  yes  yes`)).toEqual(["claude-mythos-5-1", "claude-mythos-5-2"]);
	const before = readFileSync(file(), "utf8");
	expect(syncSubscriptionModels(dir, login, listing("claude-mythos-5"))).toEqual([]);
	expect(readFileSync(file(), "utf8")).toBe(before);
});

test("without the Claude login nothing is written", () => {
	expect(syncSubscriptionModels(dir, undefined, none)).toEqual([]);
	expect(syncSubscriptionModels(dir, { anthropic: { type: "api_key", key: "x" } }, none)).toEqual([]);
	expect(existsSync(file())).toBe(false);
});

test("a models.json that is not valid JSON or not the expected shape is left alone", () => {
	for (const text of ["{ not json", "[]", JSON.stringify({ providers: { "anthropic-subscription": { models: {} } } })]) {
		writeFileSync(file(), text);
		expect(syncSubscriptionModels(dir, login, none)).toEqual([]);
		expect(readFileSync(file(), "utf8")).toBe(text);
	}
});

test("the list is read once more only when models were just added, so the first list already has them", async () => {
	const tables = [none, listing("claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2")];
	let reads = 0;
	expect(await listWithSubscriptionModels(dir, login, async () => tables[Math.min(reads++, 1)])).toBe(tables[1]);
	expect(reads).toBe(2);
	reads = 0;
	expect(await listWithSubscriptionModels(dir, login, async () => tables[1])).toBe(tables[1]);
	expect(reads).toBe(0);
});
