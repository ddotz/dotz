import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { ownerAsked } from "./lanerun.ts";

const OPUS = "anthropic/claude-opus-5-5", FABLE = "anthropic/claude-fable-5-1";
const CONFIG = join(DATA_DIR, "config.json");
const original = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : undefined;
const setGuard = (guard: object | undefined) => writeFileSync(CONFIG, JSON.stringify({ ...(original ? JSON.parse(original) : {}), guard }));
beforeAll(() => setGuard({ ask_before_expensive: true, expensive_models: ["fable"] }));
afterAll(() => (original === undefined ? rmSync(CONFIG, { force: true }) : writeFileSync(CONFIG, original)));

test("a Fable model the owner picked for the lane or its workers counts as asked; a cheap one or effort alone does not", () => {
	expect(ownerAsked({ model: OPUS, workerModel: OPUS })).toBe(false);
	expect(ownerAsked({ model: `${OPUS}:xhigh`, workerModel: `${OPUS}:max` })).toBe(false);
	expect(ownerAsked({ model: `${FABLE}:high`, workerModel: OPUS })).toBe(true);
	expect(ownerAsked({ model: OPUS, workerModel: FABLE })).toBe(true);
	expect(ownerAsked({ model: OPUS, workerModel: OPUS, fableOk: true })).toBe(true);
});

test("a Fable worker model the lane recorded itself is not the owner's pick", () => {
	expect(ownerAsked({ model: OPUS, workerModel: FABLE, workerByLane: true })).toBe(false);
});

test("with the guard off no model needs an ask", () => {
	setGuard(undefined);
	expect(ownerAsked({ model: FABLE, workerModel: OPUS })).toBe(false);
});
