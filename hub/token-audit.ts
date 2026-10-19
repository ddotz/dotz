// Nightly token-leak audit, ported from the macmini 오모냥 token-audit.ts. Pure TS, no LLM calls, report only.
// Scans the omp session jsonl files (orchestrator, lane worktrees, task workers) active in the last 24h, writes the full
// report to ~/.dotz/logs/token-audit-YYYYMMDD.md (KST), keeps a 14-day history in ~/.dotz/token-audit.json, and posts ONE
// short Korean message to the alert channel only when something is flagged. Nothing is ever applied automatically.
// Config: `token_audit_at` ("HH:MM" local time, default "04:30", "off" disables). The reflection digest reads the result.
// usage: bun hub/token-audit.ts --dry [--hours N]    (--dry prints the alert instead of sending it; history is not recorded)
// Last stdout line: RESULT {...}
import type { Dirent } from "node:fs";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cfg, DATA_DIR, HOME, log, writeAtomic } from "./config.ts";
import { trackTimer } from "./shutdown.ts";

const SESSIONS = join(HOME, ".omp", "agent", "sessions");
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
	"캐시 깨짐": "MODE.md 'Lanes and workers' (한 태스크 ~250K 컨텍스트) · 'Restart and resume'",
	"헛깨움": "MODE.md 'Inputs' ([keepalive] 턴은 ok만) · 'Monitoring (dotz_watch)'",
	"에러 연속": "MODE.md 'Restart and resume'",
	"반복 호출": "MODE.md 'Lanes and workers' (Brief: 폴링 대신 blocking 대기 한 번)",
	"대형 컨텍스트": "MODE.md 'Lanes and workers' (한 태스크 ~250K 컨텍스트)",
	"대형 하위에이전트": "MODE.md 'Lanes and workers' (Brief: 단계별 워커, 후속은 새 워커)",
	"비싼 모델": "MODE.md 'Lanes and workers' (Budget: Fable·max/xhigh는 오너가 요청할 때만)",
};

const kstDate = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const kst = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const K = (n: number) => `${Math.round(n / 1e3)}K`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const tilde = (p: string) => p.replace(HOME, "~");
type Json = Record<string, any>; // omp session lines are external jsonl; fields are read defensively

type Src = { file: string; label: string; child: boolean };
type Day = { date: string; tokens: number; cost: number; cacheWrite: number; sessions: number; flags: number; kinds?: string[]; report?: string };

// omp names a session folder after the cwd: home-relative "-<path with / as ->", absolute "--<path>--".
function projectLabel(dir: string): string {
	const orch = `-${relative(HOME, DATA_DIR).replace(/\//g, "-")}`;
	if (dir === orch) return "오케스트레이터";
	const lane = dir.match(new RegExp(`^${orch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-lanes-(.+)-worktree$`));
	if (lane) return `레인 ${lane[1]}`;
	if (dir.startsWith("--")) return `/${dir.replace(/^--|--$/g, "").replace(/-/g, "/")}`;
	return `~/${dir.replace(/^-/, "")}`;
}

function collect(since: number): Src[] {
	const out: Src[] = [];
	const walk = (dir: string, depth: number) => {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (depth > 0) walk(p, depth - 1);
				continue;
			}
			if (!e.name.endsWith(".jsonl")) continue;
			try {
				if (statSync(p).mtimeMs < since) continue;
			} catch {
				continue;
			}
			const parts = relative(SESSIONS, p).split("/");
			const project = projectLabel(parts[0]);
			const child = parts.length >= 3;
			const id = e.name.match(/_([0-9a-f]{8})/)?.[1] ?? e.name.replace(/\.jsonl$/, "");
			out.push({ file: p, child, label: child ? `${project} 워커 ${e.name.replace(/\.jsonl$/, "")}` : `${project} ${id}` });
		}
	};
	walk(SESSIONS, 3);
	return out;
}

type Bust = { ts: number; uncached: number; cr: number; prevCtx: number; cost: number; events: string[] };
type Stats = {
	src: Src; start?: number; turns: number; tokens: number; cost: number; cw: number; cr: number; out: number; maxCtx: number; compactions: number;
	busts: Bust[]; explained: Record<string, number>; bigNew: number;
	wakes: Record<string, { n: number; tokens: number; cost: number }>; warmings: number;
	errTurns: number; maxErrStreak: number; errCodes: Record<string, number>; compactErr: number;
	maxBigStreak: number; bigTokens: number; bigCost: number;
	fbTurns: number; fbModels: Set<string>; intended?: string;
	fable: number; fableCost: number; effortTurns: number; effortCost: number; expensiveCost: number; efforts: Set<string>;
	maxToolStreak: number; maxToolDesc: string; loopTokens: number; loopCost: number; readRate: number;
};

const sameModel = (a: string, b: string) => {
	const x = a.split("/").pop() ?? a;
	const y = b.split("/").pop() ?? b;
	return x.includes(y) || y.includes(x);
};

function analyze(src: Src, since: number): Stats {
	const s: Stats = {
		src, turns: 0, tokens: 0, cost: 0, cw: 0, cr: 0, out: 0, maxCtx: 0, compactions: 0, busts: [], explained: {}, bigNew: 0, wakes: {}, warmings: 0,
		errTurns: 0, maxErrStreak: 0, errCodes: {}, compactErr: 0, maxBigStreak: 0, bigTokens: 0, bigCost: 0, fbTurns: 0, fbModels: new Set(),
		fable: 0, fableCost: 0, effortTurns: 0, effortCost: 0, expensiveCost: 0, efforts: new Set(), maxToolStreak: 0, maxToolDesc: "", loopTokens: 0, loopCost: 0, readRate: 0,
	};
	let events: string[] = [];
	let compacted = false, modelChanged = false, thinkChanged = false, user = false;
	let prev: { ts: number; ctx: number; ttlMin: number } | undefined;
	let prevStop = "stop";
	let errStreak = 0, bigStreak = 0, toolHash = "", toolStreak = 0, readTok = 0, readCost = 0;
	let level = "";
	for (const line of readFileSync(src.file, "utf8").split("\n")) {
		if (line.length < 20) continue;
		const head = line.slice(0, 400);
		const ts = Date.parse(head.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
		if (head.startsWith('{"type":"message"')) {
			if (head.includes('"role":"toolResult"')) continue;
			if (head.includes('"role":"user"')) {
				user = true;
				continue;
			}
			if (head.includes('"role":"custom"')) {
				events.push(head.match(/"customType":"([^"]+)"/)?.[1] ?? "custom");
				continue;
			}
			if (!head.includes('"role":"assistant"')) continue;
		} else if (head.startsWith('{"type":"compaction"')) {
			compacted = true;
			bigStreak = 0;
			if (!(ts < since)) s.compactions++;
			continue;
		} else if (head.startsWith('{"type":"model_change"')) {
			modelChanged = true;
			try {
				const o = JSON.parse(line);
				const model = o.model ?? (o.provider && o.modelId ? `${o.provider}/${o.modelId}` : "");
				if (model && o.reason !== "fallback" && !o.resolvedModelIsFallback) s.intended = model;
			} catch {}
			continue;
		} else if (head.startsWith('{"type":"thinking_level_change"')) {
			thinkChanged = true;
			level = head.match(/"thinkingLevel":"([^"]+)"/)?.[1] ?? level;
			continue;
		} else {
			const kind = head.match(/"customType":"([^"]+)"/)?.[1];
			if (kind && (head.startsWith('{"type":"custom"') || head.startsWith('{"type":"custom_message"'))) {
				events.push(kind);
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
			if (/fable/i.test(model)) {
				s.fable++;
				s.fableCost += cost;
			}
			if (/^(max|xhigh)$/i.test(level)) {
				s.effortTurns++;
				s.effortCost += cost;
				s.efforts.add(`${m.model ?? "?"}:${level}`);
			}
			if (/fable/i.test(model) || /^(max|xhigh)$/i.test(level)) s.expensiveCost += cost; // once per turn even when both apply
			// cache bust: a big uncached write that did not reuse the prefix, with no compaction / model change / TTL gap before it
			if (uncached > BUST_UNCACHED && prev) {
				const gapMin = (ts - prev.ts) / 60e3;
				const why = compacted ? "compaction" : modelChanged ? "model change" : thinkChanged ? "thinking change" : gapMin > prev.ttlMin ? `gap>${prev.ttlMin}m` : "";
				if (why) s.explained[why] = (s.explained[why] ?? 0) + 1;
				else if (cr < prev.ctx * 0.8) s.busts.push({ ts, uncached, cr, prevCtx: prev.ctx, cost: (u.cost?.cacheWrite ?? 0) + (u.cost?.input ?? 0), events: [...new Set(events)] });
				else s.bigNew++; // prefix reused; the write is genuinely new content
			}
			// idle wake: a new turn started by notifications only, ending with no tool call and a tiny reply
			if (newTurn && !user && events.length && !calls.length && (u.output ?? 0) <= IDLE_OUT) {
				const key = events.at(-1) ?? "custom";
				const w = (s.wakes[key] ??= { n: 0, tokens: 0, cost: 0 });
				w.n++;
				w.tokens += tokens;
				w.cost += cost;
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
		const ttlMin = u.cttl?.ephemeral1h ? 60 : u.cttl?.ephemeral5m ? 5 : (prev?.ttlMin ?? 5);
		prev = { ts, ctx, ttlMin };
		prevStop = m.stopReason ?? "stop";
		events = [];
		compacted = modelChanged = thinkChanged = user = false;
	}
	s.readRate = readTok ? readCost / readTok : 0;
	return s;
}

type Finding = { flag: boolean; kind: string; who: string; what: string; amount: string; save: number; evidence?: string; fix?: string; hold?: string; tip?: string; recur?: number };

function findingsOf(results: Stats[]): Finding[] {
	const F: Finding[] = [];
	for (const s of results) {
		const who = s.src.label;
		if (s.busts.length) {
			const uncached = s.busts.reduce((a, b) => a + b.uncached, 0);
			const cost = s.busts.reduce((a, b) => a + b.cost, 0);
			const save = s.busts.reduce((a, b) => a + Math.max(0, b.cost - b.uncached * s.readRate), 0);
			const count: Record<string, number> = {};
			for (const e of s.busts.flatMap(b => b.events)) count[e] = (count[e] ?? 0) + 1;
			const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e);
			F.push({
				flag: s.busts.length >= 3 || uncached > 1e6, kind: "캐시 깨짐", who, tip: "직전 주입 이벤트 확인",
				what: `캐시 깨짐 ${s.busts.length}회 (압축/모델 변경/TTL 공백 아님)`, amount: `미캐시 재입력 ${M(uncached)} tok, ${usd(cost)}`, save,
				evidence: s.busts.slice(0, 6).map(b => `${kst(b.ts)} 새로 ${K(b.uncached)}/읽기 ${K(b.cr)} (직전 ${K(b.prevCtx)}) <- ${b.events.join(", ") || "이벤트 없음: 도구 목록/시스템 프롬프트 변경 의심"}`).join("; "),
				fix: `제안: 직전 주입 이벤트(${top.join(", ") || "없음"})가 프롬프트 앞부분을 바꾸는지 확인해 고정 - 예상 절감 ~${usd(save)} (같은 토큰을 쓰기 대신 읽기로). 컨텍스트·모델은 그대로라 성능 영향 없음`,
			});
		}
		const wakes = Object.entries(s.wakes);
		const wakeN = wakes.reduce((a, [, w]) => a + w.n, 0);
		if (wakeN) {
			const tokens = wakes.reduce((a, [, w]) => a + w.tokens, 0);
			const cost = wakes.reduce((a, [, w]) => a + w.cost, 0);
			F.push({
				flag: wakeN >= 10 || cost >= 5, kind: "헛깨움", who, tip: "알림을 소스에서 거르기", what: `할 일 없이 깨어난 턴 ${wakeN}회`, amount: `${M(tokens)} tok, ${usd(cost)}`, save: cost,
				evidence: wakes.sort((a, b) => b[1].cost - a[1].cost).map(([k, w]) => `${k} ${w.n}회 ${usd(w.cost)}`).join(", "),
				fix: `제안: 반응할 필요 없는 알림(감시 라인·완료 알림 중복)을 소스에서 걸러 세션을 깨우지 않게 - 예상 절감 ~${usd(cost)}. 실제 일을 시키는 이벤트는 그대로라 성능 영향 없음`,
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
		if (s.fable || s.effortTurns) {
			const parts = [s.fable ? `Fable 응답 ${s.fable}회 (${usd(s.fableCost)})` : "", s.effortTurns ? `max/xhigh 생각 수준 ${s.effortTurns}턴 (${usd(s.effortCost)}; ${[...s.efforts].join(", ")})` : ""].filter(Boolean);
			const cost = s.expensiveCost;
			F.push({
				flag: s.fable > 0 || s.effortTurns >= EFFORT_FLAG_TURNS, kind: "비싼 모델", who, tip: "오너가 요청한 것인지 확인",
				what: parts.join(" + "), amount: usd(cost), save: 0,
				evidence: "규칙: Fable·max/xhigh는 오너가 요청할 때만 (오너가 요청한 세션이면 무시)",
				fix: "제안: 이 세션/워커의 모델 경로(역할·폴백 체인·레인 모델 선택)에서 비싼 모델이 기본으로 새어 들어오는지 확인",
			});
		}
		if (s.fbTurns >= 5) {
			F.push({
				flag: s.fbTurns >= 20, kind: "폴백 모델", who, tip: "원래 모델 복귀 확인", what: `의도한 ${s.intended}이 아닌 ${[...s.fbModels].join(", ")}로 ${s.fbTurns}턴`, amount: `${s.fbTurns}턴`, save: 0,
				fix: "제안: 한도가 풀린 뒤에도 폴백에 머무는지 확인 - 의도한 모델 복원",
			});
		}
		if (s.maxToolStreak >= 5) {
			F.push({
				flag: true, kind: "반복 호출", who, tip: "폴링 대신 한 번 대기", what: `같은 도구 호출 연속 ${s.maxToolStreak}회`, amount: `~${M(s.loopTokens)} tok, ${usd(s.loopCost)}`, save: s.loopCost, evidence: s.maxToolDesc,
				fix: `제안: 같은 호출로 폴링하는 대신 wait/monitor로 대기 - 예상 절감 ~${usd(s.loopCost)}, 결과 동일`,
			});
		}
		if (s.src.child && s.tokens > SUB_NOTE) {
			F.push({
				flag: s.tokens > SUB_FLAG, kind: "대형 하위에이전트", who, tip: "브리프를 단계별 워커로 분할",
				what: `${M(s.tokens)} tok, ${s.turns}턴, 압축 ${s.compactions}회, 최대 컨텍스트 ${K(s.maxCtx)}`, amount: usd(s.cost), save: 0,
				fix: "제안: 브리프를 독립 단계(조사 -> 구현 -> 검증)로 나눠 별도 워커로, 후속은 새 워커로 - 모델·검증은 그대로",
			});
		}
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

export type AuditResult = { flags: number; notes: number; sessions: number; tokens: number; cost: number; report: string; alert?: string; summary: string };

export function auditEnabled(): boolean {
	return String((cfg as { token_audit_at?: string }).token_audit_at ?? "04:30") !== "off";
}

// One-line audit summary for the nightly reflection digest: the latest recorded audit (today or yesterday, KST).
export function auditSummaryLine(now = Date.now()): string | undefined {
	if (!auditEnabled()) return undefined;
	const last = readHistory().at(-1);
	if (!last?.report || ![kstDate(now), kstDate(now - 86400e3)].includes(last.date)) return undefined;
	return `token audit ${last.date}: ${last.flags} warning(s)${last.kinds?.length ? ` (${last.kinds.join(", ")})` : ""}, ${last.sessions} sessions, ${M(last.tokens)} tokens ${usd(last.cost)}, report ${tilde(last.report)}`;
}

export function runAudit(opts: { hours?: number; dry?: boolean } = {}): AuditResult {
	const t0 = Date.now();
	const now = Date.now();
	const hours = opts.hours && opts.hours > 0 ? opts.hours : 24;
	const since = now - hours * 3600e3;
	const results = collect(since).flatMap(src => {
		try {
			const s = analyze(src, since);
			return s.turns + s.errTurns > 0 ? [s] : [];
		} catch (error) {
			console.error(`skip ${src.file}: ${error}`);
			return [];
		}
	});
	const findings = findingsOf(results);
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
		history = [...history.filter(d => d.date !== today), { date: today, tokens: total, cost: totalCost, cacheWrite: totalCw, sessions: results.length, flags: flags.length, kinds, report: reportPath }].slice(-14);
		writeAtomic(HISTORY, `${JSON.stringify({ updated: new Date(now).toISOString(), days: history }, null, 1)}\n`);
	}
	const ordered = [...findings].sort((a, b) => Number(b.flag) - Number(a.flag) || b.save - a.save);
	const sorted = [...results].sort((a, b) => b.tokens - a.tokens);
	const report = [
		`# 토큰 누수 점검 ${today} (KST)`,
		"",
		`기간: ${kst(since)} ~ ${kst(now)} KST (${hours}h) · 세션 ${results.length}개 · 합계 ${M(total)} tok · ${usd(totalCost)} · 캐시 쓰기 ${M(totalCw)} · 분석 ${((Date.now() - t0) / 1000).toFixed(1)}s${opts.dry ? " · dry(기록 안 함)" : ""}`,
		`7일 중앙값: ${prior.length ? `${M(medTok)} tok / ${usd(medCost)} (${prior.length}일)` : "기록 없음"}`,
		"",
		"모든 항목은 보고만 합니다. 자동 적용 없음. \"제안\"은 성능 트레이드오프가 없는 것만, 트레이드오프가 있는 후보는 \"보류\"로 따로 표시합니다.",
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
		...sorted.map(s => `| ${s.src.label} | ${s.start ? kst(s.start) : "-"} | ${s.turns} | ${M(s.tokens)} | ${usd(s.cost)} | ${M(s.cr)} | ${M(s.cw)} | ${K(s.out)} | ${s.busts.length} | ${Object.entries(s.explained).map(([k, v]) => `${k}x${v}`).join(" ") || "-"}${s.bigNew ? ` 새내용x${s.bigNew}` : ""} | ${Object.values(s.wakes).reduce((a, w) => a + w.n, 0)} | ${s.warmings} | ${s.errTurns} | ${K(s.maxCtx)} | ${s.compactions} |`),
		"",
		"## 최근 기록",
		"",
		...(opts.dry ? ["(dry 실행: 기록 없음)"] : history.map(d => `- ${d.date}: ${M(d.tokens)} tok, ${usd(d.cost)}, 캐시 쓰기 ${M(d.cacheWrite)}, 세션 ${d.sessions}, 경고 ${d.flags}`)),
		"",
		`기준: 캐시 깨짐 = 미캐시 입력(캐시 쓰기+input) >${K(BUST_UNCACHED)}이면서 캐시 읽기가 직전 컨텍스트의 80% 미만이고, 직전에 압축/모델·thinking 변경/TTL(1h, 5m) 초과 공백이 없음. 헛깨움 = 사용자 입력 없이 알림만으로 시작된 턴이 도구 호출 없이 출력 ${IDLE_OUT} tok 이하로 끝남. 하위에이전트 >${M(SUB_NOTE)} 참고, >${M(SUB_FLAG)} 경고. 비싼 모델 = Fable 응답 또는 max/xhigh 생각 수준 ${EFFORT_FLAG_TURNS}턴 이상. 🔁 = 같은 클래스가 어제까지 연속으로 경고였음(기존 규칙은 MODE.md 섹션명으로 표기).`,
	].join("\n");
	mkdirSync(LOG_DIR, { recursive: true });
	writeFileSync(reportPath, `${report}\n`);
	const plain = (t: string) => t.replace(/ tok\b/g, " 토큰");
	const brief = (f: Finding) => `- ${f.kind} ${f.who.replace(/ 워커 /, " · ")}: ${plain(f.amount.split(" / ")[0])}${f.tip ? ` → ${f.tip}` : ""}`;
	const alert = flags.length
		? [
			`토큰 누수 점검 (${kst(since)}~${kst(now)}): 합계 ${M(total)} 토큰 ${usd(totalCost)}, 경고 ${flags.length}건`,
			...(recurring.length ? [`며칠째 반복되는 경고: ${recurring.join(", ")}`] : []),
			...Object.values(Object.groupBy([...flags].sort((a, b) => b.save - a.save), f => f.kind)).slice(0, 4).map(g => (g!.length === 1 ? brief(g![0]) : `${brief(g![0])} 외 ${g!.length - 1}건`)),
			`전체 보고서: ${tilde(reportPath)} (자동으로 고치지는 않아요)`,
		].slice(0, 7).join("\n")
		: undefined;
	const summary = `토큰 점검: 세션 ${results.length}개, ${M(total)} tok ${usd(totalCost)}, 경고 ${flags.length}건 / 참고 ${findings.length - flags.length}건, 보고서 ${tilde(reportPath)}`;
	return { flags: flags.length, notes: findings.length - flags.length, sessions: results.length, tokens: total, cost: Number(totalCost.toFixed(2)), report: reportPath, alert, summary };
}

// Same local-time setTimeout scheduling as the nightly reflection; the audit runs before it so the digest can cite it.
export function startTokenAudit(alert: (text: string) => void): void {
	const at = String((cfg as { token_audit_at?: string }).token_audit_at ?? "04:30");
	if (at === "off") return;
	const [h, m] = at.split(":").map(Number);
	const next = () => {
		const d = new Date();
		d.setHours(h, m, 0, 0);
		if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
		return d.getTime() - Date.now();
	};
	const run = () => {
		try {
			const r = runAudit();
			log(`token audit: ${r.sessions} sessions, ${r.flags} warning(s), report ${tilde(r.report)}`);
			if (r.alert) alert(r.alert);
		} catch (error) {
			log(`token audit failed: ${error}`);
		}
		trackTimer("token audit", setTimeout(run, next()));
	};
	trackTimer("token audit", setTimeout(run, next()));
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const dry = argv.includes("--dry");
	if (!dry) {
		console.error("usage: bun hub/token-audit.ts --dry [--hours N]  (a real run is scheduled by the gateway)");
		process.exit(1);
	}
	const r = runAudit({ hours: Number(argv[argv.indexOf("--hours") + 1]) || 24, dry });
	console.log(r.alert ? `--- (dry) would send to alert ---\n${r.alert}\n---` : "--- (dry) clean, nothing to send ---");
	console.log(r.summary);
	console.log(`RESULT ${JSON.stringify({ flags: r.flags, notes: r.notes, sessions: r.sessions, tokens: r.tokens, cost: r.cost, report: r.report })}`);
}
