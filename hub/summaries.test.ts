// DOTZ_DIR points at the throwaway config of the bun test preload (hub/runtime/test-setup.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSummarizer, parseBatch, sha, type ModelCall } from "./summaries.ts";

let dir = "";
const VOICE = "편한 해요체";
let voice = VOICE;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-sum-"));
	voice = VOICE;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LONG_EN = (n: number) => `Always verify the result of every change before telling the owner that it is finished, number ${n}.`;

// A stub model: answers every input string with "요약 <first 12 chars>\n둘째 줄"; records each call's system prompt and inputs.
function stub(reply?: (inputs: string[]) => string) {
	const calls: string[][] = [];
	const systems: string[] = [];
	const call: ModelCall = async (system: string, text: string) => {
		const inputs = JSON.parse(text) as string[];
		calls.push(inputs);
		systems.push(system);
		return { text: reply ? reply(inputs) : JSON.stringify(inputs.map(t => `요약 ${t.slice(0, 12)}\n둘째 줄`)) };
	};
	return { calls, systems, call };
}

function make(call: ModelCall, opts: { now?: () => number; batchSize?: number } = {}) {
	return createSummarizer({ call, file: join(dir, "cache", "card-summaries.json"), now: opts.now ?? (() => 1_000_000), batchSize: opts.batchSize ?? 40, voice: () => voice });
}

test("miss starts a background fill, the next call hits the cache without another model call", async () => {
	const m = stub();
	const s = make(m.call);
	const items = [{ key: "a", text: LONG_EN(1) }];
	expect(s.summarize(items, "ko")).toEqual({});
	await s.idle();
	expect(m.calls).toHaveLength(1);
	const out = s.summarize(items, "ko");
	expect(out.a).toBe(`요약 ${LONG_EN(1).slice(0, 12)}\n둘째 줄`);
	await s.idle();
	expect(m.calls).toHaveLength(1);
	// a new instance (a gateway restart) reads the same file
	const again = make(m.call);
	expect(again.summarize(items, "ko").a).toBe(out.a);
	expect(m.calls).toHaveLength(1);
});

test("cache is keyed by language and text", async () => {
	const m = stub();
	const s = make(m.call);
	s.summarize([{ key: "a", text: LONG_EN(1) }], "ko");
	await s.idle();
	expect(s.summarize([{ key: "a", text: LONG_EN(1) }], "ja")).toEqual({});
	await s.idle();
	expect(m.calls).toHaveLength(2);
	expect(sha("ko", voice, "x")).not.toBe(sha("ja", voice, "x"));
});

test("missing texts go out in batches of batchSize", async () => {
	const m = stub();
	const s = make(m.call, { batchSize: 40 });
	const items = Array.from({ length: 85 }, (_, i) => ({ key: `k${i}`, text: LONG_EN(i) }));
	s.summarize(items, "ko");
	await s.idle();
	expect(m.calls.map(c => c.length)).toEqual([40, 40, 5]);
	expect(Object.keys(s.summarize(items, "ko"))).toHaveLength(85);
});

test("a failing call keeps the original, backs off, and retries later", async () => {
	let now = 1_000_000;
	let fail = true;
	const m = stub(inputs => (fail ? "not json" : JSON.stringify(inputs.map(() => "요약\n줄"))));
	const s = make(m.call, { now: () => now });
	const items = [{ key: "a", text: LONG_EN(1) }];
	expect(s.summarize(items, "ko")).toEqual({});
	await s.idle();
	expect(m.calls).toHaveLength(1);
	// inside the backoff window: no new call, original kept
	expect(s.summarize(items, "ko")).toEqual({});
	await s.idle();
	expect(m.calls).toHaveLength(1);
	now += 31_000;
	fail = false;
	s.summarize(items, "ko");
	await s.idle();
	expect(m.calls).toHaveLength(2);
	expect(s.summarize(items, "ko").a).toBe("요약\n줄");
});

test("a throwing call and a wrong-sized array both count as failures", async () => {
	let n = 0;
	const s = make(async () => {
		n++;
		throw new Error("boom");
	});
	expect(s.summarize([{ key: "a", text: LONG_EN(1) }], "ko")).toEqual({});
	await s.idle();
	expect(n).toBe(1);
	expect(parseBatch('["x"]', 2)).toBeUndefined();
	expect(parseBatch("```json\n[\"a\\nb\"]\n```", 1)).toEqual(["a\nb"]);
	expect(parseBatch('["a\\nb\\nc"]', 1)).toEqual(["a\nb c"]);
	expect(parseBatch("[1]", 1)).toEqual([undefined]);
});

test("one unusable element keeps its original while the others are cached", async () => {
	const m = stub(inputs => JSON.stringify(inputs.map((_, i) => (i === 1 ? 42 : "좋은 요약"))));
	const s = make(m.call);
	const items = [0, 1, 2].map(i => ({ key: `k${i}`, text: LONG_EN(i) }));
	s.summarize(items, "ko");
	await s.idle();
	expect(s.summarize(items, "ko")).toEqual({ k0: "좋은 요약", k2: "좋은 요약" });
});

test("short texts already in the language also go through the model, in the main voice", async () => {
	const m = stub();
	const s = make(m.call);
	expect(s.summarize([{ key: "a", text: "실행 전에 막아요" }], "ko")).toEqual({});
	await s.idle();
	expect(m.calls).toEqual([["실행 전에 막아요"]]);
	expect(m.systems[0]).toContain(`Voice: ${voice}.`);
});

test("a new voice is a cache miss, so every card is rewritten in it", async () => {
	const m = stub();
	const s = make(m.call);
	s.summarize([{ key: "a", text: LONG_EN(1) }], "ko");
	await s.idle();
	voice = "terse and formal";
	expect(s.summarize([{ key: "a", text: LONG_EN(1) }], "ko")).toEqual({});
	await s.idle();
	expect(m.calls).toHaveLength(2);
	expect(m.systems[1]).toContain("Voice: terse and formal.");
	expect(sha("ko", "a", "x")).not.toBe(sha("ko", "b", "x"));
});

test("cache rewrite drops entries the latest call did not ask for", async () => {
	const m = stub();
	const s = make(m.call);
	s.summarize([{ key: "a", text: LONG_EN(1) }, { key: "b", text: LONG_EN(2) }], "ko");
	await s.idle();
	const file = join(dir, "cache", "card-summaries.json");
	expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).entries)).toHaveLength(2);
	s.summarize([{ key: "a", text: LONG_EN(1) }, { key: "c", text: LONG_EN(3) }], "ko");
	await s.idle();
	const entries = JSON.parse(readFileSync(file, "utf8")).entries as Record<string, string>;
	expect(Object.keys(entries).sort()).toEqual([sha("ko", voice, LONG_EN(1)), sha("ko", voice, LONG_EN(3))].sort());
});
