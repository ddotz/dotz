// Token-leak audit for omp and OmO sessions (ported from the owner's harness token-audit script). Pure TS, no LLM calls, report only.
// Scans the session files of both runtimes (hub/session-sources.ts, the reader the nightly audit uses: main sessions,
// their subagent children and OmO task workers) active in the last N hours, writes the full
// report to <DOTZ_DIR>/logs/token-audit-session-YYYYMMDD.md and returns a short summary. The 7-day history for the spike
// check is the one the gateway's nightly audit keeps (<DOTZ_DIR>/token-audit.json); it is only read here. Every fix is a
// suggestion; nothing is applied. Suggestions are limited to no-trade-off fixes; cuts that could cost capability go to "hold".
// Used by /token-audit and the harness_token_audit tool (harness-tools.ts); `bun extension/token-audit.ts [hours]` prints it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { baseLanguage, systemLanguage } from "../hub/language.ts";
import { collectSessions, OMO_WAKE, type Runtime, type Src } from "../hub/session-sources.ts";
import { dataDir } from "./guard-config.ts";

const BUST_UNCACHED = 50_000;
const BIG_CTX = 300_000;
const SUB_NOTE = 20e6;
const SUB_FLAG = 50e6;
const IDLE_OUT = 300;

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (ms: number) => {
	const d = new Date(ms);
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const K = (n: number) => `${Math.round(n / 1e3)}K`;
const usd = (n: number) => `$${n.toFixed(2)}`;

type Bust = { ts: number; uncached: number; cr: number; prevCtx: number; cost: number; events: string[] };
type Stats = {
	src: Src;
	turns: number;
	tokens: number;
	cost: number;
	cw: number;
	cr: number;
	out: number;
	maxCtx: number;
	compactions: number;
	busts: Bust[];
	explained: Record<string, number>;
	bigNew: number;
	wakes: Record<string, { n: number; tokens: number; cost: number }>;
	warmings: number;
	ttsr: number;
	errTurns: number;
	maxErrStreak: number;
	errCodes: Record<string, number>;
	compactErr: number;
	maxBigStreak: number;
	bigTokens: number;
	bigCost: number;
	intended?: string;
	fbTurns: number;
	fbModels: Set<string>;
	expensive: number;
	expensiveCost: number;
	expensiveModels: Set<string>;
	maxToolStreak: number;
	maxToolDesc: string;
	loopTokens: number;
	loopCost: number;
	readRate: number;
	start?: number;
};
type Finding = { flag: boolean; kind: string; who: string; what: string; amount: string; save: number; evidence?: string; fix?: string; hold?: string };
type Day = { date: string; tokens: number; cost: number; cacheWrite: number; sessions: number; flags: number };

// Report text per language: Korean for a Korean identity, English otherwise.
const LANG = {
	ko: {
		title: (d: string) => `# 토큰 누수 점검 ${d}`,
		period: (from: string, to: string, hours: number, sessions: number, tok: string, cost: string, cw: string) => `기간: ${from} ~ ${to} (${hours}h) · 세션 ${sessions}개 · 합계 ${tok} tok · ${cost} · 캐시 쓰기 ${cw}`,
		median: (text: string) => `7일 중앙값: ${text}`,
		noHistory: "기록 없음",
		note: "모든 항목은 보고만 합니다. 자동 적용 없음. \"제안\"은 성능 트레이드오프가 없는 것만, 트레이드오프가 있는 후보는 \"보류\"로 따로 표시합니다.",
		heading: (flags: number, notes: number) => `## 경고 ${flags}건 / 참고 ${notes}건`,
		flag: "경고",
		info: "참고",
		evidence: "근거",
		perSession: "## 세션별 (토큰 순)",
		recent: "## 최근 기록",
		all: "전체",
		bust: {
			kind: "캐시 깨짐",
			what: (n: number) => `캐시 깨짐 ${n}회 (압축/모델 변경/TTL 공백 아님)`,
			amount: (tok: string, cost: string) => `미캐시 재입력 ${tok} tok, ${cost}`,
			line: (t: string, n: string, r: string, p: string, ev: string) => `${t} 새로 ${n}/읽기 ${r} (직전 ${p}) <- ${ev || "이벤트 없음: 도구 목록/시스템 프롬프트 변경 의심"}`,
			fix: (top: string, save: string) => `제안: 직전 주입 이벤트(${top || "없음"})가 프롬프트 앞부분을 바꾸는지 확인해 고정 - 예상 절감 ~${save}. 컨텍스트·모델은 그대로라 성능 영향 없음`,
		},
		wake: {
			kind: "헛깨움",
			what: (n: number) => `할 일 없이 깨어난 턴 ${n}회`,
			fix: (save: string) => `제안: 반응할 필요 없는 알림(모니터 라인·완료 알림 중복)을 소스에서 걸러 세션을 깨우지 않게 - 예상 절감 ~${save}. 실제 일을 시키는 이벤트는 그대로`,
			times: (k: string, n: number, cost: string) => `${k} ${n}회 ${cost}`,
		},
		ttsr: {
			kind: "TTSR 개입",
			what: (n: number) => `스트림 규칙(TTSR)이 응답을 끊고 다시 시도시킨 횟수 ${n}회`,
			amount: (n: number) => `${n}회`,
			fix: "제안: 어떤 규칙이 반복되는지 세션 파일의 ttsr_injection 항목으로 확인하고, 매번 걸리는 규칙은 지시문으로 옮기거나 ttsr.disabledRules로 끄기 - 규칙의 의도는 유지",
		},
		err: {
			kind: "에러 재시도",
			what: (turns: number, streak: number, codes: string) => `에러 턴 ${turns}회, 최장 연속 ${streak}회 (${codes})`,
			amount: "대부분 0토큰, 대기·재시도 시간 낭비",
			evidence: (n: number) => `압축 실패 ${n}회 포함`,
			fix: "제안: 429는 리셋까지 멈추고 재시도 상한 확인(retry.maxRetries) - 결과물엔 영향 없음",
		},
		big: {
			kind: "대형 컨텍스트",
			what: (limit: string, n: number, max: string) => `컨텍스트 >${limit}로 압축 없이 연속 ${n}턴 (최대 ${max})`,
			amount: (tok: string, cost: string) => `해당 턴 ${tok} tok, ${cost}`,
			evidence: (c: number, e: number) => `압축 ${c}회, 압축 실패 ${e}회`,
			fix: "제안: 압축 실패 원인 수리(설정된 자동 압축이 원래대로 돌게) - 의도된 동작 복원",
			hold: "보류(트레이드오프 있음): 압축 기준을 낮추면 토큰은 줄지만 작업 맥락이 줄어듦",
		},
		dear: {
			kind: "비싼 모델",
			what: (n: number, models: string) => `비싼 모델(guard.expensive_models) 응답 ${n}회: ${models}`,
			fix: "제안: 이 세션/워커의 모델 경로(역할·폴백 체인·agentModelOverrides) 확인",
		},
		fallback: {
			kind: "폴백 모델",
			what: (intended: string, models: string, n: number) => `의도한 ${intended}이 아닌 ${models}로 ${n}턴`,
			amount: (n: number) => `${n}턴`,
			fix: "제안: 한도가 풀린 뒤에도 폴백에 머무는지 확인(retry.fallbackRevertPolicy) - 의도한 모델 복원",
		},
		loop: {
			kind: "반복 호출",
			what: (n: number) => `같은 도구 호출 연속 ${n}회`,
			fix: (save: string) => `제안: 같은 호출로 폴링하는 대신 wait/monitor로 대기 - 예상 절감 ~${save}, 결과 동일`,
		},
		worker: {
			kind: "대형 워커",
			what: (tok: string, turns: number, c: number, max: string) => `${tok} tok, ${turns}턴, 압축 ${c}회, 최대 컨텍스트 ${max}`,
			fix: "제안: 브리프를 독립 단계(조사 -> 구현 -> 검증)로 나눠 별도 워커로 - 모델·검증은 그대로",
		},
		spike: {
			kind: "급증",
			what: (x: string) => `합계가 7일 중앙값의 ${x}배`,
			amount: (tok: string, cost: string, medTok: string, medCost: string) => `${tok} tok (${cost}) vs 중앙값 ${medTok} (${medCost})`,
			evidence: (top: string) => `상위: ${top}`,
		},
		row: (label: string, start: string, turns: number, tok: string, cost: string, cr: string, cw: string, busts: number, explained: string, bigNew: string, wakes: number, warm: number, ttsr: number, err: number, max: string, comp: number) =>
			`- ${label}: 시작 ${start}, ${turns}턴, ${tok} tok, ${cost}, 캐시 읽기 ${cr}, 쓰기 ${cw}, 깨짐 ${busts}, 설명된 큰 쓰기 ${explained}${bigNew}, 헛깨움 ${wakes}, 캐시 워밍 ${warm}, TTSR ${ttsr}, 에러 ${err}, 최대 컨텍스트 ${max}, 압축 ${comp}`,
		newContent: (n: number) => ` 새내용x${n}`,
		day: (d: Day) => `- ${d.date}: ${M(d.tokens)} tok, ${usd(d.cost)}, 캐시 쓰기 ${M(d.cacheWrite)}, 세션 ${d.sessions}, 경고 ${d.flags}`,
		basis: `기준: 캐시 깨짐 = 미캐시 입력(캐시 쓰기+input) >${K(BUST_UNCACHED)}이면서 캐시 읽기가 직전 컨텍스트의 80% 미만이고, 직전에 압축/모델·thinking 변경/TTL(1h, 5m) 초과 공백이 없음. 헛깨움 = 사용자 입력 없이 알림만으로 시작된 턴이 도구 호출 없이 출력 ${IDLE_OUT} tok 이하로 끝남. 워커 >${M(SUB_NOTE)} 참고, >${M(SUB_FLAG)} 경고.`,
		words: { orchestrator: "오케스트레이터", lane: "레인", worker: "워커" },
		summary: (from: string, to: string, sessions: number, tok: string, cost: string, flags: number) => `토큰 점검 (${from}~${to}): 세션 ${sessions}개, ${tok} tok ${cost}, 경고 ${flags}건`,
		report: "보고서",
	},
	en: {
		title: (d: string) => `# Token leak audit ${d}`,
		period: (from: string, to: string, hours: number, sessions: number, tok: string, cost: string, cw: string) => `Period: ${from} ~ ${to} (${hours}h) · ${sessions} session(s) · total ${tok} tok · ${cost} · cache writes ${cw}`,
		median: (text: string) => `7-day median: ${text}`,
		noHistory: "no history",
		note: "Everything here is report-only; nothing is applied. \"Suggestion\" lines carry no performance trade-off; candidates that do are listed separately as \"Hold\".",
		heading: (flags: number, notes: number) => `## ${flags} warning(s) / ${notes} note(s)`,
		flag: "Warning",
		info: "Note",
		evidence: "Evidence",
		perSession: "## Per session (by tokens)",
		recent: "## Recent history",
		all: "all",
		bust: {
			kind: "Cache bust",
			what: (n: number) => `cache busted ${n}x (not a compaction, model change or TTL gap)`,
			amount: (tok: string, cost: string) => `${tok} tok re-sent uncached, ${cost}`,
			line: (t: string, n: string, r: string, p: string, ev: string) => `${t} new ${n}/read ${r} (previous ${p}) <- ${ev || "no events: tool list / system prompt change suspected"}`,
			fix: (top: string, save: string) => `Suggestion: check whether the events injected just before (${top || "none"}) change the front of the prompt and pin them - saves ~${save}; context and model stay the same`,
		},
		wake: {
			kind: "Idle wakes",
			what: (n: number) => `${n} turn(s) woke with nothing to do`,
			fix: (save: string) => `Suggestion: filter notifications that need no reaction (monitor lines, duplicate completion notices) at the source so they do not wake the session - saves ~${save}; events that give real work are unchanged`,
			times: (k: string, n: number, cost: string) => `${k} ${n}x ${cost}`,
		},
		ttsr: {
			kind: "TTSR interventions",
			what: (n: number) => `stream rules (TTSR) interrupted the reply and forced a retry ${n} times`,
			amount: (n: number) => `${n}x`,
			fix: "Suggestion: find the repeating rule in the session file's ttsr_injection entries; move a rule that fires every time into the instructions or turn it off with ttsr.disabledRules - the rule's intent is kept",
		},
		err: {
			kind: "Error retries",
			what: (turns: number, streak: number, codes: string) => `${turns} error turn(s), longest streak ${streak} (${codes})`,
			amount: "mostly 0 tokens, wasted waiting and retrying",
			evidence: (n: number) => `includes ${n} compaction failure(s)`,
			fix: "Suggestion: pause on 429 until the reset and check the retry cap (retry.maxRetries) - no effect on results",
		},
		big: {
			kind: "Large context",
			what: (limit: string, n: number, max: string) => `context >${limit} for ${n} turns in a row without compaction (max ${max})`,
			amount: (tok: string, cost: string) => `${tok} tok, ${cost} in those turns`,
			evidence: (c: number, e: number) => `${c} compaction(s), ${e} compaction failure(s)`,
			fix: "Suggestion: fix the cause of the compaction failure so the configured auto-compaction runs again - restores intended behaviour",
			hold: "Hold (trade-off): lowering the compaction threshold cuts tokens but also the working context",
		},
		dear: {
			kind: "Expensive model",
			what: (n: number, models: string) => `${n} repl${n === 1 ? "y" : "ies"} on an expensive model (guard.expensive_models): ${models}`,
			fix: "Suggestion: check the model path of this session or worker (roles, fallback chain, agentModelOverrides)",
		},
		fallback: {
			kind: "Fallback model",
			what: (intended: string, models: string, n: number) => `${n} turn(s) on ${models} instead of the intended ${intended}`,
			amount: (n: number) => `${n} turn(s)`,
			fix: "Suggestion: check whether the session stays on the fallback after the limit reset (retry.fallbackRevertPolicy) and restore the intended model",
		},
		loop: {
			kind: "Repeated call",
			what: (n: number) => `the same tool call ${n} times in a row`,
			fix: (save: string) => `Suggestion: wait with wait/monitor instead of polling with the same call - saves ~${save}, same result`,
		},
		worker: {
			kind: "Big worker",
			what: (tok: string, turns: number, c: number, max: string) => `${tok} tok, ${turns} turns, ${c} compaction(s), max context ${max}`,
			fix: "Suggestion: split the brief into independent steps (research -> implement -> verify) as separate workers - same model, same verification",
		},
		spike: {
			kind: "Spike",
			what: (x: string) => `total is ${x}x the 7-day median`,
			amount: (tok: string, cost: string, medTok: string, medCost: string) => `${tok} tok (${cost}) vs median ${medTok} (${medCost})`,
			evidence: (top: string) => `top: ${top}`,
		},
		row: (label: string, start: string, turns: number, tok: string, cost: string, cr: string, cw: string, busts: number, explained: string, bigNew: string, wakes: number, warm: number, ttsr: number, err: number, max: string, comp: number) =>
			`- ${label}: start ${start}, ${turns} turns, ${tok} tok, ${cost}, cache read ${cr}, write ${cw}, busts ${busts}, explained big writes ${explained}${bigNew}, idle wakes ${wakes}, warmings ${warm}, TTSR ${ttsr}, errors ${err}, max context ${max}, compactions ${comp}`,
		newContent: (n: number) => ` new-content x${n}`,
		day: (d: Day) => `- ${d.date}: ${M(d.tokens)} tok, ${usd(d.cost)}, cache writes ${M(d.cacheWrite)}, ${d.sessions} session(s), ${d.flags} warning(s)`,
		basis: `Basis: cache bust = uncached input (cache write + input) >${K(BUST_UNCACHED)} while cache read is under 80% of the previous context and no compaction, model/thinking change or TTL (1h, 5m) gap came right before. Idle wake = a turn started by a notification alone (no user input) that ended without tool calls and at most ${IDLE_OUT} output tokens. Workers >${M(SUB_NOTE)} are a note, >${M(SUB_FLAG)} a warning.`,
		words: { orchestrator: "orchestrator", lane: "lane", worker: "worker" },
		summary: (from: string, to: string, sessions: number, tok: string, cost: string, flags: number) => `Token audit (${from}~${to}): ${sessions} session(s), ${tok} tok ${cost}, ${flags} warning(s)`,
		report: "Report",
	},
};
type Messages = typeof LANG.en;

function auditLanguage(): "ko" | "en" {
	try {
		const code = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8")).identity?.language;
		if (typeof code === "string" && code.trim()) return baseLanguage(code) === "ko" ? "ko" : "en";
	} catch {}
	return systemLanguage() === "ko" ? "ko" : "en";
}

const sameModel = (a: string, b: string) => {
	const x = a.split("/").pop() ?? a;
	const y = b.split("/").pop() ?? b;
	return x.includes(y) || y.includes(x);
};

// Model selectors an `expensive_models` entry can name; a ":thinking" entry names an effort level, not a model.
const expensiveMatcher = (entries: readonly string[]) => {
	const names = entries.filter(e => !e.startsWith(":")).map(e => e.toLowerCase());
	return (model: string) => names.some(n => model.toLowerCase().includes(n));
};

function analyze(src: Src, since: number, isExpensive: (model: string) => boolean): Stats {
	const s: Stats = {
		src, intended: src.requested, turns: 0, tokens: 0, cost: 0, cw: 0, cr: 0, out: 0, maxCtx: 0, compactions: 0, busts: [], explained: {}, bigNew: 0,
		wakes: {}, warmings: 0, ttsr: 0, errTurns: 0, maxErrStreak: 0, errCodes: {}, compactErr: 0, maxBigStreak: 0, bigTokens: 0, bigCost: 0,
		fbTurns: 0, fbModels: new Set(), expensive: 0, expensiveCost: 0, expensiveModels: new Set(), maxToolStreak: 0, maxToolDesc: "", loopTokens: 0, loopCost: 0, readRate: 0,
	};
	let events: string[] = [];
	let compacted = false, modelChanged = false, thinkChanged = false, user = false;
	let prev: { ts: number; ctx: number; ttlMin: number } | undefined;
	let prevStop = "stop";
	let errStreak = 0, bigStreak = 0, toolHash = "", toolStreak = 0, readTok = 0, readCost = 0;
	let omoLong = false;
	const text = readFileSync(src.file, "utf8");
	for (const line of text.split("\n")) {
		if (line.length < 20) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const ts = Date.parse(entry.timestamp ?? "");
		if (entry.type === "compaction") {
			compacted = true;
			bigStreak = 0;
			if (!(ts < since)) s.compactions++;
			continue;
		}
		if (entry.type === "model_change") {
			modelChanged = true;
			if (entry.reason !== "fallback" && entry.provider && entry.modelId) s.intended = `${entry.provider}/${entry.modelId}`;
			continue;
		}
		if (entry.type === "ttsr_injection") {
			if (!(ts < since)) s.ttsr++;
			continue;
		}
		if (entry.type === "thinking_level_change") {
			thinkChanged = true;
			continue;
		}
		if (entry.type === "custom" || entry.type === "custom_message") {
			const kind = String(entry.customType ?? entry.message?.customType ?? "custom");
			events.push(kind);
			if (/warm|keepalive/i.test(kind)) s.warmings++;
			continue;
		}
		if (entry.type !== "message") continue;
		const m = entry.message ?? {};
		if (m.role === "user") {
			user = true;
			continue;
		}
		if (m.role === "custom") {
			events.push(String(m.customType ?? "custom"));
			continue;
		}
		if (m.role !== "assistant") continue;
		const inWindow = ts >= since;
		const u = m.usage ?? {};
		const tokens = u.totalTokens ?? 0;
		const cost = u.cost?.total ?? 0;
		const cw = u.cacheWrite ?? 0;
		const cr = u.cacheRead ?? 0;
		const ctx = (u.input ?? 0) + cr + cw;
		const uncached = cw + (u.input ?? 0);
		const model = `${m.provider}/${m.model}`;
		const calls = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c?.type === "toolCall");
		const newTurn = prevStop !== "toolUse";
		if (m.stopReason === "error") {
			if (inWindow) {
				s.errTurns++;
				errStreak++;
				s.maxErrStreak = Math.max(s.maxErrStreak, errStreak);
				const code = String(String(m.errorMessage ?? "").match(/\b([45]\d\d)\b/)?.[1] ?? "other");
				s.errCodes[code] = (s.errCodes[code] ?? 0) + 1;
				if (/compaction/i.test(m.errorMessage ?? "")) s.compactErr++;
			}
			prevStop = "error";
			if (!tokens) continue;
		} else errStreak = 0;
		if (!tokens) {
			prevStop = m.stopReason ?? "stop";
			continue;
		}
		if (inWindow) {
			s.start ??= ts;
			s.turns++;
			s.tokens += tokens;
			s.cost += cost;
			s.cw += cw;
			s.cr += cr;
			s.out += u.output ?? 0;
			s.maxCtx = Math.max(s.maxCtx, ctx);
			if (cr) {
				readTok += cr;
				readCost += u.cost?.cacheRead ?? 0;
			}
			if (isExpensive(model)) {
				s.expensive++;
				s.expensiveCost += cost;
				s.expensiveModels.add(model);
			}
			if (uncached > BUST_UNCACHED && prev) {
				const gapMin = (ts - prev.ts) / 60e3;
				const why = compacted ? "compaction" : modelChanged ? "model change" : thinkChanged ? "thinking change" : gapMin > prev.ttlMin ? `gap>${prev.ttlMin}m` : "";
				if (why) s.explained[why] = (s.explained[why] ?? 0) + 1;
				else if (cr < prev.ctx * 0.8) s.busts.push({ ts, uncached, cr, prevCtx: prev.ctx, cost: (u.cost?.cacheWrite ?? 0) + (u.cost?.input ?? 0), events: [...new Set(events)] });
				else s.bigNew++;
			}
			// OmO writes bookkeeping entries around every turn; only its wake events start a turn without the owner.
			const wakeBy = src.runtime === "omo" ? events.filter(e => OMO_WAKE.has(e)) : events;
			if (newTurn && !user && wakeBy.length) {
				if (!calls.length && (u.output ?? 0) <= IDLE_OUT) {
					const key = wakeBy.at(-1) ?? "custom";
					const w = (s.wakes[key] ??= { n: 0, tokens: 0, cost: 0 });
					w.n++;
					w.tokens += tokens;
					w.cost += cost;
				}
			}
			if (ctx > BIG_CTX) {
				bigStreak++;
				s.bigTokens += tokens;
				s.bigCost += cost;
				s.maxBigStreak = Math.max(s.maxBigStreak, bigStreak);
			} else bigStreak = 0;
			if (s.intended && !sameModel(model, s.intended)) {
				s.fbTurns++;
				s.fbModels.add(model);
			}
			for (const call of calls) {
				const hash = `${call.name}${JSON.stringify(call.arguments ?? {}).slice(0, 4000)}`;
				if (hash === toolHash) {
					toolStreak++;
					if (toolStreak >= 3) {
						s.loopTokens += tokens / calls.length;
						s.loopCost += cost / calls.length;
					}
					if (toolStreak > s.maxToolStreak) {
						s.maxToolStreak = toolStreak;
						s.maxToolDesc = `${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 90)}`;
					}
				} else {
					toolHash = hash;
					toolStreak = 1;
				}
			}
		}
		s.intended ??= model;
		// omp reports the cache TTL in cttl. OmO's record has no TTL (senpi's claude-sdk-oauth usage drops cacheWrite1h), so
		// its TTL is what the session showed: a cache read after a gap over 5 minutes means the 1h cache (PI_CACHE_RETENTION=long).
		if (src.runtime === "omo" && prev && ts - prev.ts > 5 * 60e3 && cr >= prev.ctx * 0.8) omoLong = true;
		const ttlMin = u.cttl?.ephemeral1h ? 60 : u.cttl?.ephemeral5m ? 5 : src.runtime === "omo" ? (omoLong ? 60 : 5) : (prev?.ttlMin ?? 5);
		prev = { ts, ctx, ttlMin };
		prevStop = m.stopReason ?? "stop";
		events = [];
		compacted = modelChanged = thinkChanged = user = false;
	}
	s.readRate = readTok ? readCost / readTok : 0;
	return s;
}

export function findingsOf(results: Stats[], t: Messages, spike?: Finding): Finding[] {
	const findings: Finding[] = [];
	for (const s of results) {
		const who = s.src.label;
		if (s.busts.length) {
			const uncached = s.busts.reduce((a, b) => a + b.uncached, 0);
			const cost = s.busts.reduce((a, b) => a + b.cost, 0);
			const save = s.busts.reduce((a, b) => a + Math.max(0, b.cost - b.uncached * s.readRate), 0);
			const top = Object.entries(s.busts.flatMap(b => b.events).reduce<Record<string, number>>((acc, e) => ((acc[e] = (acc[e] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e);
			findings.push({
				flag: s.busts.length >= 3 || uncached > 1e6, kind: t.bust.kind, who,
				what: t.bust.what(s.busts.length), amount: t.bust.amount(M(uncached), usd(cost)), save,
				evidence: s.busts.slice(0, 6).map(b => t.bust.line(localTime(b.ts), K(b.uncached), K(b.cr), K(b.prevCtx), b.events.join(", "))).join("; "),
				fix: t.bust.fix(top.join(", "), usd(save)),
			});
		}
		const wakes = Object.entries(s.wakes);
		const wakeN = wakes.reduce((a, [, w]) => a + w.n, 0);
		if (wakeN) {
			const tokens = wakes.reduce((a, [, w]) => a + w.tokens, 0);
			const cost = wakes.reduce((a, [, w]) => a + w.cost, 0);
			findings.push({
				flag: wakeN >= 10 || cost >= 5, kind: t.wake.kind, who, what: t.wake.what(wakeN), amount: `${M(tokens)} tok, ${usd(cost)}`, save: cost,
				evidence: wakes.sort((a, b) => b[1].cost - a[1].cost).map(([k, w]) => t.wake.times(k, w.n, usd(w.cost))).join(", "),
				fix: t.wake.fix(usd(cost)),
			});
		}
		if (s.ttsr >= 10) {
			findings.push({ flag: s.ttsr >= 30, kind: t.ttsr.kind, who, what: t.ttsr.what(s.ttsr), amount: t.ttsr.amount(s.ttsr), save: 0, fix: t.ttsr.fix });
		}
		if (s.maxErrStreak >= 3) {
			findings.push({
				flag: s.maxErrStreak >= 5, kind: t.err.kind, who, what: t.err.what(s.errTurns, s.maxErrStreak, Object.entries(s.errCodes).map(([k, v]) => `${k}x${v}`).join(", ")),
				amount: t.err.amount, save: 0, evidence: s.compactErr ? t.err.evidence(s.compactErr) : undefined, fix: t.err.fix,
			});
		}
		if (s.maxBigStreak >= 10) {
			findings.push({
				flag: s.compactErr > 0, kind: t.big.kind, who, what: t.big.what(K(BIG_CTX), s.maxBigStreak, K(s.maxCtx)),
				amount: t.big.amount(M(s.bigTokens), usd(s.bigCost)), save: 0, evidence: t.big.evidence(s.compactions, s.compactErr),
				fix: s.compactErr ? t.big.fix : undefined, hold: s.compactErr ? undefined : t.big.hold,
			});
		}
		if (s.expensive) {
			findings.push({ flag: true, kind: t.dear.kind, who, what: t.dear.what(s.expensive, [...s.expensiveModels].join(", ")), amount: usd(s.expensiveCost), save: s.expensiveCost, fix: t.dear.fix });
		}
		if (s.fbTurns >= 5) {
			findings.push({ flag: s.fbTurns >= 20, kind: t.fallback.kind, who, what: t.fallback.what(String(s.intended), [...s.fbModels].join(", "), s.fbTurns), amount: t.fallback.amount(s.fbTurns), save: 0, fix: t.fallback.fix });
		}
		if (s.maxToolStreak >= 5) {
			findings.push({
				flag: true, kind: t.loop.kind, who, what: t.loop.what(s.maxToolStreak), amount: `~${M(s.loopTokens)} tok, ${usd(s.loopCost)}`, save: s.loopCost, evidence: s.maxToolDesc,
				fix: t.loop.fix(usd(s.loopCost)),
			});
		}
		if (s.src.child && s.tokens > SUB_NOTE) {
			findings.push({ flag: s.tokens > SUB_FLAG, kind: t.worker.kind, who, what: t.worker.what(M(s.tokens), s.turns, s.compactions, K(s.maxCtx)), amount: usd(s.cost), save: 0, fix: t.worker.fix });
		}
	}
	if (spike) findings.push(spike);
	return findings;
}

interface AuditOptions {
	hours?: number;
	// Session trees to read (default ~/.omo/agent/sessions and ~/.omp/agent/sessions plus OmO's task stores); given
	// roots skip the task stores. sessionsDir is one omp tree.
	roots?: { dir: string; runtime: Runtime }[];
	sessionsDir?: string;
	// `guard.expensive_models` while the owner rule is on; empty = no expensive-model finding.
	expensiveModels?: readonly string[];
	// Where the report goes (default <DOTZ_DIR>/logs); nothing is written when false.
	reportDir?: string | false;
	lang?: "ko" | "en";
	now?: number;
}
export interface AuditResult {
	text: string;
	flags: number;
	notes: number;
	sessions: number;
	tokens: number;
	cost: number;
	report?: string;
}

export async function runTokenAudit(opts: AuditOptions = {}): Promise<AuditResult> {
	const HOME = homedir();
	const hours = opts.hours && opts.hours > 0 ? opts.hours : 24;
	const now = opts.now ?? Date.now();
	const since = now - hours * 3600e3;
	const t = LANG[opts.lang ?? auditLanguage()];
	const isExpensive = expensiveMatcher(opts.expensiveModels ?? []);

	const roots = opts.roots ?? (opts.sessionsDir ? [{ dir: opts.sessionsDir, runtime: "omp" as const }] : undefined);
	const srcs: Src[] = collectSessions(since, { home: HOME, dataDir: dataDir(), roots, omoStores: roots ? false : undefined, words: t.words });

	const results: Stats[] = [];
	for (const src of srcs) {
		await nextTick();
		try {
			const s = analyze(src, since, isExpensive);
			if (s.turns + s.errTurns > 0) results.push(s);
		} catch {
			continue;
		}
	}

	const total = results.reduce((a, s) => a + s.tokens, 0);
	const totalCost = results.reduce((a, s) => a + s.cost, 0);
	const totalCw = results.reduce((a, s) => a + s.cw, 0);
	const today = localDate(now);
	let history: Day[] = [];
	try {
		history = JSON.parse(readFileSync(join(dataDir(), "token-audit.json"), "utf8")).days ?? [];
	} catch {
		history = [];
	}
	const prior = history.filter(d => d.date !== today).slice(-7);
	const median = (xs: number[]) => {
		const a = [...xs].sort((x, y) => x - y);
		return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
	};
	const medTok = median(prior.map(d => d.tokens));
	const medCost = median(prior.map(d => d.cost));
	let spike: Finding | undefined;
	if (prior.length >= 3 && (total > 2 * medTok || totalCost > 2 * medCost)) {
		const top = [...results].sort((a, b) => b.cost - a.cost).slice(0, 3).map(s => `${s.src.label} ${M(s.tokens)}`).join(", ");
		spike = { flag: true, kind: t.spike.kind, who: t.all, what: t.spike.what((total / Math.max(1, medTok)).toFixed(1)), amount: t.spike.amount(M(total), usd(totalCost), M(medTok), usd(medCost)), save: 0, evidence: t.spike.evidence(top) };
	}
	const findings = findingsOf(results, t, spike);
	const flags = findings.filter(f => f.flag);

	const ordered = [...findings].sort((a, b) => Number(b.flag) - Number(a.flag) || b.save - a.save);
	const sorted = [...results].sort((a, b) => b.tokens - a.tokens);
	const report = [
		t.title(today),
		"",
		t.period(localTime(since), localTime(now), hours, results.length, M(total), usd(totalCost), M(totalCw)),
		t.median(prior.length ? `${M(medTok)} tok / ${usd(medCost)} (${prior.length}d)` : t.noHistory),
		"",
		t.note,
		"",
		t.heading(flags.length, findings.length - flags.length),
		...ordered.flatMap(f => [
			"",
			`### ${f.flag ? t.flag : t.info} [${f.kind}] ${f.who}`,
			`- ${f.what} - ${f.amount}`,
			...(f.evidence ? [`- ${t.evidence}: ${f.evidence}`] : []),
			...(f.fix ? [`- ${f.fix}`] : []),
			...(f.hold ? [`- ${f.hold}`] : []),
		]),
		"",
		t.perSession,
		"",
		...sorted.map(s =>
			t.row(
				s.src.label, s.start ? localTime(s.start) : "-", s.turns, M(s.tokens), usd(s.cost), M(s.cr), M(s.cw), s.busts.length,
				Object.entries(s.explained).map(([k, v]) => `${k}x${v}`).join(" ") || "-", s.bigNew ? t.newContent(s.bigNew) : "",
				Object.values(s.wakes).reduce((a, w) => a + w.n, 0), s.warmings, s.ttsr, s.errTurns, K(s.maxCtx), s.compactions,
			),
		),
		...(history.length ? ["", t.recent, "", ...history.map(t.day)] : []),
		"",
		t.basis,
	].join("\n");

	let reportPath: string | undefined;
	if (opts.reportDir !== false) {
		const dir = opts.reportDir ?? join(dataDir(), "logs");
		try {
			mkdirSync(dir, { recursive: true });
			reportPath = join(dir, `token-audit-session-${today.replace(/-/g, "")}.md`);
			writeFileSync(reportPath, `${report}\n`);
		} catch {
			reportPath = undefined;
		}
	}

	const text = [
		t.summary(localTime(since), localTime(now), results.length, M(total), usd(totalCost), flags.length),
		...flags.sort((a, b) => b.save - a.save).slice(0, 4).map(f => `- ${f.kind} ${f.who}: ${f.amount}`),
		...(reportPath ? [`${t.report}: ${reportPath.replace(HOME, "~")}`] : []),
	].join("\n");
	return { text, flags: flags.length, notes: findings.length - flags.length, sessions: results.length, tokens: total, cost: Number(totalCost.toFixed(2)), report: reportPath };
}

if (import.meta.main) {
	const hours = Number(process.argv[2]) || 24;
	console.log((await runTokenAudit({ hours })).text);
}
