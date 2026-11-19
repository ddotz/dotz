// When a requested gateway restart may exit. A busy orchestrator or lane (task workers included) is never killed: the
// restart waits for idle however long that takes, and says once that it is waiting (2026-10-19: three forced kills of a
// lane after 20 min). Requests close together are coalesced: every request while one waits joins it, and a restart never
// happens sooner than minGapMs after this process started (2026-10-19: 30 restarts in a day from a lane developing dotz).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { OMP, writeAtomic } from "./config.ts";

/** A restart that changes the prompt head (system note or tool text) makes every session write its whole prompt cache anew: it waits for a small context and comes at most once per HEAD_RESTART_EVERY_MS. */
export const HEAD_RESTART_EVERY_MS = 24 * 3_600_000;
/** No prompt-head restart is deferred longer than this. */
export const HEAD_DEFER_MAX_MS = 24 * 3_600_000;
/** A main context at or under this size is small: right after a compaction (about 45K on 2026-11-18) or a nightly fresh start. */
export const SMALL_CONTEXT_TOKENS = 60_000;
export const HEAD_CHECK_MS = 60_000;

/** What a session started now would carry at the head of its prompt: the system note, every extension source (the tool texts) and the harness binary. */
export function promptHeadPrint(o: { systemNote: string; extensionDir: string; harness?: string }): string {
	const hash = createHash("sha256").update(o.systemNote);
	const sources = readdirSync(o.extensionDir, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("fixtures")).sort();
	for (const f of sources) hash.update(`\0${f}\0`).update(readFileSync(join(o.extensionDir, f)));
	if (o.harness && existsSync(o.harness)) {
		const s = statSync(o.harness);
		hash.update(`\0${o.harness}\0${s.size}\0${s.mtimeMs}`);
	}
	return hash.digest("hex");
}

/** Armed at start: true from the moment a session started now would carry another prompt head than one started at arming (the dotz extension and the omp on PATH). */
export function promptHeadChanged(systemNote: () => string): () => boolean {
	const print = () => promptHeadPrint({ systemNote: systemNote(), extensionDir: join(import.meta.dir, "..", "extension"), harness: Bun.which(OMP) ?? undefined });
	const boot = print();
	return () => print() !== boot;
}

/** Armed at start: true once any gateway source file under `dirs` was written after arming (an applied update or an edit): such a restart is never deferred, since the running process would mix old code with new files read later. */
export function gatewayCodeChanged(dirs: string[]): () => boolean {
	const newest = () => dirs.reduce((m, dir) => readdirSync(dir, { recursive: true, encoding: "utf8" }).reduce((n, f) => (f.endsWith(".ts") && !f.includes("node_modules") ? Math.max(n, statSync(join(dir, f)).mtimeMs) : n), m), 0);
	const boot = newest();
	return () => newest() > boot;
}

// A restart waiting on busy work posts one notice after this long (hub/main.ts).
export const RESTART_NOTICE_MS = 20 * 60_000;

// While a restart waits, <data dir>/restart-pending.json names the hub that waits (its pid), and the orchestrator and the lanes start
// no new task worker and launch no session (extension/restart-hold.ts): the workers already running finish and the wait ends. A lane
// kept starting a worker as the last one ended, and an update with security fixes waited over 75 minutes (2026-11-10).
export const RESTART_PENDING_FILE = "restart-pending.json";
// Left by work the hold refused: in <data dir>/lanes/<name>/ for a lane (the next start gives it one note to go on, hub/laneops.ts), in
// <data dir>/ for the orchestrator or a conversation session (the next start wakes the orchestrator once, takeRestartHeld).
export const RESTART_HELD_FILE = "restart-held";
// True once per refused main or conversation-session start: the marker is removed as it is read.
export function takeRestartHeld(dataDir: string): boolean {
	const file = join(dataDir, RESTART_HELD_FILE);
	if (!existsSync(file)) return false;
	rmSync(file, { force: true });
	return true;
}
export function markRestartPending(dataDir: string, on: boolean): void {
	const file = join(dataDir, RESTART_PENDING_FILE);
	if (on) writeAtomic(file, `${JSON.stringify({ pid: process.pid, since: new Date().toISOString() })}\n`);
	else rmSync(file, { force: true });
}

// What the owner reads for the hub's busy list (hub/main.ts busyNow).
export type BusyTitle = (kind: "lane" | "conv", key: string) => string;
const ownerName = (b: string, title: BusyTitle): string => {
	const work = (kind: string, n?: string) => `${kind === "jobs" ? "작업" : "워커"}${n ? ` ${n}개` : ""}`;
	const lane = /^lane (\S+)(?: background workers \((\d+)\)| \((\d+) background workers\))?$/.exec(b);
	if (lane) return `세션 ${title("lane", lane[1]!)}${lane[2] ?? lane[3] ? ` (워커 ${lane[2] ?? lane[3]}개)` : ""}`;
	const main = /^orchestrator background (workers|jobs)(?: \((\d+)\))?$/.exec(b);
	if (main) return `메인 대화 ${work(main[1]!, main[2])}`;
	const conv = /^conversation session (\S+)(?: background (workers|jobs)(?: \((\d+)\))?)?$/.exec(b);
	if (conv) return `대화 ${title("conv", conv[1]!)}${conv[2] ? ` ${work(conv[2], conv[3])}` : ""}`;
	return b === "reply" ? "보내는 중인 답" : b;
};

// The one alert of a restart that waited past the cap: what still runs, and the owner's choice. Nothing is killed on its own.
export function restartCapText(busy: string[], waitedMin: number, title: BusyTitle = (_, key) => key): string {
	return [
		`게이트웨이 재시작을 ${waitedMin}분째 기다리고 있어요. 새 버전은 아직 적용되지 않았어요. 새 워커는 막아 두었지만 이 작업이 아직 돌고 있어요: ${busy.map(b => ownerName(b, title)).join(", ")}.`,
		issueBlock("지금 재시작할까요, 작업이 끝날 때까지 기다릴까요?", [
			{ name: "지금 재시작", result: "설정 → 업데이트의 '지금 재시작'으로 바로 다시 시작해요. 돌던 작업은 끊기고, 세션은 재시작 뒤 이어서 해요." },
			{ name: "계속 기다리기", result: "그대로 두면 돌던 작업이 끝나는 대로 저절로 재시작해요." },
		]),
	].join("\n");
}

type RestartGateDeps = {
	busy: () => string[];
	/** Owner messages still being collected; they go into the ledger at shutdown, but waiting for them is cheaper. */
	collecting: () => boolean;
	startedAt: number;
	minGapMs: number;
	noticeAfterMs: number;
	tickMs?: number;
	notice: (text: string) => void;
	/** The wait began: from now on no new work starts (markRestartPending). */
	hold?: () => void;
	/** Past this wait, one alert to the owner naming what still runs (restartCapText); the wait goes on. */
	capAfterMs?: number;
	cap?: (busy: string[], waitedMin: number) => void;
	log: (line: string) => void;
	exit: () => void;
	headChanged?: () => boolean;
	codeChanged?: () => boolean;
	contextTokens?: () => number;
	headFile?: string;
	headCheckMs?: number;
};

export function createRestartGate(deps: RestartGateDeps) {
	const tickMs = deps.tickMs ?? 2000;
	let since: number | undefined;
	let requests = 0;
	let noticed = false;
	let capped = false;
	let lastStill = 0;
	let deferred: number | undefined;
	let head = false;
	const lastHead = (): number => (deps.headFile && existsSync(deps.headFile) ? Number(readFileSync(deps.headFile, "utf8")) || 0 : 0);
	const headDue = (): string | undefined => {
		const tokens = deps.contextTokens?.() ?? Infinity;
		if (Date.now() - lastHead() >= HEAD_RESTART_EVERY_MS && tokens <= SMALL_CONTEXT_TOKENS) return `context ${tokens} tokens`;
		if (deferred !== undefined && Date.now() - deferred >= HEAD_DEFER_MAX_MS) return `deferred ${Math.round((Date.now() - deferred) / 3_600_000)} h`;
		return undefined;
	};

	const earliest = () => deps.startedAt + deps.minGapMs;
	const tick = () => {
		const busy = deps.busy();
		if (Date.now() < earliest() || busy.length || deps.collecting()) {
			if (busy.length && !noticed && Date.now() - since! >= deps.noticeAfterMs) {
				noticed = true;
				deps.notice(`게이트웨이 재시작을 기다리는 중이에요: 돌고 있는 작업 ${busy.length}개가 끝나면 다시 시작해요 (강제로 끊지 않아요).`);
			}
			if (busy.length && !capped && deps.capAfterMs && Date.now() - since! >= deps.capAfterMs) {
				capped = true;
				const min = Math.round((Date.now() - since!) / 60_000);
				deps.log(`gateway restart waited past its cap (${min} min) for: ${busy.join(", ")}; owner alerted, not killing it`);
				deps.cap?.(busy, min);
			}
			// Past the notice time the wait only grows: say so in the log every period, and keep waiting (only the owner's "restart now" cuts it).
			if (busy.length && Date.now() - since! >= deps.noticeAfterMs && Date.now() - lastStill >= deps.noticeAfterMs) {
				lastStill = Date.now();
				deps.log(`gateway restart still waiting after ${Math.round((Date.now() - since!) / 60_000)} min for: ${busy.join(", ")}; not killing it`);
			}
			return void setTimeout(tick, tickMs);
		}
		deps.log(`gateway restart (${requests} request(s) coalesced, waited ${Math.round((Date.now() - since!) / 1000)}s${head ? ", changes the prompt head" : ""})`);
		if (head && deps.headFile) writeAtomic(deps.headFile, `${Date.now()}\n`);
		deps.exit();
	};

	const deferTick = () => {
		if (deferred === undefined || since !== undefined) return;
		const due = deps.codeChanged?.() ? "the gateway code changed" : deps.headChanged?.() ? headDue() : "the prompt head no longer changes";
		if (!due) return void setTimeout(deferTick, deps.headCheckMs ?? HEAD_CHECK_MS);
		deps.log(`deferred gateway restart goes now (${due})`);
		deferred = undefined;
		begin();
	};

	function begin(): string {
		const busy = deps.busy();
		since = Date.now();
		head = deps.headChanged?.() ?? false;
		deps.hold?.();
		setTimeout(tick, tickMs);
		const gap = Math.max(0, earliest() - Date.now());
		const why = [busy.length ? `waiting for: ${busy.join(", ")}` : "", gap ? `coalescing for ${Math.ceil(gap / 1000)}s` : ""].filter(Boolean);
		if (why.length) deps.log(`gateway restart requested; ${why.join("; ")}`);
		return why.length ? `gateway restarts when idle (${why.join("; ")}; a busy lane is never killed)` : "gateway restarting";
	}

	function request(o: { auto?: boolean } = {}): string {
		requests++;
		const busy = deps.busy();
		if (since !== undefined) return `gateway restart is already waiting (${requests} requests coalesced${busy.length ? `; waiting for: ${busy.join(", ")}` : ""})`;
		if (!o.auto || !deps.headChanged?.() || deps.codeChanged?.() || headDue()) {
			deferred = undefined;
			return begin();
		}
		if (deferred !== undefined) return `gateway restart is already deferred (${requests} requests coalesced)`;
		deferred = Date.now();
		setTimeout(deferTick, deps.headCheckMs ?? HEAD_CHECK_MS);
		deps.log(`gateway restart deferred: it changes the prompt head (context ${deps.contextTokens?.() ?? "unknown"} tokens)`);
		return `gateway restart deferred: it changes the system prompt or tool text, so it goes once the main context is small (after a compaction or the nightly fresh start), at most once a day and within ${HEAD_DEFER_MAX_MS / 3_600_000} h; the owner's restart goes at once`;
	}

	return { request, waiting: () => since !== undefined };
}
