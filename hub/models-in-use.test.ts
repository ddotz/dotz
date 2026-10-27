import { describe, expect, test } from "bun:test";
import { type InUseSnapshot, modelsInUse } from "./models-in-use.ts";
import { LOOKUP_MODEL } from "./runtime/omo.ts";

const OPUS = "anthropic/claude-opus-5-5:high";
const SONNET = "anthropic/claude-sonnet-5-5:high";
const base = (o: Partial<InUseSnapshot> = {}): InUseSnapshot => ({
	orchestrator: { configured: OPUS },
	lanesDefault: OPUS,
	workers: SONNET,
	lanes: [],
	replyDefault: "anthropic/claude-sonnet-5-5:medium",
	replies: [],
	outlang: "anthropic/claude-sonnet-5-5",
	...o,
});
const row = (rows: ReturnType<typeof modelsInUse>, key: string) => rows.find(r => r.key === key)!;

describe("실제로 쓰는 모델", () => {
	test("every place a model runs has a row, in order, each saying where it is changed", () => {
		const rows = modelsInUse(base({ replies: [{ key: "mail", label: "메일", model: OPUS }] }));
		expect(rows.map(r => r.key)).toEqual(["main", "background", "lookups", "lanes", "workers", "replies", "reply:mail", "outlang"]);
		expect(row(rows, "main").change).toEqual({ models: "orchestrator" });
		expect(row(rows, "lanes").change).toEqual({ models: "lanes" });
		expect(row(rows, "workers").change).toEqual({ models: "workers" });
		expect(row(rows, "replies").change).toEqual({ models: "replies" });
		expect(row(rows, "reply:mail")).toMatchObject({ label: "메일 답장", model: OPUS, change: { app: "mail" } });
		expect("none" in row(rows, "outlang").change).toBe(true);
	});
	test("the main row shows the model the process runs now, marked as a fallback with the configured one; background work follows it", () => {
		const rows = modelsInUse(base({ orchestrator: { configured: OPUS, active: SONNET } }));
		expect(row(rows, "main")).toMatchObject({ model: SONNET, configured: OPUS, fallback: true });
		expect(row(rows, "background").model).toBe(SONNET);
	});
	test("the same model on an API key or at another effort is not a fallback", () => {
		expect(row(modelsInUse(base({ orchestrator: { configured: OPUS, active: "anthropic-apikey/claude-opus-5-5:high" } })), "main").fallback).toBeUndefined();
		expect(row(modelsInUse(base({ orchestrator: { configured: OPUS, active: "anthropic/claude-opus-5-5:low" } })), "main").fallback).toBeUndefined();
		expect(row(modelsInUse(base()), "main")).toMatchObject({ model: OPUS });
	});
	test("lookups run Sonnet 5.5 medium on the subscription and follow the main model on an API key", () => {
		expect(row(modelsInUse(base()), "lookups").model).toBe(LOOKUP_MODEL);
		expect(row(modelsInUse(base({ orchestrator: { configured: OPUS, active: "anthropic-apikey/claude-opus-5-5:high" } })), "lookups").model).toBe("anthropic-apikey/claude-opus-5-5:high");
	});
	test("a running session gets its own row (its fallback marked), and its workers one only when they moved off the configured model", () => {
		const rows = modelsInUse(base({ lanes: [
			{ name: "a", title: "결제", configured: OPUS, active: SONNET, worker: SONNET },
			{ name: "b", configured: OPUS, worker: SONNET, activeWorker: OPUS },
		] }));
		expect(row(rows, "lane:a")).toMatchObject({ label: "세션 · 결제", model: SONNET, fallback: true, change: { models: "lane:a" } });
		expect(row(rows, "lane:b").fallback).toBeUndefined();
		expect(rows.some(r => r.key === "workers:a")).toBe(false);
		expect(row(rows, "workers:b")).toMatchObject({ model: OPUS, configured: SONNET, fallback: true, change: { models: "workers" } });
	});
});
