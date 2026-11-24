// Nightly token audit on OmO session files: context shrink, projection re-pin and fallback attribution (hub/token-audit.ts).
import { expect, test } from "bun:test";
import fc from "fast-check";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { analyze, type Decisions, fallbackAfterCapacity, findingsOf, fixesOf, material, projectLabel, readDecisions, topSessions, useOf, usualDay } from "./token-audit.ts";

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

const SID = "01a1a03d-89dd-74a5-a67c-02759cfe1bde";
const decided = (...list: [number, string, string][]): Decisions => new Map([[SID, list.map(([min, kind, reason]) => ({ ts: T0 + min * 60e3, kind, reason }))]]);

test("continuity decisions come from both logs, oldest first, and a missing log is fine", () => {
	const line = (min: number, kind: string, sessionId: string) => JSON.stringify({ ts: at(min), level: "info", event: "claude_sdk_oauth_session_continuity", kind, reason: "r", count: 1, sessionId });
	const older = join(DATA_DIR, "audit-session.log.1");
	const newer = join(DATA_DIR, "audit-session.log");
	writeFileSync(older, `${line(1, "flatten", "a")}\nnot json\n`);
	writeFileSync(newer, `${JSON.stringify({ ts: at(2), event: "other", sessionId: "a" })}\n${line(3, "delta", "a")}\n${line(3, "fork", "b")}\n`);
	const all = readDecisions([join(DATA_DIR, "audit-missing.log"), older, newer]);
	expect(all.get("a")?.map(d => d.kind)).toEqual(["flatten", "delta"]);
	expect(all.get("b")?.map(d => d.kind)).toEqual(["fork"]);
});

test("a bust on a rebuild and the one right after are explained, stay out of the warning and land in one note", () => {
	const src = session(`2026-11-03T00-00-00-000Z_${SID}`, [
		user(0), turn(0, 0, 100_000), turn(1, 100_000, 1_000), turn(2, 10_000, 100_000), turn(3, 32_000, 90_000), turn(4, 122_000, 1_000),
	]);
	const s = analyze(src, T0 - 1, [], decided([1, "delta", "prefix_matched"], [2, "flatten", "tainted_compaction"], [3, "delta", "prefix_matched"], [4, "delta", "prefix_matched"]));
	expect(s.busts).toEqual([]);
	expect(s.rebuilds.map(r => r.label)).toEqual(["flatten/tainted_compaction", "재구성 직후"]);
	expect(s.rebuilds.map(r => r.uncached)).toEqual([100_002, 90_002]);
	const found = findingsOf([s]);
	expect(found.map(f => [f.kind, f.flag])).toEqual([["세션 재구성", false]]);
});

test("a delta bust stays a warning, and only entries that reach the model are suspects", () => {
	const lines = [
		user(0), turn(0, 0, 100_000), turn(1, 100_000, 1_000),
		custom(2, "claude-sdk-oauth-binding"), custom(2, "session-lifecycle"), custom(2, "work-custody"),
		JSON.stringify({ type: "custom", customType: "pi-rules.scan", timestamp: at(2), data: { reason: "reload" }, reason: "reload" }),
		JSON.stringify({ type: "custom_message", customType: "dotz-mode", timestamp: at(2) }),
		turn(2, 0, 101_000),
	];
	const s = analyze(session(`2026-11-03T00-00-01-000Z_${SID}`, lines), T0 - 1, [], decided([1, "delta", "prefix_matched"], [2, "delta", "prefix_matched"]));
	expect(s.rebuilds).toEqual([]);
	expect(s.busts.map(b => b.events)).toEqual([["pi-rules.scan(reload)", "dotz-mode"]]);
});

test("the second call after an idle gap is its own unproven pattern, unless that gap's first call rebuilt the session", () => {
	const lines = [user(0), turn(0, 0, 100_000), user(7), turn(7, 100_000, 1_000), turn(8, 0, 101_000)];
	expect(analyze(session(`2026-11-03T00-00-02-000Z_${SID}`, lines), T0 - 1).busts.map(b => b.cause)).toEqual(["idle"]);
	const rebuilt = analyze(session(`2026-11-03T00-00-03-000Z_${SID}`, lines), T0 - 1, [], decided([7, "fork", "idle_ttl"], [8, "delta", "prefix_matched"]));
	expect(rebuilt.busts).toEqual([]);
	expect(rebuilt.rebuilds.map(r => r.label)).toEqual(["재구성 직후"]);
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

test("a start on a model that never answered is no fallback; a hop after an answer is, and names the model it left", () => {
	const opus = { provider: "anthropic-subscription", modelId: "claude-opus-5-5" };
	const change = (min: number, to: object) => JSON.stringify({ type: "model_change", timestamp: at(min), ...to });
	// The session 01a1a3bb: started on the quota fallback, which refused with a 402; the resumed process answered on the configured model and recorded no model_change.
	const seeded = analyze(session("audit-seed", [
		change(0, { provider: "opengateway", modelId: "deepseek/deepseek-v4.1-flash-ultrafast" }),
		user(0), turn(0, 0, 0, { provider: "opengateway", model: "deepseek/deepseek-v4.1-flash-ultrafast", error: "402: no balance" }),
		user(55), ...[55, 56, 57, 58, 59].map(min => turn(min, 20_000, 1_000)),
		change(60, { ...opus, originalProvider: opus.provider, originalModelId: opus.modelId, source: "rpc" }), turn(61, 20_000, 1_000),
	]), T0 - 1);
	expect(seeded.fbTurns).toBe(0);
	expect(findingsOf([seeded]).map(x => x.kind)).not.toContain("폴백 모델");

	const gpt = { provider: "openai", model: "gpt-5.5" };
	const hopped = analyze(session("audit-hop", [
		change(0, opus), user(0), turn(0, 0, 20_000), ...[1, 2, 3, 4, 5].map(min => turn(min, 20_000, 1_000, gpt)),
		change(6, { provider: gpt.provider, modelId: gpt.model, source: "rpc" }), turn(7, 20_000, 1_000, gpt),
	]), T0 - 1);
	expect(hopped.fbTurns).toBe(5);
	expect(findingsOf([hopped]).find(x => x.kind === "폴백 모델")?.what).toContain("anthropic-subscription/claude-opus-5-5");
});

test("fallback minutes count only after the 429 window ends", () => {
	const w = [{ from: 0, to: 60 * 60e3 }];
	expect(fallbackAfterCapacity([10 * 60e3, 50 * 60e3], w)).toBe(0);
	expect(fallbackAfterCapacity([10 * 60e3, 70 * 60e3, 150 * 60e3], w)).toBe(90);
});

const f = (kind: string, cost: number, recur?: number) => ({ flag: true, kind, who: "오케스트레이터 01a1", what: kind, amount: `$${cost}`, save: 0, cost, tip: "확인", ...(recur ? { recur } : {}) });
test("the doctor tells a warning only when it matters: the day's spike, a cost of at least MINOR_USD, or a cost back three days running", () => {
	expect(material(f("급증", 0))).toBe(true);
	expect(material(f("헛깨움", 3.2))).toBe(true);
	expect(material(f("반복 호출", 0.4, 3))).toBe(true);
	expect(material(f("에러 연속", 0, 3))).toBe(false);
	expect(material(f("에러 연속", 0, 2))).toBe(false);
	expect(material(f("캐시 깨짐", 0.72))).toBe(false);
	expect(material(f("캐시 깨짐", 0.99))).toBe(false);
	expect(material(f("캐시 깨짐", 1))).toBe(true);
	expect(material({ ...f("캐시 깨짐", 5), flag: false })).toBe(false);
});

test("the usage screen's fixes: a watch that keeps waking a session, a big context left uncompacted, workers on an unasked expensive model", () => {
	const inbox = (min: number) => JSON.stringify({ type: "message", timestamp: at(min), message: { role: "user", content: [{ type: "text", text: "[dotz inbox] watch site-up matched /./ (no one is waiting)" }] } });
	const woke = Array.from({ length: 12 }, (_, i) => [inbox(i * 5), turn(i * 5, 10_000, 1_000)]).flat();
	const big = Array.from({ length: 12 }, (_, i) => turn(100 + i, 320_000 + i * 1_000, 1_000));
	const main = analyze({ ...session("fix-main", [user(0), ...woke]), target: "orchestrator" }, T0 - 1);
	const lane = analyze({ ...session("fix-lane-01a1a03d", [user(99), ...big]), target: "lane:site-fix" }, T0 - 1);
	const worker = analyze({ ...session("fix-worker", [user(0), turn(1, 0, 5_000, { model: "claude-fable-5-2" })]), label: "task:w1 (st_1) [OmO]", child: true, parent: "fix-lane-01a1a03d" }, T0 - 1);
	Object.assign(worker, { fable: 1, fableCost: 0.1, dearModels: new Set(["claude-fable-5-2"]) }); // what analyze records when the guard lists fable (hub/expensive-models.test.ts)
	const fixes = fixesOf([main, lane, worker]);
	expect(fixes.find(f => f.fix === "watch")).toMatchObject({ id: "watch:site-up", watch: "site-up", n: 12 });
	expect(fixes.find(f => f.fix === "compact")).toMatchObject({ id: "compact:lane:site-fix", target: "lane:site-fix" });
	expect(fixes.find(f => f.fix === "worker")).toMatchObject({ target: "lane:site-fix", model: "claude-fable-5-2", who: { kind: "lane", name: "site-fix" } });
	expect(fixesOf([main, lane, worker], () => ({ model: true, effort: true })).some(f => f.fix === "worker")).toBe(false);
});

test("the token line's largest sessions: three rows by cost, each with what its sessions spent on an expensive model the owner chose; an effort level alone is no model choice", () => {
	const run = (name: string, target: string, cost: number, dear: { fableCost?: number; effortTurns?: number } = {}) =>
		Object.assign(analyze({ ...session(name, [user(0), turn(1, 0, 5_000)]), target }, T0 - 1), { cost, modelCost: { "model-a": cost }, fable: dear.fableCost ? 1 : 0, fableCost: dear.fableCost ?? 0, effortTurns: dear.effortTurns ?? 0 });
	const results = [run("top-main", "orchestrator", 80), run("top-a1", "lane:alpha", 40, { fableCost: 40 }), run("top-a2", "lane:alpha", 5), run("top-b", "lane:beta", 35, { effortTurns: 3 }), run("top-c", "lane:gamma", 10, { fableCost: 10 })];
	expect(topSessions(useOf(results), results, s => ({ model: s.src.target !== "lane:beta", effort: true }), T0, 24)).toEqual([
		{ kind: "orchestrator", name: "", model: "model-a", cost: 80, chosen: 0 },
		{ kind: "lane", name: "alpha", model: "model-a", cost: 45, chosen: 40 },
		{ kind: "lane", name: "beta", model: "model-a", cost: 35, chosen: 0 },
	]);
});

test("the token line's largest sessions: an expensive-model session the owner did not choose counts nothing as chosen, and a chosen one only the part spent on that model", () => {
	const run = (name: string, target: string, cost: number, fableCost: number) =>
		Object.assign(analyze({ ...session(name, [user(0), turn(1, 0, 5_000)]), target }, T0 - 1), { cost, modelCost: { "model-a": cost }, fable: 1, fableCost, effortTurns: 0 });
	const results = [run("pick-a", "lane:alpha", 40, 25), run("pick-b", "lane:beta", 35, 20)];
	const rows = topSessions(useOf(results), results, s => ({ model: s.src.target === "lane:alpha", effort: true }), T0, 24);
	expect(rows.map(r => [r.name, r.cost, r.chosen])).toEqual([["alpha", 40, 25], ["beta", 35, 0]]);
});

test("the usual day: the median of the days with use among the last measured ones, labelled by the days the entries cover", () => {
	const day = (date: string, cost: number) => ({ date, tokens: cost * 1e6, cost, use: { at: Date.parse(`${date}T04:30:00+09:00`), hours: 24 } });
	const prior = [day("2026-11-17", 600), day("2026-11-18", 120), day("2026-11-19", 90), day("2026-11-20", 70), day("2026-11-21", 40), day("2026-11-22", 0), day("2026-11-23", 0)];
	expect(usualDay(prior)).toEqual({ tokens: 90e6, cost: 90, from: "2026-11-16", to: "2026-11-22", days: 5 });
	expect(usualDay([{ date: "2026-11-23", tokens: 5, cost: 1 }])).toEqual({ tokens: 5, cost: 1, from: "2026-11-22", to: "2026-11-22", days: 1 });
	expect(usualDay(prior.slice(5))).toBeUndefined();
});

test("the usual day: a gap in the history is never inside the named range, and two days of use give their mean", () => {
	const day = (date: string, cost: number) => ({ date, tokens: cost * 1e6, cost, use: { at: Date.parse(`${date}T04:30:00+09:00`), hours: 24 } });
	const gap = ["10", "11", "20", "21", "22", "23"].map(d => day(`2026-11-${d}`, 60));
	expect(usualDay(gap)).toEqual({ tokens: 60e6, cost: 60, from: "2026-11-19", to: "2026-11-22", days: 4 });
	expect(usualDay([day("2026-11-01", 20), day("2026-11-20", 0), day("2026-11-21", 0), day("2026-11-22", 80)])).toEqual({ tokens: 80e6, cost: 80, from: "2026-11-19", to: "2026-11-21", days: 1 });
	expect(usualDay([day("2026-11-21", 40), day("2026-11-22", 0), day("2026-11-23", 100)])).toEqual({ tokens: 70e6, cost: 70, from: "2026-11-20", to: "2026-11-22", days: 2 });
});

test("the usual day: for any history with gaps and idle days, every day of the named range is a day an entry covers, and the count is the days with use in it", () => {
	const base = Date.parse("2026-10-01T04:30:00+09:00");
	const kst = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
	fc.assert(
		fc.property(fc.uniqueArray(fc.record({ offset: fc.integer({ min: 0, max: 40 }), cost: fc.oneof(fc.constant(0), fc.double({ min: 0.001, max: 900, noNaN: true })) }), { selector: d => d.offset, maxLength: 14 }), entries => {
			const prior = [...entries].sort((a, b) => a.offset - b.offset).slice(-7).map(e => ({ date: kst(base + e.offset * 864e5), tokens: e.cost * 1e6, cost: e.cost, use: { at: base + e.offset * 864e5, hours: 24 } }));
			const u = usualDay(prior);
			if (!u) return expect(prior.at(-1)?.tokens ?? 0).toBe(0);
			const covered = new Set(prior.map(d => kst(d.use.at - 864e5)));
			for (let t = Date.parse(`${u.from}T00:00:00Z`); t <= Date.parse(`${u.to}T00:00:00Z`); t += 864e5) expect(covered.has(new Date(t).toISOString().slice(0, 10))).toBe(true);
			expect(u.to).toBe(kst(prior.at(-1)!.use.at - 864e5));
			expect(u.days).toBe(prior.filter(d => d.tokens > 0 && kst(d.use.at - 864e5) >= u.from).length);
		}),
	);
});
