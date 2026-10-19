// Runtime selection support: which agent harnesses are installed, the compatibility checklist a runtime must pass before
// the hub switches to it, and the guarded switch itself. An adapter proves each checklist item with a probe (a real,
// small run against the installed binary); this module runs them, decides what the hub can substitute or turn off for a
// non-core item, and keeps the last report per runtime in <DATA_DIR>/runtime-checks/<id>.json. Nothing here restarts a process.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, DATA_DIR, log, now, orchestratorModel, selectorOf, setRuntime, writeAtomic } from "../config.ts";
import { broadcast } from "../events.ts";
import { codex } from "./detect.ts";
import { adapters, DEFAULT_RUNTIME } from "./index.ts";
import type { DetectResult, RuntimeAdapter, RuntimeId } from "./types.ts";

export type CheckResult = "ok" | "adapted" | "disabled" | "unsupported" | "fail";
export type CheckItem = { id: string; label: string; core: boolean; result: CheckResult; note: string };
export type VerifyReport = { runtime: RuntimeId; at: string; version?: string; items: CheckItem[]; verdict: "ok" | "adjusted" | "blocked" };
export type ProbeCtx = { cwd: string; model: string; log: (s: string) => void; timeoutMs: number };
export type Probe = (ctx: ProbeCtx) => Promise<{ result: CheckResult; note: string }>;
export type Detection = DetectResult;
export type Detected = Detection & { id: RuntimeId; label: string; hasAdapter: boolean; usable: boolean };
export type UseRole = "orchestrator" | "lanes";

// Adapter surface this module reads beyond RuntimeAdapter: the probes of its checklist items.
type Probing = RuntimeAdapter & { probes?: Record<string, Probe> };

// Detection and menu order: the default (OmO) first; omp stays as an explicit opt-in.
export const RUNTIME_IDS = ["omo", "omp", "claude", "codex"] as RuntimeId[];
export const RUNTIME_LABEL: Record<string, string> = { omp: "omp", claude: "Claude Code", codex: "Codex", omo: "OmO (oh-my-openagent)" };
// Runtimes dotz can list but has no adapter for yet.
const DETECT_ONLY: Record<string, { detect(): Promise<DetectResult> }> = { codex };

// The checklist. `core` items block a switch when they do not pass; the others are adapted or turned off.
export const CHECKLIST: { id: string; label: string; core: boolean }[] = [
	{ id: "turn", label: "한 턴 실행", core: true },
	{ id: "model_effort", label: "모델·추론 강도 지정", core: true },
	{ id: "resume", label: "세션 이어가기", core: true },
	{ id: "handover", label: "새 세션으로 인계", core: false },
	{ id: "compaction_events", label: "컴팩션 알림", core: false },
	{ id: "usage_report", label: "토큰·컨텍스트 수치 보고", core: true },
	{ id: "steer_abort", label: "끼어들기·중단", core: false },
	{ id: "deny_lines", label: "차단 명령 적용", core: true },
	{ id: "guard_extension", label: "가드 확장 적재", core: false },
	{ id: "dotz_tools", label: "dotz 도구", core: false },
	{ id: "tool_intent", label: "도구 호출 의도 표시", core: false },
	{ id: "workers_spawn", label: "작업자 생성", core: false },
	{ id: "workers_isolated_patch", label: "격리 작업자 패치", core: false },
	{ id: "fallback_chain", label: "모델 대체 체인", core: false },
];

// What the hub does when a non-core item is not provided: `adapted` = a hub-side substitute keeps the feature,
// `disabled` = the feature is off for this runtime (recorded in the report and shown on the settings screen).
const ADJUST: Record<string, { result: "adapted" | "disabled"; note: string }> = {
	handover: { result: "adapted", note: "허브가 저장된 세션에서 최근 대화를 읽어 새 세션 첫 프롬프트로 넘겨요" },
	compaction_events: { result: "adapted", note: "허브가 토큰 수치로 직접 컴팩션 시점을 정해요" },
	steer_abort: { result: "adapted", note: "끼어들기는 현재 턴이 끝난 뒤 이어서 보내고, 중단은 프로세스 종료로 처리해요" },
	guard_extension: { result: "disabled", note: "가드 확장(브리핑·패치·예산 점검)은 이 런타임에서 돌지 않아요. 차단 명령은 '차단 명령 적용' 항목이 따로 막아요" },
	dotz_tools: { result: "disabled", note: "dotz 도구(레인·기억 등)를 이 런타임에서는 쓰지 않아요" },
	tool_intent: { result: "disabled", note: "도구 호출의 의도 줄을 보여주지 않아요" },
	workers_spawn: { result: "disabled", note: "작업자(서브에이전트) 기능을 꺼요" },
	workers_isolated_patch: { result: "disabled", note: "격리 작업자와 패치 병합을 꺼요" },
	fallback_chain: { result: "disabled", note: "모델 폴백 체인을 이 런타임에서는 쓰지 않아요. 한도·오류 때는 기존처럼 기다렸다가 같은 모델로 다시 시도해요" },
};

export function verdictOf(items: CheckItem[]): VerifyReport["verdict"] {
	if (items.some(i => i.core && (i.result === "fail" || i.result === "unsupported"))) return "blocked";
	return items.some(i => i.result === "adapted" || i.result === "disabled") ? "adjusted" : "ok";
}

// Turns raw probe results into the report items: a non-core fail/unsupported becomes adapted or disabled and keeps the cause.
export function adjustItems(raw: CheckItem[]): CheckItem[] {
	return raw.map(i => {
		if (i.core || (i.result !== "fail" && i.result !== "unsupported")) return i;
		const a = ADJUST[i.id];
		return a ? { ...i, result: a.result, note: `${a.note} (원인: ${i.note})` } : i;
	});
}

const dir = () => join(DATA_DIR, "runtime-checks");
const reportFile = (id: string) => join(dir(), `${id}.json`);

export function lastReport(id: string): VerifyReport | undefined {
	try {
		const r = JSON.parse(readFileSync(reportFile(id), "utf8")) as VerifyReport;
		return Array.isArray(r.items) && r.runtime === id ? r : undefined;
	} catch {
		return undefined;
	}
}
// ---- detection ----

let detectCache: { at: number; list: Detected[] } | undefined;
export async function detectAll(refresh = false): Promise<Detected[]> {
	if (!refresh && detectCache && Date.now() - detectCache.at < 30_000) return detectCache.list;
	const list = await Promise.all(
		RUNTIME_IDS.map(async (id): Promise<Detected> => {
			const adapter = Object.hasOwn(adapters, id) ? adapters[id] : undefined;
			const d = await (adapter ?? DETECT_ONLY[id]).detect();
			const hasAdapter = !!adapter;
			const reason = !d.installed ? "설치 안 됨" : !hasAdapter ? "dotz 어댑터 없음" : undefined;
			return { id, label: RUNTIME_LABEL[id], ...d, hasAdapter, usable: d.installed && hasAdapter, reason };
		}),
	);
	detectCache = { at: Date.now(), list };
	return list;
}

// ---- running the checks ----

export type VerifyState = { runtime: RuntimeId; running: boolean; startedAt?: string; done: number; total: number; current?: string };
const states = new Map<string, VerifyState>();
export const verifyState = (id: string): VerifyState | undefined => states.get(id);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`시간 초과 (${Math.round(ms / 1000)}초)`)), ms)))]).finally(() => clearTimeout(timer));
};

export type VerifyOpts = { adapter?: Probing; probes?: Record<string, Probe>; model?: string; timeoutMs?: number; version?: string; persist?: boolean };

// Runs every checklist item, never throws. Without an adapter every item fails; without a probe it is unsupported.
export async function verifyRuntime(id: RuntimeId, o: VerifyOpts = {}): Promise<VerifyReport> {
	// The state is registered before the first await, so startVerify() hands out this same object.
	const state: VerifyState = { runtime: id, running: true, startedAt: now(), done: 0, total: CHECKLIST.length };
	states.set(id, state);
	const announce = (text: string) => broadcast({ ts: now(), kind: "runtime_check", source: "hub", text, runtime: id, running: state.running, done: state.done, total: state.total, current: state.current });
	const adapter = o.adapter ?? ((Object.hasOwn(adapters, id) ? adapters[id] : undefined) as Probing | undefined);
	const logFile = join(dir(), `${id}.log`);
	const note = (s: string) => appendFileSync(logFile, `${now()} ${s}\n`);
	const raw: CheckItem[] = [];
	let cwd: string | undefined;
	try {
		announce("check started");
		mkdirSync(dir(), { recursive: true });
		const version = o.version ?? (await detectAll()).find(d => d.id === id)?.version;
		if (!adapter) {
			for (const c of CHECKLIST) raw.push({ ...c, result: "fail", note: "dotz 어댑터 없음" });
		} else {
			const probes = o.probes ?? (adapter as Probing).probes ?? {};
			const model = o.model ?? selectorOf(orchestratorModel());
			const timeoutMs = o.timeoutMs ?? Number(process.env.DOTZ_VERIFY_TIMEOUT_MS ?? 90_000);
			cwd = mkdtempSync(join(tmpdir(), `dotz-verify-${id}-`));
			for (const c of CHECKLIST) {
				state.current = c.label;
				announce(`checking ${c.id}`);
				const probe = Object.hasOwn(probes, c.id) ? probes[c.id] : undefined;
				let r: { result: CheckResult; note: string };
				// omp is the harness the hub was first built on: without probes of its own its items are the baseline.
				if (!probe) r = id === "omp" ? { result: "ok", note: "기준 하네스예요" } : { result: "unsupported", note: "이 런타임에서 확인하는 방법이 없어요" };
				else {
					note(`probe ${c.id} start`);
					try {
						r = await withTimeout(probe({ cwd, model, log: s => note(`${c.id}: ${s}`), timeoutMs }), timeoutMs);
					} catch (e) {
						r = { result: "fail", note: String((e as Error)?.message ?? e).slice(0, 300) };
					}
					note(`probe ${c.id} -> ${r.result}: ${r.note}`);
				}
				raw.push({ ...c, result: r.result, note: r.note });
				state.done++;
			}
		}
		const items = adapter ? adjustItems(raw) : raw;
		const report: VerifyReport = { runtime: id, at: now(), ...(version ? { version } : {}), items, verdict: verdictOf(items) };
		if (o.persist !== false) {
			writeAtomic(reportFile(id), `${JSON.stringify(report, null, 2)}\n`);
		}
		log(`runtime check ${id}: ${report.verdict}`);
		return report;
	} finally {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		state.running = false;
		state.current = undefined;
		announce("check finished");
	}
}

// Starts a check in the background (one at a time per runtime); poll verifyState()/lastReport().
export function startVerify(id: RuntimeId, o: VerifyOpts = {}): VerifyState {
	const running = states.get(id);
	if (running?.running) return running;
	void verifyRuntime(id, o).catch(e => log(`runtime check ${id} failed: ${String(e)}`));
	return states.get(id)!;
}

// ---- switching ----

export class UseRefused extends Error {}

// Why a switch to `id` is refused, or undefined when allowed. omp (the original baseline) needs no report; it is only
// ever chosen explicitly. The default runtime (OmO) needs its report like any other, but going back to it when it is
// installed is never refused, so a failed check cannot strand the gateway on an opt-in runtime.
export function refusalFor(id: string, detected: Detected | undefined, report: VerifyReport | undefined): string | undefined {
	if (!RUNTIME_IDS.includes(id as RuntimeId)) return `알 수 없는 실행 하네스예요: ${id}`;
	if (id === "omp") return undefined;
	if (id === DEFAULT_RUNTIME && detected?.installed && detected.hasAdapter) return undefined;
	if (!detected?.installed) return "설치되어 있지 않아요";
	if (!detected.hasAdapter) return "dotz 어댑터가 없어요";
	if (states.get(id)?.running) return "호환성 검사가 아직 끝나지 않았어요";
	if (!report) return "호환성 검사를 먼저 해야 해요";
	// The stored verdict is not trusted: it is recomputed, and a report missing a core item counts as blocked.
	const missingCore = CHECKLIST.some(c => c.core && !report.items.some(i => i.id === c.id));
	if (missingCore || verdictOf(report.items) === "blocked") return "호환성 검사에서 막혔어요. 핵심 항목이 통과해야 해요";
	if (detected.version && report.version !== detected.version) return `검사한 뒤 버전이 바뀌었어요 (${report.version ?? "알 수 없음"} → ${detected.version}). 다시 검사해 주세요`;
	return undefined;
}

// Writes the choice to config.json for the chosen roles. Returns the roles written; nothing is restarted.
export async function useRuntime(id: string, roles: UseRole[], detected?: Detected[]): Promise<UseRole[]> {
	const reason = refusalFor(id, (detected ?? (await detectAll(true))).find(d => d.id === id), lastReport(id));
	if (reason) throw new UseRefused(reason);
	const chosen = roles.filter((r, i) => (r === "orchestrator" || r === "lanes") && roles.indexOf(r) === i);
	if (!chosen.length) throw new UseRefused("적용할 대상이 없어요 (orchestrator, lanes)");
	setRuntime(chosen, id);
	return chosen;
}

// What config.json currently selects per role (before the hub's default for a name without an adapter).
export const currentRuntimes = () => ({ orchestrator: cfg.orchestrator?.runtime ?? cfg.runtime ?? DEFAULT_RUNTIME, lanes: cfg.lanes?.runtime ?? cfg.runtime ?? DEFAULT_RUNTIME });

export async function runtimesView(refresh = false) {
	const current = currentRuntimes();
	return {
		current,
		checklist: CHECKLIST,
		runtimes: (await detectAll(refresh)).map(d => {
			const report = lastReport(d.id);
			const refusal = refusalFor(d.id, d, report);
			return {
				...d,
				roles: (Object.keys(current) as UseRole[]).filter(r => current[r] === d.id),
				report: report ? { at: report.at, version: report.version, verdict: report.verdict, counts: countResults(report.items) } : null,
				state: verifyState(d.id) ?? null,
				switchable: !refusal,
				refusal: refusal ?? null,
			};
		}),
	};
}

const countResults = (items: CheckItem[]) => items.reduce<Record<string, number>>((m, i) => ((m[i.result] = (m[i.result] ?? 0) + 1), m), {});
