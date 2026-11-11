import { expect, test } from "bun:test";
import { type ApplyIo, applyLearned, evidenceOf } from "./effort-wire.ts";
import type { EffortEntry } from "./effort-store.ts";

const entry = (id: string, effort: EffortEntry["effort"]): EffortEntry => ({
	id,
	effort,
	rows: [{ effort: "medium", score: 31, cost: 0.78 }, { effort: "high", score: 42, cost: 1.64 }, { effort: "xhigh", score: 50, cost: 4.09 }],
	sources: [{ url: "https://artificialanalysis.ai/leaderboards/models", at: "2026-11-12T01:00:00.000Z" }],
	at: "2026-11-12T01:00:00.000Z",
	status: "benchmark",
});
const io = (stored: ApplyIo["stored"], cacheSurvives: boolean, switched: string[] = []): ApplyIo => ({ stored, cacheSurvives: () => cacheSurvives, switchOrchestrator: () => void switched.push("switch") });

test("a target that stores no effort follows the new value; an effort the owner stored is never replaced", () => {
	const switched: string[] = [];
	const stored: ApplyIo["stored"] = t => (t === "orchestrator" ? { model: "anthropic/acme-9" } : t === "lanes" ? { model: "anthropic/acme-9", thinking: "low" } : { model: "anthropic/acme-9:max" });
	expect(applyLearned(entry("acme-9", "high"), io(stored, true, switched))).toEqual(["orchestrator"]);
	expect(switched).toEqual(["switch"]);
});

test("a target on another model is left alone", () => {
	const switched: string[] = [];
	expect(applyLearned(entry("acme-9", "high"), io(() => ({ model: "anthropic/acme-8" }), true, switched))).toEqual([]);
	expect(switched).toEqual([]);
});

test("the running orchestrator is switched only where the prompt cache survives an effort change; lanes and workers just follow", () => {
	const switched: string[] = [];
	const stored: ApplyIo["stored"] = () => ({ model: "x/acme-9" });
	expect(applyLearned(entry("acme-9", "high"), io(stored, false, switched))).toEqual(["orchestrator", "lanes", "workers"]);
	expect(switched).toEqual([]);
});

test("the evidence clause names the source, the date, the chosen effort and the next one up", () => {
	expect(evidenceOf(entry("acme-9", "high"))).toBe("artificialanalysis.ai 2026-11-12: high 42 / $1.64, xhigh 50 / $4.09");
	expect(evidenceOf(entry("acme-9", "xhigh"))).toBe("artificialanalysis.ai 2026-11-12: xhigh 50 / $4.09");
});
