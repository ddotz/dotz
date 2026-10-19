import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCall } from "./summaries.ts";

// hub/config.ts reads DOTZ_DIR/config.json when it is first imported, so a throwaway one is set up before importing summaries.ts.
const root = mkdtempSync(join(tmpdir(), "dotz-sum-root-"));
writeFileSync(join(root, "config.json"), JSON.stringify({ discord: { token_file: join(root, "none"), owner_id: "0", guild: "0" }, web: { port: 0, tailscale_https_port: 0, allow_logins: [] }, lanes: { model: "m", thinking: "off" } }));
process.env.DOTZ_DIR = root;
const { createSummarizer, inLanguage, parseBatch, sha } = await import("./summaries.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dotz-sum-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LONG_EN = (n: number) => `Always verify the result of every change before telling the owner that it is finished, number ${n}.`;

// A stub model: answers every input string with "요약 <first 12 chars>\n둘째 줄"; records each call's inputs.
function stub(reply?: (inputs: string[]) => string) {
	const calls: string[][] = [];
	const call: ModelCall = async (_system: string, text: string) => {
		const inputs = JSON.parse(text) as string[];
		calls.push(inputs);
		return { text: reply ? reply(inputs) : JSON.stringify(inputs.map(t => `요약 ${t.slice(0, 12)}\n둘째 줄`)) };
	};
	return { calls, call };
}

function make(call: ModelCall, opts: { now?: () => number; batchSize?: number } = {}) {
	return createSummarizer({ call, file: join(dir, "cache", "card-summaries.json"), now: opts.now ?? (() => 1_000_000), batchSize: opts.batchSize ?? 40 });
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
	expect(sha("ko", "x")).not.toBe(sha("ja", "x"));
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
	expect(parseBatch('["a\\nb\\nc"]', 1)).toEqual([undefined]);
	expect(parseBatch("[1]", 1)).toEqual([undefined]);
});

test("one unusable element keeps its original while the others are cached", async () => {
	const m = stub(inputs => JSON.stringify(inputs.map((_, i) => (i === 1 ? "a\nb\nc" : "좋은 요약"))));
	const s = make(m.call);
	const items = [0, 1, 2].map(i => ({ key: `k${i}`, text: LONG_EN(i) }));
	s.summarize(items, "ko");
	await s.idle();
	expect(s.summarize(items, "ko")).toEqual({ k0: "좋은 요약", k2: "좋은 요약" });
});

test("a short text already in the language is used as is with no call", async () => {
	const m = stub();
	const s = make(m.call);
	const out = s.summarize([{ key: "a", text: "실행 전에 막아요" }, { key: "b", text: "Run it" }], "ko");
	await s.idle();
	expect(out.a).toBe("실행 전에 막아요");
	expect(m.calls).toHaveLength(0);
	// English target: English short text as is, Korean text is not in the language
	const en = s.summarize([{ key: "c", text: "Blocks the command" }, { key: "d", text: "실행 전에 막아요" }], "en");
	expect(en.c).toBe("Blocks the command");
	expect(en.d).toBeUndefined();
	await s.idle();
	expect(m.calls).toHaveLength(1);
	expect(m.calls[0]).toEqual(["실행 전에 막아요"]);
});

test("a long text in the language still gets a summary; foreign texts are never used as is", async () => {
	const m = stub();
	const s = make(m.call);
	const longKo = "이 규칙은 모든 변경을 끝냈다고 말하기 전에 결과를 직접 확인하고 그 증거를 함께 보고하라는 뜻이라서 꽤 길어요. 그리고 증거가 없으면 끝난 것으로 치지 않는다는 점도 함께 적혀 있어요.";
	const out = s.summarize([{ key: "a", text: longKo }, { key: "b", text: "Short title\n짧은 설명", foreign: true }], "ko");
	expect(out).toEqual({});
	await s.idle();
	expect(m.calls[0]).toHaveLength(2);
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
	expect(Object.keys(entries).sort()).toEqual([sha("ko", LONG_EN(1)), sha("ko", LONG_EN(3))].sort());
});

test("names: three Latin words in a CJK language are foreign even next to a native word", () => {
	expect(inLanguage('A vague or negative owner reply ("할…', "ko")).toBe(true);
	expect(inLanguage('A vague or negative owner reply ("할…', "ko", true)).toBe(false);
	expect(inLanguage("Aside 브라우저", "ko", true)).toBe(true);
	expect(inLanguage("성격", "en")).toBe(false);
});
