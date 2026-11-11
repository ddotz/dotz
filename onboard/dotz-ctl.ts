// `dotz status` and `dotz restart` (launcher: hub/dotz-command.ts; wiring: onboard/dotz-ctl-cli.ts). They work from a plain SSH shell: no model, no agent login,
// only the gateway's own HTTP routes (/api/health, /api/state, /api/update, POST /api/gateway/restart) with the local token, and the service manager when the
// gateway does not answer (onboard/service-ctl.ts). Everything outside the process arrives through `Deps`, so every state is tested without a gateway or a clock.
// A restart never kills an answering gateway: it asks for the idle restart (hub/restart.ts), which waits for running work however long that takes.
// Exit codes (also in the help text): 0 done or healthy; 1 unexpected failure; 2 usage; 3 gateway not running (status), or it could not be started (restart);
// 4 a process is alive but does not answer (status), restart did nothing without --force; 5 the restart is requested but the wait ran out; 6 --force refused.
import { callEnv, forceCall, serviceState, startCall, type Exec, type ServiceEnv, type ServiceState } from "./service-ctl.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, notRunning: 3, notAnswering: 4, waitedOut: 5, forceRefused: 6 } as const;
export const CONFIRM_WORD = "restart";
export const USAGE = [
	"사용법: dotz [--print|last|status|restart]",
	"  status             게이트웨이 상태 보기 (모델·로그인 필요 없음)",
	"  restart [--force]  게이트웨이 재시작 (돌던 일은 끊지 않고 끝나길 기다려요)",
	"  종료 코드: 0 정상 · 3 실행 중이 아님 · 4 떠 있지만 응답 없음 · 5 재시작 기다리다 시간 초과 · 6 --force 거절",
];

const HEALTH_MS = 5_000;
const POLL_MS = 2_000;
const PROGRESS_MS = 15_000;
const SILENT_RESCUE_MS = 30_000;
const START_WAIT_MS = 120_000;
const DEFAULT_WAIT_MIN = 30;
const TAIL_LINES = 15;

export type Deps = {
	dir: string;
	port: number;
	token?: string;
	service: ServiceEnv;
	env: Record<string, string | undefined>;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	exec: Exec;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	out: (line: string) => void;
	tail: (file: string, lines: number) => string[];
	/** The text of a file, undefined when it is not there (the doctor's result file). */
	read?: (file: string) => string | undefined;
	tty: () => { in: boolean; out: boolean };
	ask: (prompt: string) => Promise<string>;
};

type Run = { kind?: string; reason?: string; detail?: string };
type Ver = { release?: string; commit?: { sha?: string; short?: string } };
type StateBody = { runs?: Record<string, Run>; work?: { status?: string }[]; auth?: unknown[] };
type UpdateBody = { boot?: string; running?: Ver; disk?: Ver; lastCheck?: { incomingTotal?: number } | null; job?: unknown; busy?: string[] };

async function api<T>(d: Deps, path: string, o: { post?: boolean; ms?: number } = {}): Promise<{ status: number; body?: T } | undefined> {
	try {
		const headers: Record<string, string> = { ...(d.token ? { "x-dotz-token": d.token } : {}), ...(o.post ? { "content-type": "application/json" } : {}) };
		const res = await d.fetch(`http://127.0.0.1:${d.port}${path}`, { method: o.post ? "POST" : "GET", headers, body: o.post ? "{}" : undefined, signal: AbortSignal.timeout(o.ms ?? HEALTH_MS) });
		const body = await res.json().then(b => b as T, () => undefined); // a reply that is not JSON still shows the gateway answers
		return { status: res.status, body };
	} catch {
		return undefined; // refused, reset or timed out: not answering is the fact being asked for
	}
}

const healthy = async (d: Deps): Promise<boolean> => (await api(d, "/api/health"))?.status === 200;
const bootMs = (boot?: string): number | undefined => {
	const ms = boot ? parseInt(boot, 36) : Number.NaN;
	return ms > 1_500_000_000_000 ? ms : undefined; // the gateway's boot id is Date.now() in base 36 (hub/routes.ts)
};
const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
	const t = new Date(ms);
	return `${t.getMonth() + 1}월 ${t.getDate()}일 ${two(t.getHours())}:${two(t.getMinutes())}`;
};
const span = (ms: number) => {
	const min = Math.max(0, Math.floor(ms / 60_000));
	return min >= 1440 ? `${Math.floor(min / 1440)}일 ${Math.floor((min % 1440) / 60)}시간` : min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분` : `${min}분`;
};
const versionOf = (v?: Ver) => (v ? [v.release, v.commit?.short ?? v.commit?.sha?.slice(0, 8)].filter(Boolean).join(" · ") || "알 수 없음" : "알 수 없음");

const KIND = { working: "일하는 중", waiting: "기다리는 중", idle: "쉬는 중", error: "오류", stopped: "멈춤" } as Record<string, string>;
function runLines(runs: Record<string, Run>): string[] {
	const lines: string[] = [];
	const limitLine = (r: Run) => (r.reason === "owner" ? "결제·로그인 문제로 멈춰 있어요 (모델 제공자 쪽을 풀어야 해요)" : `사용 한도로 멈춰 있어요${r.detail ? ` (${clock(Date.parse(r.detail))}까지)` : ""}`);
	const main = runs.main;
	if (main) lines.push(`메인 대화: ${main.kind === "limited" ? limitLine(main) : (KIND[main.kind ?? ""] ?? "끝남")}`);
	const rest = Object.entries(runs).filter(([k, r]) => k !== "main" && r.kind && r.kind !== "done");
	const counts = new Map<string, number>();
	for (const [, r] of rest) counts.set(r.kind!, (counts.get(r.kind!) ?? 0) + 1);
	const parts = [...counts].filter(([k]) => k !== "limited").map(([k, n]) => `${KIND[k] ?? k} ${n}`);
	lines.push(`세션·대화 (끝난 것 빼고): ${parts.length ? parts.join(" · ") : "없음"}`);
	const limited = rest.filter(([, r]) => r.kind === "limited").map(([, r]) => r);
	for (const reason of ["rate", "owner"]) {
		const n = limited.filter(r => (r.reason === "owner" ? "owner" : "rate") === reason).length;
		if (n) lines.push(`  ${reason === "owner" ? "결제·로그인 문제로 멈춘 것" : "사용 한도로 멈춘 것"} ${n}개`);
	}
	return lines;
}

function updateLines(u: UpdateBody): string[] {
	const lines: string[] = [];
	const behind = u.running?.commit?.sha && u.disk?.commit?.sha ? u.running.commit.sha !== u.disk.commit.sha : (u.running?.release ?? "") !== (u.disk?.release ?? "");
	if (behind) lines.push(`업데이트: 새 버전 ${versionOf(u.disk)}이 받아져 있어요. 재시작하면 적용돼요 (dotz restart)`);
	else if ((u.lastCheck?.incomingTotal ?? 0) > 0) lines.push(`업데이트: 받을 수 있는 새 변경이 ${u.lastCheck!.incomingTotal}개 있어요`);
	else lines.push("업데이트: 최신이에요");
	if (u.job) lines.push("  업데이트 작업이 진행 중이에요");
	return lines;
}

export function healthyLines(d: Deps, state: StateBody | undefined, update: UpdateBody | undefined): string[] {
	const lines = [`게이트웨이가 응답해요 (127.0.0.1:${d.port})`];
	if (update) {
		lines.push(`버전: ${versionOf(update.running)}`);
		const started = bootMs(update.boot);
		if (started) lines.push(`시작: ${clock(started)} (켜진 지 ${span(d.now() - started)})`);
	} else lines.push("버전·시작 시각을 읽지 못했어요 (/api/update 응답 없음)");
	if (state) {
		lines.push(...runLines(state.runs ?? {}));
		const working = (state.work ?? []).filter(w => w.status === "running").length;
		lines.push(`백그라운드 워커: ${working}개 일하는 중`);
		if (state.auth?.length) lines.push(`로그인 확인을 기다리는 것: ${state.auth.length}건`);
	} else lines.push("대화·세션 상태를 읽지 못했어요 (/api/state 응답 없음)");
	if (update) lines.push(...updateLines(update));
	lines.push(...doctorLines(d));
	return lines;
}

// One line from the doctor's result file (hub/doctor.ts writes it at night): when it last ran and how many findings it holds. No scan.
function doctorLines(d: Deps): string[] {
	const raw = d.read?.(`${d.dir}/doctor.json`);
	if (!raw) return [];
	try {
		const j = JSON.parse(raw) as { lastRun?: number; findings?: Record<string, unknown> };
		const n = Object.keys(j.findings ?? {}).length;
		if (!j.lastRun) return [];
		return [`닥터 점검: ${clock(j.lastRun)}에 마지막으로 돌았고 ${n ? `살펴볼 것 ${n}건` : "이상 없음"}`];
	} catch {
		return []; // a half-written result file shows no line
	}
}

function serviceLines(s: ServiceState): string[] {
	const name = s.manager === "launchd" ? "launchd" : "systemd 사용자 서비스";
	if (!s.loaded) return [`서비스(${name}): 등록되어 있지 않거나 읽지 못했어요${s.error ? ` (${s.error})` : ""}`];
	return [`서비스(${name}): 등록됨 · ${s.pid ? `pid ${s.pid}` : "프로세스 없음"}${s.state ? ` · 상태 ${s.state}` : ""}${s.lastExit ? ` · 마지막 종료 ${s.lastExit}` : ""}`];
}

function logTails(d: Deps): string[] {
	return ["gateway.err.log", "hub.log"].flatMap(f => {
		const rows = d.tail(`${d.dir}/${f}`, TAIL_LINES);
		return [`--- ${f} (마지막 ${TAIL_LINES}줄) ---`, ...(rows.length ? rows : ["(비어 있거나 없어요)"])];
	});
}

const show = (d: Deps, lines: string[]) => lines.forEach(l => d.out(l));
const stateOf = (d: Deps) => serviceState(d.exec, d.service, d.env);

export async function statusCommand(d: Deps): Promise<number> {
	if (await healthy(d)) {
		const [state, update] = await Promise.all([api<StateBody>(d, "/api/state?limit=1"), api<UpdateBody>(d, "/api/update")]);
		show(d, healthyLines(d, state?.body, update?.body));
		return EXIT.ok;
	}
	const svc = await stateOf(d);
	const alive = svc.pid !== undefined;
	d.out(alive ? `게이트웨이 프로세스는 떠 있는데 응답하지 않아요 (127.0.0.1:${d.port})` : `게이트웨이가 실행 중이 아니에요 (127.0.0.1:${d.port} 응답 없음)`);
	show(d, [...serviceLines(svc), ...logTails(d)]);
	if (alive) d.out("응답이 없어도 일하는 중일 수 있어서 자동으로 끊지 않아요. 정말 필요하면: dotz restart --force (터미널에서 직접)");
	return alive ? EXIT.notAnswering : EXIT.notRunning;
}

type Wait = { limitMs: number; prevBoot?: string; onSilent?: (silentMs: number) => Promise<void>; label: string };

/** Polls /api/update until a gateway answers (and, after a restart request, with a boot id other than the old one); undefined when the limit passes. */
async function waitUp(d: Deps, w: Wait): Promise<UpdateBody | undefined> {
	const start = d.now();
	let lastProgress = start;
	let silentSince: number | undefined;
	for (;;) {
		const r = await api<UpdateBody>(d, "/api/update");
		const now = d.now();
		if (r?.body?.boot && r.body.boot !== w.prevBoot) return r.body;
		if (now - start >= w.limitMs) return undefined;
		silentSince = r ? undefined : (silentSince ?? now);
		if (silentSince !== undefined) await w.onSilent?.(now - silentSince);
		if (now - lastProgress >= PROGRESS_MS) {
			lastProgress = now;
			const busy = r?.body?.busy ?? [];
			d.out(`${w.label} ${span(now - start)}째${busy.length ? ` · 아직 돌고 있는 일 ${busy.length}개: ${busy.slice(0, 3).join(", ")}` : ""}`);
		}
		await d.sleep(POLL_MS);
	}
}

async function startService(d: Deps, svc: ServiceState, how: "start" | "force"): Promise<number> {
	const argv = how === "force" ? forceCall(d.service) : startCall(d.service, svc.loaded);
	d.out(how === "force" ? "서비스 관리자로 게이트웨이를 다시 띄워요 (돌던 프로세스를 끊어요)" : "게이트웨이를 서비스 관리자로 띄워요");
	const r = await d.exec(argv, callEnv(d.service, d.env));
	if (r.code !== 0) {
		d.out(`서비스를 띄우지 못했어요 (종료 코드 ${r.code})`);
		show(d, [...r.out.trim().split("\n").slice(-5), ...logTails(d)]);
		return EXIT.notRunning;
	}
	const up = await waitUp(d, { limitMs: START_WAIT_MS, label: "응답을 기다리는 중" });
	if (!up) {
		d.out(`서비스는 띄웠는데 ${span(START_WAIT_MS)} 안에 응답하지 않았어요`);
		show(d, logTails(d));
		return EXIT.notRunning;
	}
	d.out(`게이트웨이가 응답해요 · 버전 ${versionOf(up.running)}`);
	return EXIT.ok;
}

async function restartAnswering(d: Deps, waitMin: number): Promise<number> {
	const before = (await api<UpdateBody>(d, "/api/update"))?.body;
	if (!before?.boot) {
		d.out("게이트웨이는 응답하는데 현재 상태(/api/update)를 읽지 못해서 재시작을 요청하지 않았어요");
		return EXIT.failed;
	}
	const asked = await api<{ output?: string }>(d, "/api/gateway/restart", { post: true, ms: 10_000 });
	if (asked?.status !== 200) {
		d.out(`재시작 요청이 받아들여지지 않았어요 (${asked ? `HTTP ${asked.status}` : "응답 없음"})`);
		return EXIT.failed;
	}
	const busy = before.busy ?? [];
	d.out(busy.length ? `재시작을 요청했어요. 돌고 있는 일 ${busy.length}개가 끝나길 기다렸다가 다시 시작해요 (일을 끊지 않아요)` : "재시작을 요청했어요 (돌고 있는 일이 없어서 곧 다시 시작해요)");
	let rescued = false;
	const up = await waitUp(d, {
		limitMs: waitMin * 60_000,
		prevBoot: before.boot,
		label: "재시작 기다리는 중",
		onSilent: async silentMs => {
			if (rescued || silentMs < SILENT_RESCUE_MS) return;
			const svc = await stateOf(d);
			if (svc.pid !== undefined) return;
			rescued = true;
			d.out("게이트웨이가 내려갔는데 서비스가 다시 띄우지 않아서 직접 띄워요");
			await d.exec(startCall(d.service, svc.loaded), callEnv(d.service, d.env));
		},
	});
	if (!up) {
		d.out(`${waitMin}분을 기다렸지만 아직 새 프로세스가 응답하지 않아요. 재시작 요청은 그대로 걸려 있어서 일이 끝나면 저절로 다시 시작해요`);
		d.out("다시 실행하지 말고 dotz status로 확인해 주세요");
		return EXIT.waitedOut;
	}
	d.out(`다시 시작했어요 · 버전 ${versionOf(up.running)}`);
	return EXIT.ok;
}

async function forceRestart(d: Deps, svc: ServiceState): Promise<number> {
	const tty = d.tty();
	if (!tty.in || !tty.out) {
		d.out("--force는 터미널에서 직접 입력할 때만 돼요 (입력과 출력이 모두 터미널이어야 해요). 아무것도 하지 않았어요");
		return EXIT.forceRefused;
	}
	d.out(`pid ${svc.pid} 프로세스를 끊고 다시 띄워요. 돌고 있던 일이 중간에 끊겨요.`);
	const typed = (await d.ask(`계속하려면 ${CONFIRM_WORD} 라고 입력하세요: `)).trim();
	if (typed !== CONFIRM_WORD) {
		d.out("확인 글자가 달라서 아무것도 하지 않았어요");
		return EXIT.forceRefused;
	}
	return startService(d, svc, "force");
}

export async function restartCommand(d: Deps, o: { force: boolean; waitMin?: number }): Promise<number> {
	if (await healthy(d)) {
		if (o.force) d.out("게이트웨이가 응답하고 있어서 --force는 쓰지 않아요 (응답하는 게이트웨이는 끊지 않아요)");
		return restartAnswering(d, o.waitMin ?? DEFAULT_WAIT_MIN);
	}
	const svc = await stateOf(d);
	if (svc.pid === undefined) {
		d.out("게이트웨이가 실행 중이 아니에요");
		return startService(d, svc, "start");
	}
	d.out(`게이트웨이 프로세스(pid ${svc.pid})가 떠 있는데 ${HEALTH_MS / 1000}초 안에 응답하지 않아요`);
	show(d, [...serviceLines(svc), ...logTails(d)]);
	if (!o.force) {
		d.out("일하는 중일 수 있어서 끊지 않았어요. 그래도 끊고 다시 띄우려면 터미널에서 직접: dotz restart --force");
		return EXIT.notAnswering;
	}
	return forceRestart(d, svc);
}

export type Parsed = { cmd: "status" } | { cmd: "restart"; force: boolean; waitMin?: number } | { cmd: "usage" };

export function parseArgs(argv: string[]): Parsed {
	const [cmd, ...rest] = argv;
	if (cmd === "status" && rest.length === 0) return { cmd: "status" };
	if (cmd !== "restart") return { cmd: "usage" };
	let force = false;
	let waitMin: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--force") force = true;
		else if (rest[i] === "--wait" && Number(rest[i + 1]) >= 1) waitMin = Number(rest[++i]);
		else return { cmd: "usage" };
	}
	return { cmd: "restart", force, waitMin };
}
