// Nightly token-leak audit, ported from the earlier secretary's token-audit.ts. Pure TS, no LLM calls, report only.
// Scans the session jsonl files of both runtimes (OmO ~/.omo/agent/sessions plus its task-worker stores, omp
// ~/.omp/agent/sessions; orchestrator, lane worktrees, task workers) active in the last 24h, writes the full
// report to ~/.dotz/logs/token-audit-YYYYMMDD.md (KST), keeps a 14-day history in ~/.dotz/token-audit.json, and posts ONE
// short Korean message to the alert channel only when something is flagged. Nothing is ever applied automatically.
// Config: `token_audit_at` ("HH:MM" local time, default "04:30", "off" disables). The reflection digest reads the result.
// usage: bun hub/token-audit.ts --dry [--hours N]    (--dry prints the alert instead of sending it; history is not recorded)
// Last stdout line: RESULT {...}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, DEFAULTS, HOME, paths, writeAtomic } from "./config.ts";
import { issueBlock } from "./choices.ts";
import { msg } from "./i18n.ts";
import { bareModel, type Covered, ownerCovered, readOwnerBasis } from "./owner-asked.ts";
import { type FixRow, type SessionUse, sharesOf, type UseShare } from "./usage-share.ts";
import { expensiveMatch, loadGuardConfig } from "./lanegates.ts";
import { addBigContext, addToolCalls, addTurn, addWake, collectSessions, newStreaks, OMO_WAKE, projectLabel as labelOf, type Src } from "./session-sources.ts";

// OmO (senpi) trims the context of every request once the last usage reaches 50% of the window; the trim is not saved, so
// requests alternate full/trimmed and the trimmed prefix misses the cache (measured on the earlier secretary, 2026-10-08).
const REDUCE_GATE = 500_000;
// Known causes of a cache break that are not a prompt-prefix change made here: the report names them instead of guessing.
const CAUSE: Record<string, [string, string]> = {
	shrink: ["OmO 맥락 축소(창 50% 넘으면 요청마다 비영속 축소)", "한 태스크 컨텍스트를 ~250K 아래로(단계별 워커, MODE 'Sessions and subagents')"],
	repin: ["압축 직후 메모리 projection 재핀", "로컬 조치 없음(OmO 쪽)"],
	date: ["UTC 날짜 변경(environment-context 재주입)", "로컬 조치 없음(하루 1회)"],
	idle: ["유휴 뒤 둘째 호출 패턴(기전 미증명)", "미증명이라 고칠 곳을 단정할 수 없음: 재발하면 해당 요청의 프롬프트 차이를 대조"],
};
// Unexplained OmO breaks: what the injected event before them points at (from the earlier secretary's audit), instead of a generic hint.
const BUST_FIX: [RegExp, string][] = [
	[/^pi-rules\.scan\((reload|startup|resume)\)$|^senpi-memory\.session-binding$/, "재개·리로드 때 OmO가 프롬프트를 새로 조립해 프리픽스가 바뀜(재시작 직후 1회면 정상, 반복되면 재시작 원인 확인)"],
	[/^omo-memory:(projection-pin|notice|soul-updated)$/, "메모리 projection 재핀이 프롬프트 앞부분을 바꾸는지 확인(dotz는 OmO 메모리를 끔)"],
	[/^environment-context$/, "environment-context 재주입(날짜·cwd 변경)이 프리픽스를 깨는지 확인"],
];
// OmO logs how each request continues its Claude SDK session; these kinds rebuild that session, so the prefix is written again.
const CONTINUITY_EVENT = "claude_sdk_oauth_session_continuity";
const CONTINUITY_LOGS = ["session.log.1", "session.log"].map(f => join(HOME, ".omo/agent/logs", f));
const REBUILD_KINDS = new Set(["flatten", "fork", "bootstrap"]);
const AFTER_REBUILD = "재구성 직후";
const IDLE_GAP = 5 * 60e3;
const LOG_DIR = join(DATA_DIR, "logs");
const HISTORY = join(DATA_DIR, "token-audit.json");
const BUST_UNCACHED = 50_000;
const BIG_CTX = 300_000;
const SUB_NOTE = 20e6;
const SUB_FLAG = 50e6;
const IDLE_OUT = 300;
const EFFORT_FLAG_TURNS = 5;

// Where each warning class already has a rule (MODE.md section names). A class flagged on consecutive days despite its
// rule is marked 🔁: fix the carrier (the brief, the guard, the section the lane actually sees) instead of adding prose.
const RULES: Record<string, string> = {
	"캐시 깨짐": "MODE.md 'Sessions and subagents' (한 태스크 ~250K 컨텍스트) · 'Restart and resume'",
	"헛깨움": "MODE.md 'Inputs' ([keepalive] 턴은 ok만) · 'Monitoring (dotz_watch)'",
	"에러 연속": "MODE.md 'Restart and resume'",
	"반복 호출": "MODE.md 'Sessions and subagents' (Brief: 폴링 대신 blocking 대기 한 번)",
	"대형 컨텍스트": "MODE.md 'Sessions and subagents' (한 태스크 ~250K 컨텍스트)",
	"대형 하위에이전트": "MODE.md 'Sessions and subagents' (Brief: 단계별 워커, 후속은 새 워커)",
	"비싼 모델": "MODE.md 'Sessions and subagents' (Budget: Fable·max/xhigh는 오너가 요청할 때만)",
};

const kstDate = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const kst = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const K = (n: number) => `${Math.round(n / 1e3)}K`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const tilde = (p: string) => p.replace(HOME, "~");
type Json = Record<string, any>; // omp session lines are external jsonl; fields are read defensively

// An Anthropic 429 blocks until its retry-after (5h when unknown, capped at 7 days): a fallback inside one is expected.
type Exhaust = { from: number; to: number };
type Day = { date: string; tokens: number; cost: number; cacheWrite: number; sessions: number; flags: number; kinds?: string[]; report?: string; use?: UseShare };

export const projectLabel = (dir: string) => labelOf(dir, HOME, DATA_DIR);
const collect = (since: number) => collectSessions(since, { home: HOME, dataDir: DATA_DIR });

type Bust = { ts: number; uncached: number; cr: number; prevCtx: number; cost: number; events: string[]; cause: string };
type Rebuild = { ts: number; uncached: number; cost: number; label: string };
type Decision = { ts: number; kind: string; reason: string };
export type Decisions = Map<string, Decision[]>;
type Stats = {
	src: Src; start?: number; turns: number; tokens: number; cost: number; cw: number; cr: number; out: number; maxCtx: number; compactions: number;
	busts: Bust[]; rebuilds: Rebuild[]; explained: Record<string, number>; bigNew: number;
	wakes: Record<string, { n: number; tokens: number; cost: number }>; warmings: number; watchWakes: Record<string, { n: number; cost: number }>;
	errTurns: number; maxErrStreak: number; errCodes: Record<string, number>; compactErr: number;
	maxBigStreak: number; bigTokens: number; bigCost: number;
	fbTurns: number; fbModels: Set<string>; fbIntended: Set<string>; intended?: string; fbSegs: number[][]; shrinks: number;
	fable: number; fableCost: number; effortTurns: number; effortCost: number; expensiveCost: number; efforts: Set<string>;
	dearModels: Set<string>; dearLevels: Set<string>; dearFirst: number; dearLast: number; modelCost: Record<string, number>;
	maxToolStreak: number; maxToolDesc: string; loopTokens: number; loopCost: number; readRate: number;
};

const sameModel = (a: string, b: string) => {
	const x = a.split("/").pop() ?? a;
	const y = b.split("/").pop() ?? b;
	return x.includes(y) || y.includes(x);
};

// Decisions per session, oldest first. Either log may be missing (rotation), and most of their lines are unrelated, so only matching lines are parsed.
export function readDecisions(files = CONTINUITY_LOGS): Decisions {
	const all: Decisions = new Map();
	for (const file of files) {
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes(CONTINUITY_EVENT)) continue;
			try {
				const o = JSON.parse(line);
				const list = all.get(o.sessionId) ?? [];
				list.push({ ts: Date.parse(o.ts), kind: o.kind, reason: o.reason });
				all.set(o.sessionId, list);
			} catch {}
		}
	}
	return all;
}

export function analyze(src: Src, since: number, exhaust: Exhaust[] = [], decisions: Decisions = new Map()): Stats {
	const s: Stats = {
		src, intended: src.requested, fbSegs: [], shrinks: 0, turns: 0, tokens: 0, cost: 0, cw: 0, cr: 0, out: 0, maxCtx: 0, compactions: 0, busts: [], rebuilds: [], explained: {}, bigNew: 0, wakes: {}, warmings: 0, watchWakes: {},
		errTurns: 0, maxErrStreak: 0, errCodes: {}, compactErr: 0, maxBigStreak: 0, bigTokens: 0, bigCost: 0, fbTurns: 0, fbModels: new Set(), fbIntended: new Set(),
		fable: 0, fableCost: 0, effortTurns: 0, effortCost: 0, expensiveCost: 0, efforts: new Set(), dearModels: new Set(), dearLevels: new Set(), dearFirst: 0, dearLast: 0, modelCost: {}, maxToolStreak: 0, maxToolDesc: "", loopTokens: 0, loopCost: 0, readRate: 0,
	};
	const sessionDecisions = decisions.get(src.file.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1] ?? "") ?? [];
	const decisionIn = (from: number, to: number) => sessionDecisions.findLast(d => d.ts > from && d.ts <= to);
	let events: string[] = [];
	let injected: string[] = []; // what can reach the model: a plain `custom` entry is local state unless it marks a prompt reassembly (BUST_FIX)
	let compacted = false, modelChanged = false, thinkChanged = false, user = false;
	let byWatch = ""; // the watch whose match ("[dotz inbox] watch <name> matched") started the turns since the last user message
	let prev: { ts: number; ctx: number; ttlMin: number; out: number; before?: number } | undefined;
	let prevStop = "stop";
	let lastCompactTs = 0, fbOpen = false, unproven = false;
	let omoLong = false;
	let errStreak = 0, readTok = 0, readCost = 0;
	const run = newStreaks();
	let level = "";
	const guard = loadGuardConfig(DATA_DIR);
	const dear = (v: string) => expensiveMatch(v, guard) !== undefined;
	for (const line of readFileSync(src.file, "utf8").split("\n")) {
		if (line.length < 20) continue;
		const head = line.slice(0, 400);
		const ts = Date.parse(head.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
		if (head.startsWith('{"type":"message"')) {
			if (head.includes('"role":"toolResult"')) continue;
			if (head.includes('"role":"user"')) {
				user = true;
				byWatch = head.match(/\[dotz inbox\] watch (\S+) matched /)?.[1] ?? "";
				continue;
			}
			if (head.includes('"role":"custom"')) {
				const kind = head.match(/"customType":"([^"]+)"/)?.[1] ?? "custom";
				events.push(kind);
				injected.push(kind);
				continue;
			}
			if (!head.includes('"role":"assistant"')) continue;
		} else if (head.startsWith('{"type":"compaction"')) {
			compacted = true;
			run.big = 0;
			if (!(ts < since)) s.compactions++;
			if (ts) lastCompactTs = ts;
			continue;
		} else if (head.startsWith('{"type":"model_change"')) {
			modelChanged = true;
			try {
				const o = JSON.parse(line);
				const model = o.model ?? (o.provider && o.modelId ? `${o.provider}/${o.modelId}` : "");
				// A fallback switch keeps the model it replaced as the intended one (OmO names it originalModelId).
				if (o.reason === "fallback" || o.resolvedModelIsFallback) {
					unproven = false;
					if (o.originalModelId) s.intended = `${o.originalProvider ?? o.provider}/${o.originalModelId}`;
				} else if (model) {
					s.intended = model;
					unproven = !src.requested;
				}
			} catch {}
			continue;
		} else if (head.startsWith('{"type":"thinking_level_change"')) {
			thinkChanged = true;
			level = head.match(/"thinkingLevel":"([^"]+)"/)?.[1] ?? level;
			continue;
		} else {
			const kind = head.match(/"customType":"([^"]+)"/)?.[1];
			if (kind && (head.startsWith('{"type":"custom"') || head.startsWith('{"type":"custom_message"'))) {
				const event = kind === "pi-rules.scan" ? `pi-rules.scan(${head.match(/"reason":"([^"]+)"/)?.[1] ?? "?"})` : kind;
				events.push(event);
				if (head.startsWith('{"type":"custom_message"') || BUST_FIX.some(([re]) => re.test(event))) injected.push(event);
				if (/warm|keepalive/i.test(kind)) s.warmings++;
			}
			continue;
		}
		let entry: Json;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const m = entry.message ?? {};
		const inWindow = ts >= since;
		const u = m.usage ?? {};
		const tokens = u.totalTokens ?? 0;
		const cost = u.cost?.total ?? 0;
		const cw = u.cacheWrite ?? 0;
		const cr = u.cacheRead ?? 0;
		const ctx = (u.input ?? 0) + cr + cw;
		const uncached = cw + (u.input ?? 0); // Anthropic reports new prefix tokens as cacheWrite, others as input
		const model = `${m.provider}/${m.model}`;
		const calls = (Array.isArray(m.content) ? m.content : []).filter((c: Json) => c?.type === "toolCall");
		const newTurn = prevStop !== "toolUse";
		if (m.stopReason === "error") {
			if (inWindow) {
				s.errTurns++;
				errStreak++;
				s.maxErrStreak = Math.max(s.maxErrStreak, errStreak);
				const code = String(m.diagnostics?.find((d: Json) => d?.details?.statusCode)?.details?.statusCode ?? String(m.errorMessage ?? "").match(/\b([45]\d\d)\b/)?.[1] ?? "other");
				s.errCodes[code] = (s.errCodes[code] ?? 0) + 1;
				if (/compaction/i.test(m.errorMessage ?? "")) s.compactErr++;
			}
			const limited = /429|rate_limit/i.test(m.errorMessage ?? "") || (m.diagnostics ?? []).some((d: Json) => d?.details?.statusCode === 429);
			if (limited && /anthropic|claude/i.test(model)) {
				const after = Number(String(m.errorMessage ?? "").match(/retry-after-ms:\s*(\d+)/)?.[1] ?? m.diagnostics?.map((d: Json) => d?.details?.retryAfterMs).find((v: unknown) => typeof v === "number") ?? 5 * 3600e3);
				exhaust.push({ from: ts, to: ts + Math.min(after, 7 * 24 * 3600e3) });
			}
			prevStop = "error";
			if (!tokens) continue;
		} else errStreak = 0;
		if (!tokens) {
			prevStop = m.stopReason ?? "stop";
			continue;
		}
		// A resumed process's --model writes no model_change (OmO: "no model_change recorded that hop"), so a selection that never answered gives way to the model that did.
		if (unproven && m.stopReason !== "error") {
			s.intended = model;
			unproven = false;
		}
		if (inWindow) {
			addTurn(s, ts, { tokens, cost, cw, cr, out: u.output ?? 0, ctx });
			s.modelCost[bareModel(model)] = (s.modelCost[bareModel(model)] ?? 0) + cost;
			if (byWatch) {
				const w = (s.watchWakes[byWatch] ??= { n: 0, cost: 0 });
				if (newTurn) w.n++;
				w.cost += cost;
			}
			if (cr) {
				readTok += cr;
				readCost += u.cost?.cacheRead ?? 0;
			}
			if (dear(model)) {
				s.fable++;
				s.fableCost += cost;
				s.dearModels.add(bareModel(model));
			}
			if (level && dear(`:${level}`)) {
				s.effortTurns++;
				s.effortCost += cost;
				s.efforts.add(`${m.model ?? "?"}:${level}`);
				s.dearLevels.add(level);
			}
			if (dear(model) || (level && dear(`:${level}`))) {
				s.expensiveCost += cost; // once per turn even when both apply
				s.dearFirst ||= ts;
				s.dearLast = ts;
			}
			// context shrink (OmO only): the request after one at the 50% gate came back >10% smaller without a compaction
			const shrunk = src.runtime === "omo" && !!prev && !compacted && prev.ctx + prev.out >= REDUCE_GATE * 0.98 && ctx < prev.ctx * 0.9;
			if (shrunk) s.shrinks++;
			// cache bust: a big uncached write that did not reuse the prefix, with no compaction / model change / TTL gap before it
			if (uncached > BUST_UNCACHED && prev) {
				const gapMin = (ts - prev.ts) / 60e3;
				const why = compacted ? "compaction" : modelChanged ? "model change" : thinkChanged ? "thinking change" : gapMin > prev.ttlMin ? `gap>${prev.ttlMin}m` : "";
				if (why) s.explained[why] = (s.explained[why] ?? 0) + 1;
				else if (cr < prev.ctx * 0.8) {
					const seen = [...new Set(injected)];
					const bustCost = (u.cost?.cacheWrite ?? 0) + (u.cost?.input ?? 0);
					const decision = decisionIn(prev.ts, ts);
					const prior = decisionIn(prev.before ?? -Infinity, prev.ts);
					const rebuilt = shrunk ? ""
						: decision && REBUILD_KINDS.has(decision.kind) ? `${decision.kind}/${decision.reason}`
						: prior && REBUILD_KINDS.has(prior.kind) ? AFTER_REBUILD : "";
					if (rebuilt) {
						const key = rebuilt === AFTER_REBUILD ? rebuilt : `재구성(${rebuilt})`;
						s.explained[key] = (s.explained[key] ?? 0) + 1;
						s.rebuilds.push({ ts, uncached, cost: bustCost, label: rebuilt });
					} else {
						const cause = shrunk ? "shrink"
							: seen.includes("omo-memory:projection-pin") && ts - lastCompactTs < 20 * 60e3 ? "repin"
							: seen.includes("environment-context") && new Date(prev.ts).toISOString().slice(0, 10) !== new Date(ts).toISOString().slice(0, 10) ? "date"
							: prev.before !== undefined && prev.ts - prev.before >= IDLE_GAP ? "idle" : "";
						s.busts.push({ ts, uncached, cr, prevCtx: prev.ctx, cost: bustCost, events: seen, cause });
					}
				}
				else s.bigNew++; // prefix reused; the write is genuinely new content
			}
			// idle wake: a new turn started by notifications only, ending with no tool call and a tiny reply
			const wakeBy = src.runtime === "omo" ? events.filter(e => OMO_WAKE.has(e)) : events;
			if (newTurn && !user && wakeBy.length && !calls.length && (u.output ?? 0) <= IDLE_OUT) {
				addWake(s, wakeBy.at(-1) ?? "custom", tokens, cost);
			}
			addBigContext(s, run, ctx, BIG_CTX, tokens, cost);
			if (s.intended && !sameModel(model, s.intended)) {
				s.fbTurns++;
				s.fbModels.add(model);
				s.fbIntended.add(s.intended);
				if (!fbOpen) s.fbSegs.push([]);
				fbOpen = true;
				s.fbSegs.at(-1)!.push(ts);
			} else fbOpen = false;
			addToolCalls(s, run, calls, tokens, cost);
		}
		s.intended ??= model;
		// omp reports the cache TTL in cttl. OmO's record has no TTL (senpi's claude-sdk-oauth usage drops cacheWrite1h), so
		// its TTL is what the session showed: a cache read after a gap over 5 minutes means the 1h cache (PI_CACHE_RETENTION=long).
		if (src.runtime === "omo" && prev && ts - prev.ts > 5 * 60e3 && cr >= prev.ctx * 0.8) omoLong = true;
		const ttlMin = u.cttl?.ephemeral1h ? 60 : u.cttl?.ephemeral5m ? 5 : src.runtime === "omo" ? (omoLong ? 60 : 5) : (prev?.ttlMin ?? 5);
		prev = { ts, ctx, ttlMin, out: u.output ?? 0, before: prev?.ts };
		prevStop = m.stopReason ?? "stop";
		events = [];
		injected = [];
		compacted = modelChanged = thinkChanged = user = false;
	}
	s.readRate = readTok ? readCost / readTok : 0;
	return s;
}

type Finding = { flag: boolean; kind: string; who: string; what: string; amount: string; save: number; cost?: number; evidence?: string; fix?: string; hold?: string; tip?: string; recur?: number };

// Minutes a fallback segment ran after the intended model had capacity again (0 when every turn sat inside a 429 window).
export function fallbackAfterCapacity(seg: number[], exhaust: Exhaust[]): number {
	const free = seg.filter(t => !exhaust.some(e => t >= e.from && t <= e.to));
	if (!free.length) return 0;
	const back = Math.max(seg[0], ...exhaust.filter(e => e.to <= free[0]).map(e => e.to));
	return (free.at(-1)! - back) / 60e3;
}

// `asked`: which parts of a session's expensive use the owner asked for (hub/owner-asked.ts); those parts are no warning.
const NOT_ASKED: Covered = { model: false, effort: false };
export function findingsOf(results: Stats[], exhaust: Exhaust[] = [], asked: (s: Stats) => Covered = () => NOT_ASKED): Finding[] {
	const F: Finding[] = [];
	for (const s of results) {
		const who = s.src.label;
		if (s.busts.length) {
			const uncached = s.busts.reduce((a, b) => a + b.uncached, 0);
			const cost = s.busts.reduce((a, b) => a + b.cost, 0);
			const save = s.busts.reduce((a, b) => a + Math.max(0, b.cost - b.uncached * s.readRate), 0);
			const count: Record<string, number> = {};
			for (const e of s.busts.filter(b => !b.cause).flatMap(b => b.events)) count[e] = (count[e] ?? 0) + 1;
			const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e);
			const known = Object.keys(CAUSE).map(c => [c, s.busts.filter(b => b.cause === c).length] as const).filter(([, n]) => n);
			F.push({
				flag: s.busts.length >= 3 || uncached > 1e6, kind: "캐시 깨짐", who, tip: "직전 주입 이벤트 확인",
				what: `캐시 깨짐 ${s.busts.length}회 (압축/모델 변경/TTL 공백 아님)`, amount: `미캐시 재입력 ${M(uncached)} tok, ${usd(cost)}`, save, cost,
				evidence: s.busts.slice(0, 6).map(b => `${kst(b.ts)} 새로 ${K(b.uncached)}/읽기 ${K(b.cr)} (직전 ${K(b.prevCtx)}) <- ${b.cause ? `${b.cause === "idle" ? "" : "원인: "}${CAUSE[b.cause][0]}` : b.events.join(", ") || "모델에 가는 주입 이벤트 없음: 도구 목록/시스템 프롬프트 변경 의심(미증명)"}`).join("; "),
				fix: [
					...known.map(([c, n]) => `${CAUSE[c][0]} x${n} -> ${CAUSE[c][1]}`),
					...new Set(top.flatMap(e => BUST_FIX.find(([re]) => re.test(e))?.[1] ?? [])),
					...(known.reduce((a, [, n]) => a + n, 0) >= s.busts.length ? [] : top.length ? [`제안: 직전 주입 이벤트(${top.join(", ")})가 프롬프트 앞부분을 바꾸는지 확인해 고정 - 예상 절감 ~${usd(save)} (같은 토큰을 쓰기 대신 읽기로). 컨텍스트·모델은 그대로라 성능 영향 없음`] : ["원인 미증명: 세션 재구성도 주입 이벤트도 아님"]),
				].join(" / "),
			});
		}
		const wakes = Object.entries(s.wakes);
		const wakeN = wakes.reduce((a, [, w]) => a + w.n, 0);
		if (wakeN) {
			const tokens = wakes.reduce((a, [, w]) => a + w.tokens, 0);
			const cost = wakes.reduce((a, [, w]) => a + w.cost, 0);
			F.push({
				flag: wakeN >= 10 || cost >= 5, kind: "헛깨움", who, tip: "알림을 소스에서 거르기", what: `할 일 없이 깨어난 턴 ${wakeN}회`, amount: `${M(tokens)} tok, ${usd(cost)}`, save: cost, cost,
				evidence: wakes.sort((a, b) => b[1].cost - a[1].cost).map(([k, w]) => `${k} ${w.n}회 ${usd(w.cost)}`).join(", "),
				fix: `제안: 반응할 필요 없는 알림(모니터링 라인·완료 알림 중복)을 소스에서 걸러 세션을 깨우지 않게 - 예상 절감 ~${usd(cost)}. 실제 일을 시키는 이벤트는 그대로라 성능 영향 없음`,
			});
		}
		if (s.maxErrStreak >= 3) {
			F.push({
				flag: s.maxErrStreak >= 5, kind: "에러 연속", who, tip: "재시도 상한 확인",
				what: `에러 턴 ${s.errTurns}회, 최장 연속 ${s.maxErrStreak}회 (${Object.entries(s.errCodes).map(([k, v]) => `${k}x${v}`).join(", ")})`,
				amount: "대부분 0토큰, 대기·재시도 시간 낭비", save: 0, evidence: s.compactErr ? `압축 실패 ${s.compactErr}회 포함` : undefined,
				fix: "제안: 429는 리셋까지 멈추고 재시도 상한을 확인 - 결과물엔 영향 없음",
			});
		}
		if (s.maxBigStreak >= 10) {
			F.push({
				flag: s.compactErr > 0, kind: "대형 컨텍스트", who, tip: "압축이 도는지 확인",
				what: `컨텍스트 >${K(BIG_CTX)}로 압축 없이 연속 ${s.maxBigStreak}턴 (최대 ${K(s.maxCtx)})`,
				amount: `해당 턴 ${M(s.bigTokens)} tok, ${usd(s.bigCost)}`, save: 0, evidence: `압축 ${s.compactions}회, 압축 실패 ${s.compactErr}회`,
				fix: s.compactErr ? "제안: 압축 실패 원인 수리(설정된 자동 압축이 원래대로 돌게) - 의도된 동작 복원이라 트레이드오프 없음" : undefined,
				hold: s.compactErr ? undefined : "보류(트레이드오프 있음): 압축 기준을 낮추면 토큰은 줄지만 작업 맥락이 줄어듦",
			});
		}
		const ok = s.fable || s.effortTurns ? asked(s) : NOT_ASKED;
		const fable = ok.model ? 0 : s.fable, effortTurns = ok.effort ? 0 : s.effortTurns;
		if (fable || effortTurns) {
			const parts = [fable ? `비싼 모델 응답 ${s.fable}회 (${usd(s.fableCost)})` : "", effortTurns ? `비싼 생각 수준 ${s.effortTurns}턴 (${usd(s.effortCost)}; ${[...s.efforts].join(", ")})` : ""].filter(Boolean);
			const cost = fable && effortTurns ? s.expensiveCost : fable ? s.fableCost : s.effortCost;
			F.push({
				flag: fable > 0 || effortTurns >= EFFORT_FLAG_TURNS, kind: "비싼 모델", who, tip: "오너가 요청한 것인지 확인",
				what: parts.join(" + "), amount: usd(cost), save: 0, cost,
				evidence: "규칙: 설정(guard.expensive_models)에 적은 모델·생각 수준은 오너가 요청할 때만 (오너가 요청한 세션이면 무시)",
				fix: "제안: 이 세션/워커의 모델 경로(역할·폴백 체인·레인 모델 선택)에서 비싼 모델이 기본으로 새어 들어오는지 확인",
			});
		}
		if (s.fbTurns >= 5) {
			// A fallback while the intended model is rate-limited is the chain working; staying on it >60 min after is the leak.
			const after = Math.max(0, ...s.fbSegs.map(seg => fallbackAfterCapacity(seg, exhaust)));
			F.push({
				flag: s.fbTurns >= 20 && after > 60, kind: "폴백 모델", who, tip: "원래 모델 복귀 확인", what: `의도한 ${[...s.fbIntended].join(", ")}이 아닌 ${[...s.fbModels].join(", ")}로 ${s.fbTurns}턴`, amount: `${s.fbTurns}턴`, save: 0,
				evidence: after > 0 ? `한도(429)가 풀린 뒤에도 폴백 ${Math.round(after)}분` : "모두 한도(429 retry-after) 안의 폴백: 체인이 정상 작동 중",
				fix: after > 60 ? "제안: 한도가 풀린 뒤에도 폴백에 머무는지 확인 - 의도한 모델 복원" : undefined,
			});
		}
		if (s.maxToolStreak >= 5) {
			F.push({
				flag: true, kind: "반복 호출", who, tip: "폴링 대신 한 번 대기", what: `같은 도구 호출 연속 ${s.maxToolStreak}회`, amount: `~${M(s.loopTokens)} tok, ${usd(s.loopCost)}`, save: s.loopCost, cost: s.loopCost, evidence: s.maxToolDesc,
				fix: `제안: 같은 호출로 폴링하는 대신 wait/monitor로 대기 - 예상 절감 ~${usd(s.loopCost)}, 결과 동일`,
			});
		}
		if (s.src.child && s.tokens > SUB_NOTE) {
			F.push({
				flag: s.tokens > SUB_FLAG, kind: "대형 하위에이전트", who, tip: "브리프를 단계별 워커로 분할",
				what: `${M(s.tokens)} tok, ${s.turns}턴, 압축 ${s.compactions}회, 최대 컨텍스트 ${K(s.maxCtx)}`, amount: usd(s.cost), save: 0, cost: s.cost,
				fix: "제안: 브리프를 독립 단계(조사 -> 구현 -> 검증)로 나눠 별도 워커로, 후속은 새 워커로 - 모델·검증은 그대로",
			});
		}
	}
	// Busts with a known cause in OmO's own log: one note, never the unexplained warning or its escalation.
	const rebuilds = results.flatMap(s => s.rebuilds);
	if (rebuilds.length) {
		const sum = (l: Rebuild[]) => `${l.length}회 ${M(l.reduce((a, r) => a + r.uncached, 0))} tok`;
		const after = rebuilds.filter(r => r.label === AFTER_REBUILD);
		const direct = rebuilds.filter(r => r.label !== AFTER_REBUILD);
		const cost = rebuilds.reduce((a, r) => a + r.cost, 0);
		F.push({
			flag: false, kind: "세션 재구성", who: "전체", what: `세션 재구성으로 캐시 깨짐 ${sum(direct)}, 재구성 직후 큰 쓰기 ${sum(after)}`,
			amount: `미캐시 재입력 ${M(rebuilds.reduce((a, r) => a + r.uncached, 0))} tok, ${usd(cost)}`, save: 0, cost,
			evidence: Object.entries(Object.groupBy(direct, r => r.label)).sort((a, b) => b[1]!.length - a[1]!.length).map(([label, l]) => `${label} ${sum(l!)}`).join(", ") || undefined,
		});
	}
	return F;
}

const median = (xs: number[]) => {
	const a = [...xs].sort((x, y) => x - y);
	return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
};

function readHistory(): Day[] {
	try {
		return JSON.parse(readFileSync(HISTORY, "utf8")).days ?? [];
	} catch {
		return [];
	}
}

// What reaches the owner is built from what matters, not a fixed form (owner 2026-10-29: "마이너한 경우에는 메시지에서 제외"): a warning is
// told only when it costs at least MINOR_USD, keeps costing three days running, or is the day's spike; the rest stays in the report (a
// 0-token error streak is the gateway's own error alert's matter). With
// nothing that matters, nothing is sent. The decision (원인 확인 / 넘어가요) is asked only when something is told.
export const MINOR_USD = 1;
export const material = (f: Pick<Finding, "flag" | "kind" | "recur" | "cost" | "save">): boolean =>
	f.flag && (f.kind === "급증" || (f.cost ?? f.save ?? 0) >= MINOR_USD || ((f.recur ?? 0) >= 3 && (f.cost ?? f.save ?? 0) > 0));
export function auditAlert(a: { since: number; now: number; total: number; totalCost: number; flags: Finding[]; recurring: string[]; reportPath: string }): string | undefined {
	const told = a.flags.filter(material);
	if (!told.length) return undefined;
	const minor = a.flags.length - told.length;
	const plain = (t: string) => t.replace(/ tok\b/g, " 토큰");
	const brief = (f: Finding) => `- ${f.kind} ${f.who.replace(/ 워커 /, " · ")}: ${plain(f.amount.split(" / ")[0])}${f.tip ? ` → ${f.tip}` : ""}`;
	const recurring = a.recurring.filter(k => told.some(f => f.kind === k));
	return [
		`토큰 점검 (${kst(a.since)}~${kst(a.now)}): ${M(a.total)} 토큰 ${usd(a.totalCost)}, 볼 만한 경고 ${told.length}건`,
		...(recurring.length ? [`며칠째 반복: ${recurring.join(", ")}`] : []),
		...Object.values(Object.groupBy([...told].sort((x, y) => (y.cost ?? y.save) - (x.cost ?? x.save)), f => f.kind)).slice(0, 4).map(g => (g!.length === 1 ? brief(g![0]) : `${brief(g![0])} 외 ${g!.length - 1}건`)),
		`전체 보고서: ${tilde(a.reportPath)}${minor ? ` (사소한 경고 ${minor}건은 보고서에만)` : ""}`,
	].join("\n") + `\n${issueBlock("이 경고를 어떻게 할까요?", [{ name: "원인 확인", result: "세션별 원인을 살펴보고 고칠 방법을 제안해요." }, { name: "이번엔 넘어가요", result: "보고서만 남기고 다음 점검 때 다시 봐요." }])}`;
}

// `told`: the warnings that matter (material); the doctor makes one finding of each class.
export type AuditResult = { ownerUse: { sessions: number; cost: number }; told: Finding[]; flags: number; notes: number; sessions: number; tokens: number; cost: number; report: string; alert?: string; summary: string };

// The owner's basis for expensive use, read once per run; a worker is judged on its parent session's target.
function askedBy(results: Stats[], basis = readOwnerBasis(join(DATA_DIR, "state", "model-picks.json"), paths.log, join(DATA_DIR, "lanes"))): (s: Stats) => Covered {
	const targetOf = new Map(results.flatMap(s => {
		const id = s.src.file.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1];
		return id && s.src.target ? [[id, s.src.target] as const] : [];
	}));
	return s => ownerCovered({ models: [...s.dearModels], levels: [...s.dearLevels], first: s.dearFirst, last: s.dearLast }, s.src.parent ? targetOf.get(s.src.parent) : s.src.target, s.src.child, basis);
}
// The audited sessions as the usage screen names them (hub/usage-share.ts): main's sessions as one row, a lane's as one, a task's as one.
const whoOf = (s: Stats): [SessionUse["kind"], string] => {
	const task = s.src.label.match(/^task:(.+?) \(st_/)?.[1];
	const t = s.src.target;
	return task ? ["worker", task] : t === "orchestrator" ? ["orchestrator", ""] : t?.startsWith("lane:") ? ["lane", t.slice(5)] : ["other", s.src.label.replace(/ \[(?:OmO|omp)\]$/, "")];
};
export function useOf(results: Stats[]): SessionUse[] {
	const out = new Map<string, SessionUse>();
	for (const s of results) {
		const [kind, name] = whoOf(s);
		const row = out.get(`${kind}\0${name}`) ?? { kind, name, models: {}, cost: 0, tokens: 0 };
		row.cost += s.cost;
		row.tokens += s.tokens;
		for (const [m, c] of Object.entries(s.modelCost)) row.models[m] = (row.models[m] ?? 0) + c;
		out.set(`${kind}\0${name}`, row);
	}
	return [...out.values()];
}

// What the usage screen offers to fix (hub/usage-fix.ts applies it, only on the owner's press). A fix exists only where the remedy is one
// known step: a watch whose matches keep waking a session (its interval doubles), a context left big without compaction (compact it
// now), task workers on an expensive model nobody asked for (their target's worker model goes back to the default). An unexplained
// cache bust has no such step: its row says to check the cause. Biggest cost first, at most FIX_MAX rows.
const FIX_MAX = 6, WATCH_FIX_WAKES = 10, WATCH_FIX_COST = 2;
export function fixesOf(results: Stats[], asked: (s: Stats) => Covered = () => NOT_ASKED): FixRow[] {
	const rows = new Map<string, FixRow>();
	const add = (row: FixRow) => {
		const had = rows.get(row.id);
		rows.set(row.id, had ? { ...had, cost: had.cost + row.cost, n: (had.n ?? 0) + (row.n ?? 0) } : row);
	};
	const watches: Record<string, { n: number; cost: number }> = {};
	for (const s of results) {
		const [kind, name] = whoOf(s);
		for (const [w, v] of Object.entries(s.watchWakes)) {
			const t = (watches[w] ??= { n: 0, cost: 0 });
			t.n += v.n;
			t.cost += v.cost;
		}
		if (s.src.target && s.maxBigStreak >= 10 && !s.compactErr) add({ id: `compact:${s.src.target}`, fix: "compact", target: s.src.target, who: { kind, name }, cost: s.bigCost });
		const parent = s.src.parent ? results.find(r => r.src.file.includes(s.src.parent!))?.src.target : undefined;
		const model = [...s.dearModels][0];
		if (parent && model && s.fable && !asked(s).model) {
			const target = parent === "orchestrator" ? "workers" : parent;
			const [pk, pn] = parent === "orchestrator" ? ["orchestrator", ""] as const : ["lane", parent.slice(5)] as const;
			add({ id: `worker:${target}:${model}`, fix: "worker", target, model, who: { kind: pk, name: pn }, cost: s.fableCost, n: 1 });
		}
		if (s.busts.length >= 3 || s.busts.reduce((a, b) => a + b.uncached, 0) > 1e6) add({ id: `check:bust:${s.src.file}`, fix: "check", who: { kind, name }, cost: s.busts.reduce((a, b) => a + b.cost, 0), n: s.busts.length });
	}
	for (const [w, v] of Object.entries(watches)) if (v.n >= WATCH_FIX_WAKES || v.cost >= WATCH_FIX_COST) add({ id: `watch:${w}`, fix: "watch", watch: w, who: { kind: "other", name: w }, cost: v.cost, n: v.n });
	return [...rows.values()].map(r => ({ ...r, cost: Number(r.cost.toFixed(2)) })).sort((a, b) => b.cost - a.cost).slice(0, FIX_MAX);
}

// Sessions whose expensive use the owner asked for (all or part of it), and what that part cost.
export function ownerUseOf(results: Stats[], asked: (s: Stats) => Covered): { sessions: number; cost: number } {
	let sessions = 0, cost = 0;
	for (const s of results) {
		if (!s.fable && !s.effortTurns) continue;
		const ok = asked(s), model = ok.model && s.fable > 0, effort = ok.effort && s.effortTurns > 0;
		if (!model && !effort) continue;
		sessions++;
		cost += model && (effort || !s.effortTurns) ? s.expensiveCost : model ? s.fableCost : s.effortCost;
	}
	return { sessions, cost: Number(cost.toFixed(2)) };
}

function auditEnabled(): boolean {
	return String((cfg as { doctor_at?: string }).doctor_at ?? DEFAULTS.doctor_at) !== "off";
}

// One-line audit summary for the nightly reflection digest: the latest recorded audit (today or yesterday, KST).
export function auditSummaryLine(now = Date.now()): string | undefined {
	if (!auditEnabled()) return undefined;
	const last = readHistory().at(-1);
	if (!last?.report || ![kstDate(now), kstDate(now - 86400e3)].includes(last.date)) return undefined;
	return `token audit ${last.date}: ${last.flags} warning(s)${last.kinds?.length ? ` (${last.kinds.join(", ")})` : ""}, ${last.sessions} sessions, ${M(last.tokens)} tokens ${usd(last.cost)}, report ${tilde(last.report)}`;
}

// `dry`: history is not recorded; `readOnly`: the report file is not written either (the doctor's --dry).
export function runAudit(opts: { hours?: number; dry?: boolean; readOnly?: boolean } = {}): AuditResult {
	const t0 = Date.now();
	const now = Date.now();
	const hours = opts.hours && opts.hours > 0 ? opts.hours : 24;
	const since = now - hours * 3600e3;
	const exhaust: Exhaust[] = [];
	const decisions = readDecisions();
	const results = collect(since).flatMap(src => {
		try {
			const s = analyze(src, since, exhaust, decisions);
			return s.turns + s.errTurns > 0 ? [s] : [];
		} catch (error) {
			console.error(`skip ${src.file}: ${error}`);
			return [];
		}
	});
	const asked = askedBy(results);
	const findings = findingsOf(results, exhaust, asked);
	const ownerUse = ownerUseOf(results, asked);
	const omo = results.filter(s => s.src.runtime === "omo").length;
	const total = results.reduce((a, s) => a + s.tokens, 0);
	const totalCost = results.reduce((a, s) => a + s.cost, 0);
	const totalCw = results.reduce((a, s) => a + s.cw, 0);
	const today = kstDate(now);
	let history = readHistory();
	const prior = history.filter(d => d.date !== today).slice(-7);
	const medTok = median(prior.map(d => d.tokens));
	const medCost = median(prior.map(d => d.cost));
	if (prior.length >= 3 && (total > 2 * medTok || totalCost > 2 * medCost)) {
		const top = [...results].sort((a, b) => b.cost - a.cost).slice(0, 3).map(s => `${s.src.label} ${M(s.tokens)}`).join(", ");
		findings.push({ flag: true, kind: "급증", who: "전체", tip: "상위 세션 확인", what: `합계가 7일 중앙값의 ${(total / Math.max(1, medTok)).toFixed(1)}배`, amount: `${M(total)} tok (${usd(totalCost)}) vs 중앙값 ${M(medTok)} (${usd(medCost)})`, save: 0, evidence: `상위: ${top}` });
	}
	// 🔁: flagged today and on every day since yesterday back (consecutive days) for the same class
	for (const f of findings) {
		if (!f.flag) continue;
		let streak = 0;
		for (let d = 1; d <= 7; d++) {
			const day = history.find(x => x.date === kstDate(now - d * 86400e3));
			if (!day?.kinds?.includes(f.kind)) break;
			streak++;
		}
		if (streak) f.recur = streak + 1;
	}
	const flags = findings.filter(f => f.flag);
	const kinds = [...new Set(flags.map(f => f.kind))];
	const recurring = [...new Set(flags.filter(f => f.recur).map(f => f.kind))];
	const reportPath = join(LOG_DIR, `token-audit-${today.replace(/-/g, "")}.md`);
	if (!opts.dry) {
		history = [...history.filter(d => d.date !== today), { date: today, tokens: total, cost: totalCost, cacheWrite: totalCw, sessions: results.length, flags: flags.length, kinds, report: reportPath, use: { ...sharesOf(useOf(results), now, hours), fixes: fixesOf(results, asked) } }].slice(-14);
		writeAtomic(HISTORY, `${JSON.stringify({ updated: new Date(now).toISOString(), days: history }, null, 1)}\n`);
	}
	const ordered = [...findings].sort((a, b) => Number(b.flag) - Number(a.flag) || b.save - a.save);
	const sorted = [...results].sort((a, b) => b.tokens - a.tokens);
	const report = [
		`# 토큰 누수 점검 ${today} (KST)`,
		"",
		`기간: ${kst(since)} ~ ${kst(now)} KST (${hours}h) · 세션 ${results.length}개 (OmO ${omo}, omp ${results.length - omo}) · 합계 ${M(total)} tok · ${usd(totalCost)} · 캐시 쓰기 ${M(totalCw)} · 분석 ${((Date.now() - t0) / 1000).toFixed(1)}s${opts.dry ? " · dry(기록 안 함)" : ""}`,
		`7일 중앙값: ${prior.length ? `${M(medTok)} tok / ${usd(medCost)} (${prior.length}일)` : "기록 없음"}`,
		"",
		...(ownerUse.sessions ? [msg().doctor.ownerExpensive(ownerUse.sessions, usd(ownerUse.cost)), ""] : []),
		"모든 항목은 보고만 해요. 자동 적용은 없어요. \"제안\"은 성능 트레이드오프가 없는 것만, 트레이드오프가 있는 후보는 \"보류\"로 따로 표시해요.",
		"",
		`## 경고 ${flags.length}건 / 참고 ${findings.length - flags.length}건`,
		...ordered.flatMap(f => [
			"",
			`### ${f.recur ? "🔁" : ""}${f.flag ? "⚠️" : "ℹ️"} [${f.kind}] ${f.who}`,
			`- ${f.what} - ${f.amount}`,
			...(f.recur ? [`- 🔁 ${f.recur}일 연속 경고 · 기존 규칙: ${RULES[f.kind] ?? "없음 -> 규칙 신설 필요"} -> 규칙이 있는데 재발하면 문구를 더하지 말고, 그 규칙이 일을 스폰하는 세션(브리프·레인 계약·가드)에 실리는지부터 점검`] : []),
			...(f.evidence ? [`- 근거: ${f.evidence}`] : []),
			...(f.fix ? [`- ${f.fix}`] : []),
			...(f.hold ? [`- ${f.hold}`] : []),
		]),
		"",
		"## 세션별 (토큰 순)",
		"",
		"| 세션 | 시작(KST) | 턴 | 토큰 | 비용 | 캐시 읽기 | 캐시 쓰기 | 출력 | 깨짐 | 설명된 큰 쓰기 | 헛깨움 | 워밍 | 에러 | 최대 컨텍스트 | 압축 |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...sorted.map(s => `| ${s.src.label} | ${s.start ? kst(s.start) : "-"} | ${s.turns} | ${M(s.tokens)} | ${usd(s.cost)} | ${M(s.cr)} | ${M(s.cw)} | ${K(s.out)} | ${s.busts.length} | ${Object.entries(s.explained).map(([k, v]) => `${k}x${v}`).join(" ") || "-"}${s.bigNew ? ` 새내용x${s.bigNew}` : ""}${s.shrinks ? ` 축소x${s.shrinks}` : ""} | ${Object.values(s.wakes).reduce((a, w) => a + w.n, 0)} | ${s.warmings} | ${s.errTurns} | ${K(s.maxCtx)} | ${s.compactions} |`),
		"",
		"## 최근 기록",
		"",
		...(opts.dry ? ["(dry 실행: 기록 없음)"] : history.map(d => `- ${d.date}: ${M(d.tokens)} tok, ${usd(d.cost)}, 캐시 쓰기 ${M(d.cacheWrite)}, 세션 ${d.sessions}, 경고 ${d.flags}`)),
		"",
		`기준: 캐시 깨짐 = 미캐시 입력(캐시 쓰기+input) >${K(BUST_UNCACHED)}이면서 캐시 읽기가 직전 컨텍스트의 80% 미만이고, 직전에 압축/모델·thinking 변경/TTL(1h, 5m) 초과 공백이 없음. 헛깨움 = 사용자 입력 없이 알림만으로 시작된 턴이 도구 호출 없이 출력 ${IDLE_OUT} tok 이하로 끝남. 하위에이전트 >${M(SUB_NOTE)} 참고, >${M(SUB_FLAG)} 경고. 비싼 모델 = Fable 응답 또는 max/xhigh 생각 수준 ${EFFORT_FLAG_TURNS}턴 이상. 깨짐 원인(OmO): 직전 요청이 ${K(REDUCE_GATE)} 이상이고 압축 없이 10% 넘게 줄면 맥락 축소, 압축 20분 안의 projection-pin이면 재핀, environment-context와 UTC 날짜 변경이면 날짜, 5분 넘게 쉰 뒤 둘째 호출이면 유휴 패턴(기전 미증명). 세션 재구성 = OmO 연속성 로그에서 그 호출이 flatten/fork/bootstrap이면 재구성, 바로 앞 호출이 그랬으면 재구성 직후로 따로 세고 깨짐에 넣지 않음(맥락 축소가 우선). 폴백 = 의도한 모델(폴백 전환 전 모델, 워커는 요청 모델)과 다른 모델 턴; Anthropic 429 retry-after 안이면 참고, 풀린 뒤 60분 넘게 폴백이면 경고. 🔁 = 같은 클래스가 어제까지 연속으로 경고였음(기존 규칙은 MODE.md 섹션명으로 표기).`,
	].join("\n");
	if (!opts.readOnly) {
		mkdirSync(LOG_DIR, { recursive: true });
		writeFileSync(reportPath, `${report}\n`);
	}
	const alert = auditAlert({ since, now, total, totalCost, flags, recurring, reportPath });
	const summary = `토큰 점검: 세션 ${results.length}개, ${M(total)} tok ${usd(totalCost)}, 경고 ${flags.length}건 / 참고 ${findings.length - flags.length}건, 보고서 ${tilde(reportPath)}${ownerUse.sessions ? ` · ${msg().doctor.ownerExpensive(ownerUse.sessions, usd(ownerUse.cost))}` : ""}`;
	return { ownerUse, told: flags.filter(material), flags: flags.length, notes: findings.length - flags.length, sessions: results.length, tokens: total, cost: Number(totalCost.toFixed(2)), report: reportPath, alert, summary };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const dry = argv.includes("--dry");
	if (!dry) {
		console.error("usage: bun hub/token-audit.ts --dry [--hours N]  (the nightly run belongs to the doctor, hub/doctor.ts)");
		process.exit(1);
	}
	const r = runAudit({ hours: Number(argv[argv.indexOf("--hours") + 1]) || 24, dry });
	console.log(r.alert ? `--- (dry) would send to alert ---\n${r.alert}\n---` : "--- (dry) clean, nothing to send ---");
	console.log(r.summary);
	console.log(`RESULT ${JSON.stringify({ flags: r.flags, notes: r.notes, sessions: r.sessions, tokens: r.tokens, cost: r.cost, report: r.report })}`);
}
