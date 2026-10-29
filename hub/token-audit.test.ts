// Nightly token audit on OmO session files: context shrink, projection re-pin and fallback attribution (hub/token-audit.ts).
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { analyze, auditAlert, fallbackAfterCapacity, findingsOf, material, projectLabel } from "./token-audit.ts";

const T0 = Date.UTC(2026, 9, 19, 12);
const at = (min: number) => new Date(T0 + min * 60e3).toISOString();
const turn = (min: number, cr: number, cw: number, o: { model?: string; provider?: string; error?: string; out?: number } = {}) =>
	JSON.stringify({
		type: "message", timestamp: at(min),
		message: {
			role: "assistant", provider: o.provider ?? "anthropic-subscription", model: o.model ?? "claude-opus-5-5", stopReason: o.error ? "error" : "stop", content: [],
			usage: { input: 2, output: o.out ?? 500, cacheRead: cr, cacheWrite: cw, totalTokens: o.error ? 0 : cr + cw + 502, cost: { total: 0.1 } },
			...(o.error ? { errorMessage: o.error } : {}),
		},
	});
const user = (min: number) => JSON.stringify({ type: "message", timestamp: at(min), message: { role: "user", content: "hi" } });
const custom = (min: number, kind: string) => JSON.stringify({ type: "custom", customType: kind, timestamp: at(min) });
const session = (name: string, lines: string[]) => {
	const file = join(DATA_DIR, `${name}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return { file, label: name, child: false, runtime: "omo" as const };
};

test("OmO session folders name the orchestrator and lanes", () => {
	const omo = `-${DATA_DIR.replace(/\//g, "-")}`;
	expect(projectLabel(`${omo}--`)).toBe("오케스트레이터");
	expect(projectLabel(`${omo}-lanes-site-fix-worktree--`)).toBe("레인 site-fix");
	expect(projectLabel("--private-tmp--")).toBe("/private/tmp");
});

test("a cache break after the 50% gate is a context shrink; one right after a compaction and a re-pin is a re-pin", () => {
	const src = session("audit-causes", [
		user(0), turn(0, 0, 60_000), turn(1, 60_000, 435_000), turn(2, 300_000, 100_000),
		JSON.stringify({ type: "compaction", timestamp: at(10) }), turn(10, 0, 100_000),
		custom(12, "omo-memory:projection-pin"), turn(12, 10_000, 90_000),
	]);
	const s = analyze(src, T0 - 1);
	expect(s.shrinks).toBe(1);
	expect(s.busts.map(b => b.cause)).toEqual(["shrink", "repin"]);
	expect(s.explained).toEqual({ compaction: 1 });
	expect(findingsOf([s])[0].fix).toContain("OmO 맥락 축소");
});

test("OmO's cache TTL is what the session showed: a full read after a 7-minute gap makes a later break after a gap a real break", () => {
	const short = analyze(session("audit-ttl-5m", [user(0), turn(0, 0, 100_000), user(20), turn(20, 0, 100_000)]), T0 - 1);
	expect(short.explained).toEqual({ "gap>5m": 1 });
	const long = analyze(session("audit-ttl-1h", [user(0), turn(0, 0, 100_000), user(7), turn(7, 100_000, 1_000), user(27), turn(27, 0, 101_000)]), T0 - 1);
	expect(long.explained).toEqual({});
	expect(long.busts).toHaveLength(1);
});

test("an OmO turn after bookkeeping entries is not a wake; one after a task wake is", () => {
	const src = session("audit-wakes", [user(0), turn(0, 0, 60_000), custom(1, "senpi.todo-state"), turn(1, 60_000, 1_000, { out: 50 }), custom(2, "omo-senpi:wake"), turn(2, 61_000, 1_000, { out: 50 })]);
	expect(analyze(src, T0 - 1).wakes).toEqual({ "omo-senpi:wake": { n: 1, tokens: 62_502, cost: 0.1 } });
});

test("a fallback inside a 429 window is attributed to the intended model and stays a note", () => {
	const fb = (min: number) => turn(min, 20_000, 1_000, { provider: "openai", model: "gpt-5.5" });
	const src = session("audit-fallback", [
		JSON.stringify({ type: "model_change", timestamp: at(0), provider: "anthropic-subscription", modelId: "claude-opus-5-5" }),
		user(0), turn(0, 0, 20_000), turn(1, 0, 0, { error: "429 rate_limit_error retry-after-ms: 3600000" }),
		JSON.stringify({ type: "model_change", timestamp: at(1), reason: "fallback", provider: "openai", modelId: "gpt-5.5", originalProvider: "anthropic-subscription", originalModelId: "claude-opus-5-5" }),
		...[2, 3, 4, 5, 6].map(fb),
	]);
	const exhaust: { from: number; to: number }[] = [];
	const s = analyze(src, T0 - 1, exhaust);
	expect(s.intended).toBe("anthropic-subscription/claude-opus-5-5");
	expect(s.fbTurns).toBe(5);
	expect(exhaust).toEqual([{ from: T0 + 60e3, to: T0 + 61 * 60e3 }]);
	const f = findingsOf([s], exhaust).find(x => x.kind === "폴백 모델")!;
	expect(f.flag).toBe(false);
	expect(f.evidence).toContain("한도");
});

test("fallback minutes count only after the 429 window ends", () => {
	const w = [{ from: 0, to: 60 * 60e3 }];
	expect(fallbackAfterCapacity([10 * 60e3, 50 * 60e3], w)).toBe(0);
	expect(fallbackAfterCapacity([10 * 60e3, 70 * 60e3, 150 * 60e3], w)).toBe(90);
});

// Owner 2026-10-29: the nightly message drops the minor warnings; with nothing that matters it is not sent at all.
const f = (kind: string, cost: number, recur?: number) => ({ flag: true, kind, who: "오케스트레이터 01a1", what: kind, amount: `$${cost}`, save: 0, cost, tip: "확인", ...(recur ? { recur } : {}) });
const base = { since: Date.parse("2026-10-28T19:30:00Z"), now: Date.parse("2026-10-29T19:30:00Z"), total: 116.4e6, totalCost: 37.79, reportPath: "/tmp/r.md" };

test("only minor warnings: nothing is sent", () => {
	expect(auditAlert({ ...base, flags: [f("에러 연속", 0, 2), f("캐시 깨짐", 0.72)], recurring: ["에러 연속"] })).toBeUndefined();
});

test("the message carries only what matters and says how many minor ones stayed in the report", () => {
	const text = auditAlert({ ...base, flags: [f("급증", 0), f("캐시 깨짐", 0.72), f("헛깨움", 3.2), f("에러 연속", 0, 3), f("반복 호출", 0.4, 3)], recurring: ["에러 연속", "반복 호출"] })!;
	expect(text).toContain("볼 만한 경고 3건");
	expect(text).toContain("- 급증");
	expect(text).toContain("- 헛깨움");
	// a warning back three days running is told when it costs something; a 0-token error streak (the gateway alerts errors itself) is not
	expect(text).toContain("며칠째 반복: 반복 호출");
	expect(text).not.toContain("에러 연속");
	expect(text).not.toContain("캐시 깨짐");
	expect(text).toContain("사소한 경고 2건은 보고서에만");
	expect(material(f("캐시 깨짐", 0.99))).toBe(false);
	expect(material(f("캐시 깨짐", 1))).toBe(true);
});
