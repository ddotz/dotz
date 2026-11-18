import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { logsDir } from "./agent-home.ts";

const HOME = homedir();
const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const HOURS = Number(arg("--hours")) || 24;
const DEFAULT_ROOT = join(HOME, ".omp", "agent", "sessions");
const ROOT = arg("--root") ?? DEFAULT_ROOT;
const DRY = argv.includes("--dry");
const IF_DUE = argv.includes("--if-due");
const LOGS = arg("--logs");
const KEEP_HISTORY = ROOT === DEFAULT_ROOT || LOGS !== undefined;
const AGENT_DIR = dirname(ROOT);
const LOG_DIR = LOGS ?? logsDir();
const HISTORY = join(LOG_DIR, "token-audit.json");
const BUST_UNCACHED = 50_000;
const BIG_CTX = 300_000;
const SUB_NOTE = 20e6;
const SUB_FLAG = 50e6;
const IDLE_OUT = 300;
const now = Date.now();
const since = now - HOURS * 3600e3;

const DUE_GAP_MS = 20 * 3600e3;
if (IF_DUE && !DRY) {
	let updated = 0;
	try {
		updated = Date.parse(JSON.parse(readFileSync(HISTORY, "utf8")).updated) || 0;
	} catch {
		updated = 0;
	}
	if (now - updated < DUE_GAP_MS) {
		console.log(`토큰 점검 건너뜀: 마지막 실행 ${((now - updated) / 3600e3).toFixed(1)}h 전 (20h 이내)`);
		console.log(`RESULT ${JSON.stringify({ skipped: true, flags: 0, notes: 0, sessions: 0, tokens: 0, cost: 0, report: "" })}`);
		process.exit(0);
	}
}

const kstDate = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const kst = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const K = (n: number) => `${Math.round(n / 1e3)}K`;
const usd = (n: number) => `$${n.toFixed(2)}`;

type Src = { file: string; label: string; child: boolean; advisor: boolean };
const srcs: Src[] = [];
function walk(dir: string, depth: number): void {
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth > 0) walk(path, depth - 1);
			continue;
		}
		if (!entry.name.endsWith(".jsonl")) continue;
		try {
			if (statSync(path).mtimeMs < since) continue;
		} catch {
			continue;
		}
		const parts = relative(ROOT, path).split("/");
		const project = parts[0].replace(/^--|--$/g, "").replace(/-/g, "/").replace(HOME.slice(1), "~");
		const child = parts.length >= 3;
		const id = child ? `${parts[1].match(/_([0-9a-f]{8})/)?.[1] ?? parts[1].slice(0, 8)}/${entry.name.replace(/\.jsonl$/, "")}` : entry.name.match(/_([0-9a-f]{8})/)?.[1] ?? entry.name.slice(0, 8);
		srcs.push({ file: path, label: `${project} ${child ? "worker " : ""}${id}`, child, advisor: entry.name === "__advisor.jsonl" });
	}
}
walk(ROOT, 2);

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
	fable: number;
	fableCost: number;
	effortTurns: number;
	effortCost: number;
	efforts: Set<string>;
	expensiveCost: number;
	maxToolStreak: number;
	maxToolDesc: string;
	loopTokens: number;
	loopCost: number;
	readRate: number;
	start?: number;
};

const sameModel = (a: string, b: string) => {
	const x = a.split("/").pop() ?? a;
	const y = b.split("/").pop() ?? b;
	return x.includes(y) || y.includes(x);
};

const EXPENSIVE_LEVELS = new Set(["xhigh", "max"]);
const CONFIGURED_ROLES = ["advisor", "plan", "deep"];

function configuredModels(): string[] {
	let text = "";
	try {
		text = readFileSync(join(AGENT_DIR, "config.yml"), "utf8");
	} catch {
		return [];
	}
	const out: string[] = [];
	let inRoles = false;
	for (const line of text.split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		if (/^\S/.test(line)) {
			inRoles = /^modelRoles:\s*$/.test(line);
			continue;
		}
		const m = inRoles ? line.match(/^\s+(\w+):\s*["']?([^"'\s#]+)/) : null;
		if (!m || !CONFIGURED_ROLES.includes(m[1])) continue;
		const model = (m[2].split("/").pop() ?? "").split(":")[0];
		if (model) out.push(model);
	}
	return out;
}
const CONFIGURED_MODELS = configuredModels();

const configuredModel = (src: Src, model: string) => src.advisor || CONFIGURED_MODELS.some(configured => sameModel(model, configured));

interface Usage {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number; input?: number; cacheRead?: number; cacheWrite?: number };
	cttl?: { ephemeral1h?: number; ephemeral5m?: number };
}

interface ContentBlock {
	type?: string;
	name?: string;
	arguments?: unknown;
}

interface SessionMessage {
	role?: string;
	customType?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Usage;
	content?: ContentBlock[] | string;
}

interface SessionEntry {
	type?: string;
	timestamp?: string;
	reason?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
	message?: SessionMessage;
}

function analyze(src: Src): Stats {
	const s: Stats = {
		src, turns: 0, tokens: 0, cost: 0, cw: 0, cr: 0, out: 0, maxCtx: 0, compactions: 0, busts: [], explained: {}, bigNew: 0,
		wakes: {}, warmings: 0, ttsr: 0, errTurns: 0, maxErrStreak: 0, errCodes: {}, compactErr: 0, maxBigStreak: 0, bigTokens: 0, bigCost: 0,
		fbTurns: 0, fbModels: new Set(), fable: 0, fableCost: 0, effortTurns: 0, effortCost: 0, efforts: new Set(), expensiveCost: 0, maxToolStreak: 0, maxToolDesc: "", loopTokens: 0, loopCost: 0, readRate: 0,
	};
	let events: string[] = [];
	let compacted = false, modelChanged = false, thinkChanged = false, user = false;
	let prev: { ts: number; ctx: number; ttlMin: number } | undefined;
	let prevStop = "stop";
	let errStreak = 0, bigStreak = 0, toolHash = "", toolStreak = 0, readTok = 0, readCost = 0;
	let level = "";
	const text = readFileSync(src.file, "utf8");
	for (const line of text.split("\n")) {
		if (line.length < 20) continue;
		let entry: SessionEntry;
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
			level = entry.thinkingLevel ?? level;
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
		const calls = (Array.isArray(m.content) ? m.content : []).filter(c => c?.type === "toolCall");
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
			const dearModel = /fable/i.test(model) && !configuredModel(src, model);
			const dearEffort = EXPENSIVE_LEVELS.has(level) && !configuredModel(src, model);
			if (dearModel) {
				s.fable++;
				s.fableCost += cost;
			}
			if (dearEffort) {
				s.effortTurns++;
				s.effortCost += cost;
				s.efforts.add(`${m.model ?? "?"}:${level}`);
			}
			if (dearModel || dearEffort) s.expensiveCost += cost;
			if (uncached > BUST_UNCACHED && prev) {
				const gapMin = (ts - prev.ts) / 60e3;
				const why = compacted ? "compaction" : modelChanged ? "model change" : thinkChanged ? "thinking change" : gapMin > prev.ttlMin ? `gap>${prev.ttlMin}m` : "";
				if (why) s.explained[why] = (s.explained[why] ?? 0) + 1;
				else if (cr < prev.ctx * 0.8) s.busts.push({ ts, uncached, cr, prevCtx: prev.ctx, cost: (u.cost?.cacheWrite ?? 0) + (u.cost?.input ?? 0), events: [...new Set(events)] });
				else s.bigNew++;
			}
			if (newTurn && !user && events.length) {
				if (!calls.length && (u.output ?? 0) <= IDLE_OUT) {
					const key = events.at(-1) ?? "custom";
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
		const ttlMin = u.cttl?.ephemeral1h ? 60 : u.cttl?.ephemeral5m ? 5 : (prev?.ttlMin ?? 5);
		prev = { ts, ctx, ttlMin };
		prevStop = m.stopReason ?? "stop";
		events = [];
		compacted = modelChanged = thinkChanged = user = false;
	}
	s.readRate = readTok ? readCost / readTok : 0;
	return s;
}

type Finding = { flag: boolean; kind: string; who: string; what: string; amount: string; save: number; evidence?: string; fix?: string; hold?: string };
const results = srcs.map(src => {
	try {
		return analyze(src);
	} catch (error) {
		console.error(`skip ${src.file}: ${error}`);
		return undefined;
	}
}).filter((s): s is Stats => !!s && s.turns + s.errTurns > 0);

const findings: Finding[] = [];
for (const s of results) {
	const who = s.src.label;
	if (s.busts.length) {
		const uncached = s.busts.reduce((a, b) => a + b.uncached, 0);
		const cost = s.busts.reduce((a, b) => a + b.cost, 0);
		const save = s.busts.reduce((a, b) => a + Math.max(0, b.cost - b.uncached * s.readRate), 0);
		const top = Object.entries(s.busts.flatMap(b => b.events).reduce<Record<string, number>>((acc, e) => ((acc[e] = (acc[e] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e);
		findings.push({
			flag: s.busts.length >= 3 || uncached > 1e6, kind: "캐시 깨짐", who,
			what: `캐시 깨짐 ${s.busts.length}회 (압축/모델 변경/TTL 공백 아님)`, amount: `미캐시 재입력 ${M(uncached)} tok, ${usd(cost)}`, save,
			evidence: s.busts.slice(0, 6).map(b => `${kst(b.ts)} 새로 ${K(b.uncached)}/읽기 ${K(b.cr)} (직전 ${K(b.prevCtx)}) <- ${b.events.join(", ") || "이벤트 없음: 도구 목록/시스템 프롬프트 변경 의심"}`).join("; "),
			fix: `제안: 직전 주입 이벤트(${top.join(", ") || "없음"})가 프롬프트 앞부분을 바꾸는지 확인해 고정 - 예상 절감 ~${usd(save)}. 컨텍스트·모델은 그대로라 성능 영향 없음`,
		});
	}
	const wakes = Object.entries(s.wakes);
	const wakeN = wakes.reduce((a, [, w]) => a + w.n, 0);
	if (wakeN) {
		const tokens = wakes.reduce((a, [, w]) => a + w.tokens, 0);
		const cost = wakes.reduce((a, [, w]) => a + w.cost, 0);
		findings.push({
			flag: wakeN >= 10 || cost >= 5, kind: "헛깨움", who, what: `할 일 없이 깨어난 턴 ${wakeN}회`, amount: `${M(tokens)} tok, ${usd(cost)}`, save: cost,
			evidence: wakes.sort((a, b) => b[1].cost - a[1].cost).map(([k, w]) => `${k} ${w.n}회 ${usd(w.cost)}`).join(", "),
			fix: `제안: 반응할 필요 없는 알림(모니터 라인·완료 알림 중복)을 소스에서 걸러 세션을 깨우지 않게 - 예상 절감 ~${usd(cost)}. 실제 일을 시키는 이벤트는 그대로`,
		});
	}
	if (s.ttsr >= 10) {
		findings.push({
			flag: s.ttsr >= 30, kind: "TTSR 개입", who, what: `스트림 규칙(TTSR)이 응답을 끊고 다시 시도시킨 횟수 ${s.ttsr}회`, amount: `${s.ttsr}회`, save: 0,
			fix: "제안: 어떤 규칙이 반복되는지 세션 파일의 ttsr_injection 항목으로 확인하고, 매번 걸리는 규칙은 지시문(RULES.md)으로 옮기거나 ttsr.disabledRules로 끄기 - 규칙의 의도는 유지",
		});
	}
	if (s.maxErrStreak >= 3) {
		findings.push({
			flag: s.maxErrStreak >= 5, kind: "에러 재시도", who, what: `에러 턴 ${s.errTurns}회, 최장 연속 ${s.maxErrStreak}회 (${Object.entries(s.errCodes).map(([k, v]) => `${k}x${v}`).join(", ")})`,
			amount: "대부분 0토큰, 대기·재시도 시간 낭비", save: 0, evidence: s.compactErr ? `압축 실패 ${s.compactErr}회 포함` : undefined,
			fix: "제안: 429는 리셋까지 멈추고 재시도 상한 확인(retry.maxRetries) - 결과물엔 영향 없음",
		});
	}
	if (s.maxBigStreak >= 10) {
		findings.push({
			flag: s.compactErr > 0, kind: "대형 컨텍스트", who, what: `컨텍스트 >${K(BIG_CTX)}로 압축 없이 연속 ${s.maxBigStreak}턴 (최대 ${K(s.maxCtx)})`,
			amount: `해당 턴 ${M(s.bigTokens)} tok, ${usd(s.bigCost)}`, save: 0, evidence: `압축 ${s.compactions}회, 압축 실패 ${s.compactErr}회`,
			fix: s.compactErr ? "제안: 압축 실패 원인 수리(설정된 자동 압축이 원래대로 돌게) - 의도된 동작 복원" : undefined,
			hold: s.compactErr ? undefined : "보류(트레이드오프 있음): 압축 기준을 낮추면 토큰은 줄지만 작업 맥락이 줄어듦",
		});
	}
	if (s.fable || s.effortTurns) {
		const parts = [s.fable ? `Fable 응답 ${s.fable}회 (${usd(s.fableCost)})` : "", s.effortTurns ? `max/xhigh 생각 수준 ${s.effortTurns}턴 (${usd(s.effortCost)}; ${[...s.efforts].join(", ")})` : ""].filter(Boolean);
		const cost = s.fable && s.effortTurns ? s.expensiveCost : s.fable ? s.fableCost : s.effortCost;
		findings.push({
			flag: s.fable > 0, kind: "비싼 모델", who, what: `${parts.join(" + ")} (사용자 규칙: Fable은 명시적으로 요청하거나 설정된 역할일 때만, 폴백 금지; max/xhigh는 참고: 워커 effort는 가드가 역할+1단계로 막음)`, amount: usd(cost), save: cost,
			fix: "제안: 이 세션/워커의 모델 경로(역할·폴백 체인·agentModelOverrides) 확인",
		});
	}
	if (s.fbTurns >= 5) {
		findings.push({
			flag: s.fbTurns >= 20, kind: "폴백 모델", who, what: `의도한 ${s.intended}이 아닌 ${[...s.fbModels].join(", ")}로 ${s.fbTurns}턴`, amount: `${s.fbTurns}턴`, save: 0,
			fix: "제안: 한도가 풀린 뒤에도 폴백에 머무는지 확인(retry.fallbackRevertPolicy) - 의도한 모델 복원",
		});
	}
	if (s.maxToolStreak >= 5) {
		findings.push({
			flag: true, kind: "반복 호출", who, what: `같은 도구 호출 연속 ${s.maxToolStreak}회`, amount: `~${M(s.loopTokens)} tok, ${usd(s.loopCost)}`, save: s.loopCost, evidence: s.maxToolDesc,
			fix: `제안: 같은 호출로 폴링하는 대신 wait/monitor로 대기 - 예상 절감 ~${usd(s.loopCost)}, 결과 동일`,
		});
	}
	if (s.src.child && s.tokens > SUB_NOTE) {
		findings.push({
			flag: s.tokens > SUB_FLAG, kind: "대형 워커", who, what: `${M(s.tokens)} tok, ${s.turns}턴, 압축 ${s.compactions}회, 최대 컨텍스트 ${K(s.maxCtx)}`, amount: usd(s.cost), save: 0,
			fix: "제안: 브리프를 독립 단계(조사 -> 구현 -> 검증)로 나눠 별도 워커로 - 모델·검증은 그대로",
		});
	}
}

type Day = { date: string; tokens: number; cost: number; cacheWrite: number; sessions: number; flags: number };
const total = results.reduce((a, s) => a + s.tokens, 0);
const totalCost = results.reduce((a, s) => a + s.cost, 0);
const totalCw = results.reduce((a, s) => a + s.cw, 0);
const today = kstDate(now);
let history: Day[] = [];
try {
	history = JSON.parse(readFileSync(HISTORY, "utf8")).days ?? [];
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
if (prior.length >= 3 && (total > 2 * medTok || totalCost > 2 * medCost)) {
	const top = [...results].sort((a, b) => b.cost - a.cost).slice(0, 3).map(s => `${s.src.label} ${M(s.tokens)}`).join(", ");
	findings.push({ flag: true, kind: "급증", who: "전체", what: `합계가 7일 중앙값의 ${(total / Math.max(1, medTok)).toFixed(1)}배`, amount: `${M(total)} tok (${usd(totalCost)}) vs 중앙값 ${M(medTok)} (${usd(medCost)})`, save: 0, evidence: `상위: ${top}` });
}
const flags = findings.filter(f => f.flag);
history = [...history.filter(d => d.date !== today), { date: today, tokens: total, cost: totalCost, cacheWrite: totalCw, sessions: results.length, flags: flags.length }].slice(-14);
if (!DRY) mkdirSync(LOG_DIR, { recursive: true });
if (KEEP_HISTORY && !DRY) writeFileSync(HISTORY, `${JSON.stringify({ updated: new Date(now).toISOString(), days: history }, null, 1)}\n`);

const ordered = [...findings].sort((a, b) => Number(b.flag) - Number(a.flag) || b.save - a.save);
const sorted = [...results].sort((a, b) => b.tokens - a.tokens);
const report = [
	`# 토큰 누수 점검 ${today} (KST)`,
	"",
	`기간: ${kst(since)} ~ ${kst(now)} KST (${HOURS}h) · 세션 ${results.length}개 · 합계 ${M(total)} tok · ${usd(totalCost)} · 캐시 쓰기 ${M(totalCw)}`,
	`7일 중앙값: ${prior.length ? `${M(medTok)} tok / ${usd(medCost)} (${prior.length}일)` : "기록 없음"}`,
	"",
	"모든 항목은 보고만 합니다. 자동 적용 없음. \"제안\"은 성능 트레이드오프가 없는 것만, 트레이드오프가 있는 후보는 \"보류\"로 따로 표시합니다.",
	"",
	`## 경고 ${flags.length}건 / 참고 ${findings.length - flags.length}건`,
	...ordered.flatMap(f => [
		"",
		`### ${f.flag ? "경고" : "참고"} [${f.kind}] ${f.who}`,
		`- ${f.what} - ${f.amount}`,
		...(f.evidence ? [`- 근거: ${f.evidence}`] : []),
		...(f.fix ? [`- ${f.fix}`] : []),
		...(f.hold ? [`- ${f.hold}`] : []),
	]),
	"",
	"## 세션별 (토큰 순)",
	"",
	...sorted.map(s => `- ${s.src.label}: 시작 ${s.start ? kst(s.start) : "-"}, ${s.turns}턴, ${M(s.tokens)} tok, ${usd(s.cost)}, 캐시 읽기 ${M(s.cr)}, 쓰기 ${M(s.cw)}, 깨짐 ${s.busts.length}, 설명된 큰 쓰기 ${Object.entries(s.explained).map(([k, v]) => `${k}x${v}`).join(" ") || "-"}${s.bigNew ? ` 새내용x${s.bigNew}` : ""}, 헛깨움 ${Object.values(s.wakes).reduce((a, w) => a + w.n, 0)}, 캐시 워밍 ${s.warmings}, TTSR ${s.ttsr}, 에러 ${s.errTurns}, 최대 컨텍스트 ${K(s.maxCtx)}, 압축 ${s.compactions}`),
	"",
	"## 최근 기록",
	"",
	...history.map(d => `- ${d.date}: ${M(d.tokens)} tok, ${usd(d.cost)}, 캐시 쓰기 ${M(d.cacheWrite)}, 세션 ${d.sessions}, 경고 ${d.flags}`),
	"",
	`기준: 캐시 깨짐 = 미캐시 입력(캐시 쓰기+input) >${K(BUST_UNCACHED)}이면서 캐시 읽기가 직전 컨텍스트의 80% 미만이고, 직전에 압축/모델·thinking 변경/TTL(1h, 5m) 초과 공백이 없음. 헛깨움 = 사용자 입력 없이 알림만으로 시작된 턴이 도구 호출 없이 출력 ${IDLE_OUT} tok 이하로 끝남. 워커 >${M(SUB_NOTE)} 참고, >${M(SUB_FLAG)} 경고.`,
].join("\n");
const reportPath = join(LOG_DIR, `token-audit-${today.replace(/-/g, "")}${KEEP_HISTORY ? "" : "-external"}.md`);
if (!DRY) writeFileSync(reportPath, `${report}\n`);

const summary = [
	`토큰 점검 (${kst(since)}~${kst(now)}): 세션 ${results.length}개, ${M(total)} tok ${usd(totalCost)}, 경고 ${flags.length}건`,
	...flags.sort((a, b) => b.save - a.save).slice(0, 4).map(f => `- ${f.kind} ${f.who}: ${f.amount}`),
	DRY ? "보고서: 저장 안 함 (--dry)" : `보고서: ${reportPath.replace(HOME, "~")}`,
].join("\n");
console.log(summary);
if (DRY) console.log(`\n${report}\n`);
console.log(`RESULT ${JSON.stringify({ flags: flags.length, notes: findings.length - flags.length, sessions: results.length, tokens: total, cost: Number(totalCost.toFixed(2)), report: DRY ? "" : reportPath })}`);
