import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardBlock } from "./choices.ts";
import { cfg } from "./config.ts";
import { compose, type Deps, type DoctorStore, runMorning, runNight } from "./doctor.ts";
import { failureFindings, gateway, tokenFindings, update, watches } from "./doctor-checks.ts";
import { buildPayloads } from "./discord-format.ts";
import { type DoctorCheck, EVIDENCE_CHARS, evidenceLines, type Finding } from "./doctor-types.ts";
import { msg } from "./i18n.ts";

const H = 3600e3, D = 24 * H;
const T0 = Date.parse("2026-11-24T08:00:00Z");
const saved = cfg.identity;
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dotz-doctor-head-"))));
afterEach(() => {
	cfg.identity = saved;
	rmSync(dir, { recursive: true, force: true });
});
const speak = (language: string) => void (cfg.identity = { ...saved, name: saved?.name ?? "sample-1", language });
const logLine = (at: number, text: string) => `${new Date(at).toISOString()} ${text}\n`;
const storeOf = (found: Finding[], told: DoctorStore["told"] = {}): DoctorStore => ({ version: 1, lastRun: T0, memo: {}, findings: Object.fromEntries(found.map(f => [f.key, f])), told });
const width = (s: string) => [...s].length;

type Told = { head: string; subs: string[] };
function toldLines(text: string): Told[] {
	const out: Told[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("- ")) out.push({ head: line.slice(2), subs: [] });
		else if (line.startsWith("  - ")) out.at(-1)!.subs.push(line.slice(4));
	}
	return out;
}

const classes = (names: string[], tokens = 20e6) => failureFindings(T0, { tokens: 1e9, turns: 7000, lost: names.map((name, i) => ({ name, count: 50 + i, tokens: tokens * (names.length - i), share: 0 })) }, { version: 2, at: "", tokens: 1e9, turns: 7000, classes: Object.fromEntries(names.map(name => [name, { count: 1, tokens: 1e5 }])) });

describe("a told line is a short headline with the numbers under it", () => {
	test("property, both languages: every headline fits 80 (ko) or 110 (en) characters with its mark or its step, then at most 3 sub-lines of at most 120 characters that never repeat it, and only the last may say how many more", async () => {
		const text = fc.string({ unit: fc.constantFrom("a", "Z", " ", "결", "정", "1", "9", ".", ",", "(", ")", "'", "/", "-", "가", "😀", ":", "번"), minLength: 1, maxLength: 200, size: "max" });
		const session = fc.record({ kind: fc.constantFrom("orchestrator" as const, "lane" as const, "worker" as const, "other" as const), name: text, model: text, cost: fc.double({ min: 0, max: 1e6, noNaN: true }), chosen: fc.double({ min: 0, max: 1e6, noNaN: true }) });
		const input = fc.record({
			language: fc.constantFrom("ko", "en"), name: text, reason: text, error: text, cause: text, fails: fc.integer({ min: 3, max: 100_000 }), restarts: fc.integer({ min: 3, max: 9 }),
			classes: fc.uniqueArray(text, { minLength: 1, maxLength: 16 }), kinds: fc.uniqueArray(text, { minLength: 1, maxLength: 8 }), top: fc.array(session, { maxLength: 3 }), cost: fc.double({ min: 0, max: 1e7, noNaN: true }), tokens: fc.integer({ min: 0, max: 2e12 }),
			usual: fc.option(fc.record({ cost: fc.double({ min: 0, max: 1e7, noNaN: true }), days: fc.integer({ min: 1, max: 7 }) }), { nil: undefined }), chosen: fc.integer({ min: 0, max: 50 }),
		});
		await fc.assert(
			fc.asyncProperty(input, async v => {
				speak(v.language);
				const clean = (s: string) => s.replace(/\)/g, "");
				writeFileSync(join(dir, "hub.log"), [
					...Array.from({ length: v.restarts }, (_, i) => [logLine(T0 - (i + 2) * H, `deferred gateway restart goes now (${clean(v.cause)})`), logLine(T0 - (i + 2) * H + 1e3, "gateway restart (1 request(s) coalesced, waited 1s)")]).flat(),
					logLine(T0 - 5 * H, `self-update #1: failed: ${v.error}`),
					logLine(T0 - 5 * H, `watch ${v.name} failed (${v.fails % 256}, fail, ${v.fails} in a row) unknown`),
					...[5, 4, 3].map(h => logLine(T0 - h * H + 2e3, "hub listening on 127.0.0.1:7420 as test (discord off)")),
				].join(""));
				writeFileSync(join(dir, "watches.json"), JSON.stringify([{ id: "w1", name: v.name, label: v.name, state: { fails: v.fails, failSince: T0 - 30 * H } }]));
				mkdirSync(join(dir, "watches", "w1"), { recursive: true });
				writeFileSync(join(dir, "watches", "w1", "last-fail.log"), v.reason);
				writeFileSync(join(dir, "gateway.err.log"), "");
				const memo: Record<string, unknown> = {};
				await gateway({ now: T0 - 6 * H, dataDir: dir, home: dir, memo });
				writeFileSync(join(dir, "gateway.err.log"), "error: a\n    at f (x.ts:1)\n".repeat(1 + (v.fails % 5)));
				const ctx = { now: T0, dataDir: dir, home: dir, memo, last: T0 - 6 * H };
				const usual = v.usual ? { tokens: 1, cost: v.usual.cost, from: "2026-11-16", to: "2026-11-22", days: v.usual.days } : undefined;
				const t = msg().doctor, stuck: Finding = { key: "sessions:stuck", area: "sessions", what: t.sessionsStuck(v.name, 3, 6), todo: t.todo.sessions, evidence: evidenceLines([v.name], t.subMore, 3), since: T0, level: 3 };
				const found = [
					...(await gateway(ctx)), ...(await watches(ctx)), ...(await update(ctx)), ...classes(v.classes),
					...tokenFindings(T0, { told: v.kinds.map((kind, i) => ({ flag: true, kind, who: "x", what: "", amount: "", save: 0, cost: i })), tokens: v.tokens, cost: v.cost, top: v.top, ...(usual ? { usual } : {}), ownerUse: { sessions: v.chosen, cost: v.cost / 3 } }),
					stuck,
				];
				const most = v.language === "ko" ? 80 : 110, more = (s: string) => [t.more, t.subMore, t.subKinds].some(say => s === say(Number(/\d+/.exec(s)?.[0])));
				for (const store of [storeOf(found), storeOf(found.map(f => ({ ...f, since: T0 - 3 * D })), Object.fromEntries(found.map(f => [f.key, { at: T0 - 8 * D, level: f.level }])))]) {
					const told = toldLines(compose(store, T0)!.text);
					expect(told.length).toBeGreaterThanOrEqual(6);
					for (const [i, { head, subs }] of told.entries()) {
						expect(width(head)).toBeLessThanOrEqual(most);
						expect(head.endsWith(i === told.length - 1 ? ` ${t.todo.sessions}` : t.look)).toBe(true);
						expect(subs.length).toBeLessThanOrEqual(3);
						for (const s of subs) expect([width(s) <= EVIDENCE_CHARS, !!s.trim(), !more(s) && head.includes(s)]).toEqual([true, true, false]);
						expect(subs.slice(0, -1).some(more)).toBe(false);
					}
				}
				return true;
			}),
			{ numRuns: 60 },
		);
	}, 60_000);

	test("the 11-24 token morning, both languages: the headline is yesterday's cost against the usual day and the kinds, the sessions and counts under it", () => {
		const top = [{ kind: "lane" as const, name: "~/Code-dotz 01a206e4", model: "claude-mythos-5-2", cost: 113.93, chosen: 0 }, { kind: "lane" as const, name: "~/Code-harness-foundation 01a205f3", model: "claude-mythos-5-2", cost: 81.18, chosen: 0 }];
		const told = [["대형 하위에이전트", 18.38], ["대형 하위에이전트", 18.38], ["캐시 깨짐", 10.76], ["캐시 깨짐", 10.76], ["비싼 모델", 4.565], ["비싼 모델", 4.565]] as const;
		const day = () => tokenFindings(T0, { told: told.map(([kind, cost]) => ({ flag: true, kind, who: "x", what: "", amount: "", save: 0, cost })), tokens: 1.88e9, cost: 771.56, top, usual: { tokens: 1, cost: 521.6, from: "2026-11-16", to: "2026-11-22", days: 5 }, ownerUse: { sessions: 0, cost: 0 } });
		speak("ko");
		expect(compose(storeOf(day()), T0)!.text.split("\n").slice(2, 6)).toEqual([
			"- 어제 $771.56를 썼어요(평소 하루 $521.60). 경고: 대형 하위에이전트, 캐시 깨짐, 비싼 모델. · 원인 찾기",
			"  - 대형 하위에이전트 세션 2개 $36.76; 캐시 깨짐 세션 2개 $21.52; 비싼 모델 세션 2개 $9.13",
			"  - 큰 세션: ~/Code-dotz 01a206e4 claude-mythos-5-2 $113.93, ~/Code-harness-foundation 01a205f3 claude-mythos-5-2 $81.18",
			"  - 어제 1.88B 토큰, 평소 하루는 11월 16일~11월 22일 중 쓴 날 5일의 중앙값이에요",
		]);
		speak("en");
		expect(compose(storeOf(day()), T0)!.text.split("\n").slice(2, 6)).toEqual([
			"- Yesterday cost $771.56 (a usual day: $521.60). Warnings: 대형 하위에이전트, 캐시 깨짐, 비싼 모델. · find the cause",
			"  - 대형 하위에이전트: 2 sessions $36.76; 캐시 깨짐: 2 sessions $21.52; 비싼 모델: 2 sessions $9.13",
			"  - Largest sessions: ~/Code-dotz 01a206e4 claude-mythos-5-2 $113.93 and 1 more",
			"  - 1.88B tokens yesterday; a usual day is the median of the 5 days with use from November 16 to November 22",
		]);
	});

	test("classes told together: the headline names those that fit and counts the rest; under it one line per class, the last saying how many classes more", () => {
		speak("ko");
		const names = ["그 밖의 도구 오류", "워커 도구 도중 끊김", "같은 호출 반복", "워커 토큰 상한", "도구 오류 정책 차단"];
		const told = toldLines(compose(storeOf(classes(names)), T0)!.text);
		expect(told).toHaveLength(1);
		expect(told[0]!.head).toBe("실패하거나 되풀이한 작업이 늘었어요: 그 밖의 도구 오류, 워커 도구 도중 끊김, 같은 호출 반복, 워커 토큰 상한 외 1가지. · 원인 찾기");
		expect(told[0]!.subs.map(s => s.split(":")[0])).toEqual(["그 밖의 도구 오류", "워커 도구 도중 끊김", msg().doctor.subKinds(3)]);
		const two = toldLines(compose(storeOf(classes(names.slice(0, 2))), T0)!.text)[0]!;
		expect(two.subs.map(s => s.split(":")[0])).toEqual(["그 밖의 도구 오류", "워커 도구 도중 끊김", "기준"]);
	});

	test("a finding with nothing more to say has no sub-line, and evidence the headline already says is not said again", () => {
		speak("ko");
		const t = msg().doctor;
		const bare: Finding = { key: "plugins:x.ts", area: "plugins", what: t.pluginNotLoaded("x.ts"), evidence: [], since: T0, level: 1, ask: true };
		const said: Finding = { key: "sessions:stuck", area: "sessions", what: t.sessionsStuck("sample-a, sample-b", 2, 6), todo: t.todo.sessions, evidence: ["sample-a, sample-b"], since: T0, level: 2 };
		expect(toldLines(compose(storeOf([bare, said]), T0)!.text)).toEqual([{ head: `${t.pluginNotLoaded("x.ts")}${t.look}`, subs: [] }, { head: `${t.sessionsStuck("sample-a, sample-b", 2, 6)} ${t.todo.sessions}`, subs: [] }]);
	});

	test("both languages: a headline over its cap is cut at a word with … and keeps its look-up mark; what the cut took, since when it lasts and its numbers are the sub-lines; the review's unplaced count fits whole even when told again", () => {
		for (const language of ["ko", "en"]) {
			speak(language);
			const m = msg(), t = m.doctor, most = language === "ko" ? 80 : 110, what = t.watchFailing("Sample shopping site price watch", 99999, t.when(T0 - 30 * H));
			const watch: Finding = { key: "watches:w1", area: "watches", what, evidence: [t.lastReason("timeout")], since: T0 - 3 * D, level: 9, ask: true };
			for (const [told, since] of [[storeOf([watch], { [watch.key]: { at: T0 - 8 * D, level: 9 } }), [t.since(t.day(T0 - 3 * D))]], [storeOf([{ ...watch, since: T0 }]), []]] as const) {
				const [line] = toldLines(compose(told, T0)!.text);
				const cut = line!.head.slice(0, line!.head.indexOf("…"));
				expect([width(line!.head) <= most, line!.head.endsWith(t.look), what.startsWith(`${cut} `)]).toEqual([true, true, true]);
				expect(line!.subs).toEqual([`…${what.slice(cut.length + 1)}`, ...since, t.lastReason("timeout")]);
			}
			const unplaced: Finding = { key: "prompt:unplaced", area: "prompt", what: m.promptReviewUnplaced(999), evidence: [], since: T0 - 3 * D, level: 999 };
			const again = toldLines(compose(storeOf([unplaced], { [unplaced.key]: { at: T0 - 8 * D, level: 999 } }), T0)!.text)[0]!.head;
			expect([again.startsWith(m.promptReviewUnplaced(999)), width(`${m.promptReviewUnplaced(999)} ${t.since("September 30")}`) <= most]).toEqual([true, true]);
		}
	});

	test("English, told again: a headline that fits alone but not with since when it lasts keeps its count, time and verb; since when is the first sub-line, and restart times past the shown one are recounted as times", async () => {
		speak("en");
		const t = msg().doctor, again = (f: Finding) => toldLines(compose(storeOf([{ ...f, since: T0 - 3 * D }], { [f.key]: { at: T0 - 8 * D, level: f.level } }), T0)!.text)[0]!;
		const what = t.watchFailing("쿠팡 가격 확인", 12, t.when(T0 - 30 * H));
		expect(again({ key: "watches:w1", area: "watches", what, evidence: [t.lastReason("timeout")], since: T0, level: 12, ask: true })).toEqual({ head: `${what}${t.look}`, subs: [t.since(t.day(T0 - 3 * D)), t.lastReason("timeout")] });
		writeFileSync(join(dir, "hub.log"), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(h => logLine(T0 - h * H, `gateway restart (1 request(s) coalesced, waited ${h}s)`)).join(""));
		const [restarts] = await gateway({ now: T0, dataDir: dir, home: dir });
		expect(again(restarts!)).toEqual({ head: `${restarts!.what}${t.look}`, subs: [t.since(t.day(T0 - 3 * D)), `${t.when(T0 - 12 * H)} · ${t.restartUnasked}`, t.more(11)] });
	});

	test("Korean, told again: since when it lasts goes on the headline when it fits there; gateway times pushed out by the cut part and since when are counted again as times (외 N번)", () => {
		speak("ko");
		const t = msg().doctor, again = (f: Finding) => toldLines(compose(storeOf([{ ...f, since: T0 - 3 * D }], { [f.key]: { at: T0 - 8 * D, level: f.level } }), T0)!.text)[0]!;
		const what = t.watchFailing("쿠팡 가격 확인", 12, t.when(T0 - 30 * H)), since = t.since(t.day(T0 - 3 * D));
		expect(again({ key: "watches:w1", area: "watches", what, evidence: [t.lastReason("timeout")], since: T0, level: 12, ask: true })).toEqual({ head: `${what} ${since}${t.look}`, subs: [t.lastReason("timeout")] });
		const long = `${t.crashes(7)} ${"로그에 남은 이유가 없어요. ".repeat(4).trim()}`, times = [t.crashAt(t.when(T0 - 5 * H)), t.crashAt(t.when(T0 - 4 * H)), t.more(5)];
		const told = again({ key: "gateway:crashes", area: "gateway", what: long, evidence: times, left: 5, since: T0, level: 7, ask: true });
		expect([told.subs.length, told.subs[0]!.startsWith("…"), told.subs[1], told.subs[2]]).toEqual([3, true, since, t.more(7)]);
	});

	test("many token kinds (5 in English, 6 and 7 in Korean): the kinds' numbers are one line that ends in how many kinds more when not all fit, and the largest sessions and yesterday's tokens keep their lines", () => {
		const kinds = ["대형 하위에이전트", "캐시 깨짐", "비싼 모델", "헛깨움", "반복 호출", "모델 폴백", "급증"];
		const top = [{ kind: "lane" as const, name: "~/Code-dotz 01a206e4", model: "claude-mythos-5-2", cost: 113.93, chosen: 0 }];
		for (const [language, n, largest, tokens] of [["en", 5, "Largest sessions: ", "1.88B tokens yesterday"], ["ko", 6, "큰 세션: ", "어제 1.88B 토큰"], ["ko", 7, "큰 세션: ", "어제 1.88B 토큰"]] as const) {
			speak(language);
			const t = msg().doctor;
			const found = tokenFindings(T0, { told: kinds.slice(0, n).flatMap((kind, i) => [{ flag: true, kind, who: "x", what: "", amount: "", save: 0, cost: 18.38 - i }, { flag: true, kind, who: "y", what: "", amount: "", save: 0, cost: 18.38 - i }]), tokens: 1.88e9, cost: 771.56, top, usual: { tokens: 1, cost: 521.6, from: "2026-11-16", to: "2026-11-22", days: 5 }, ownerUse: { sessions: 0, cost: 0 } });
			const [told] = toldLines(compose(storeOf(found), T0)!.text);
			expect(told!.subs).toHaveLength(3);
			const parts = told!.subs[0]!.split("; "), named = parts.filter(p => kinds.some(k => p.startsWith(k)));
			expect(named.map((p, i) => p.startsWith(kinds[i]!))).toEqual(named.map(() => true));
			expect(parts).toEqual(named.length < n ? [...named, t.subKinds(n - named.length)] : named);
			expect([named.length >= 2, width(told!.subs[0]!) <= EVIDENCE_CHARS, told!.subs[1]!.startsWith(largest), told!.subs[2]!.startsWith(tokens)]).toEqual([true, true, true, true]);
		}
	});
});

describe("told again and told together keep working with sub-lines", () => {
	function rig(found: Finding[]) {
		const state = { now: T0, found, sent: [] as string[] };
		const check: DoctorCheck = () => state.found;
		const deps: Deps = { now: () => state.now, dataDir: dir, home: dir, at: () => "auto", checks: [check], send: text => void state.sent.push(text), log: () => undefined };
		const day = async () => {
			await runNight(deps);
			await runMorning(deps);
			state.now += D;
		};
		return { state, day };
	}

	test("a line is told new, not the next day, again with its sub-lines once it grew 1.5 times; classes are one headline; the card of the same message stays as it was", async () => {
		speak("ko");
		const t = msg().doctor;
		const disk: Finding = { key: "disk:low", area: "disk", what: t.disk(9, 4), evidence: ["남은 공간 9.0 / 500 GB"], since: T0, level: 2, decide: { subject: t.diskSubject, question: t.diskQuestion, options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] } };
		const card = cardBlock({ subject: t.diskSubject, question: t.diskQuestion, evidence: disk.evidence, options: disk.decide!.options });
		const r = rig([...classes(["같은 호출 반복", "워커 토큰 상한"]), disk]);
		await r.day();
		const first = r.state.sent[0]!;
		expect(toldLines(first)).toEqual([{ head: "실패하거나 되풀이한 작업이 늘었어요: 같은 호출 반복, 워커 토큰 상한. · 원인 찾기", subs: ["같은 호출 반복: 1건 → 50건, 0.1M → 40.0M 토큰 (전체의 4.00%, 전에는 0.01%)", "워커 토큰 상한: 1건 → 51건, 0.1M → 20.0M 토큰 (전체의 2.00%, 전에는 0.01%)", "기준: 최근 7일 전체 1.00B 토큰"] }]);
		expect(first.endsWith(`${t.decidePart}\n\n${card}`)).toBe(true);
		await r.day();
		expect(r.state.sent).toHaveLength(1);
		r.state.found = [...classes(["같은 호출 반복", "워커 토큰 상한"], 40e6), disk];
		await r.day();
		expect(r.state.sent).toHaveLength(2);
		expect(toldLines(r.state.sent[1]!)[0]!.subs).toHaveLength(3);
	});

	test("the Discord text of a morning is the same text, its sub-lines as they are", () => {
		speak("ko");
		const text = compose(storeOf(classes(["같은 호출 반복", "워커 토큰 상한"])), T0)!.text;
		expect(text).toContain("\n  - ");
		expect(buildPayloads(text).map(p => p.content).join("\n")).toBe(text);
	});
});
