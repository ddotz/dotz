// When a requested gateway restart may exit. A busy orchestrator or lane (task workers included) is never killed: the
// restart waits for idle however long that takes, and says once that it is waiting (2026-10-19: three forced kills of a
// lane after 20 min). Requests close together are coalesced: every request while one waits joins it, and a restart never
// happens sooner than minGapMs after this process started (2026-10-19: 30 restarts in a day from a lane developing dotz).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { writeAtomic } from "./config.ts";

// A restart waiting on busy work posts one notice after this long (hub/main.ts).
export const RESTART_NOTICE_MS = 20 * 60_000;

// While a restart waits, <data dir>/restart-pending.json names the hub that waits (its pid), and the orchestrator and the lanes start
// no new task worker and launch no session (extension/restart-hold.ts): the workers already running finish and the wait ends. A lane
// kept starting a worker as the last one ended, and an update with security fixes waited over 75 minutes (2026-11-10).
export const RESTART_PENDING_FILE = "restart-pending.json";
// Left in <data dir>/lanes/<name>/ by a lane whose task worker the hold refused: the next start gives it one note to go on (hub/laneops.ts).
export const RESTART_HELD_FILE = "restart-held";
export function markRestartPending(dataDir: string, on: boolean): void {
	const file = join(dataDir, RESTART_PENDING_FILE);
	if (on) writeAtomic(file, `${JSON.stringify({ pid: process.pid, since: new Date().toISOString() })}\n`);
	else rmSync(file, { force: true });
}

// What the owner reads for the hub's busy list (hub/main.ts busyNow).
const ownerName = (b: string): string =>
	b
		.replace(/^lane (\S+) background workers \((\d+)\)$/, "세션 $1 (워커 $2개)")
		.replace(/^lane (\S+) \((\d+) background workers\)$/, "세션 $1 (워커 $2개)")
		.replace(/^lane (\S+)$/, "세션 $1")
		.replace(/^orchestrator background workers(?: \((\d+)\))?$/, (_, n) => `메인 대화 워커${n ? ` ${n}개` : ""}`)
		.replace(/^conversation session (\S+) background workers(?: \((\d+)\))?$/, (_, k, n) => `대화 ${k} 워커${n ? ` ${n}개` : ""}`)
		.replace(/^conversation session (\S+)$/, "대화 $1");

// The one alert of a restart that waited past the cap: what still runs, and the owner's choice. Nothing is killed on its own.
export function restartCapText(busy: string[], waitedMin: number): string {
	return [
		`게이트웨이 재시작을 ${waitedMin}분째 기다리고 있어요. 새 버전은 아직 적용되지 않았어요. 새 워커는 막아 두었지만 이 작업이 아직 돌고 있어요: ${busy.map(ownerName).join(", ")}.`,
		issueBlock("게이트웨이 재시작을 어떻게 할까요?", [
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
};

export function createRestartGate(deps: RestartGateDeps) {
	const tickMs = deps.tickMs ?? 2000;
	let since: number | undefined;
	let requests = 0;
	let noticed = false;
	let capped = false;
	let lastStill = 0;

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
		deps.log(`gateway restart (${requests} request(s) coalesced, waited ${Math.round((Date.now() - since!) / 1000)}s)`);
		deps.exit();
	};

	function request(): string {
		requests++;
		const busy = deps.busy();
		if (since !== undefined) return `gateway restart is already waiting (${requests} requests coalesced${busy.length ? `; waiting for: ${busy.join(", ")}` : ""})`;
		since = Date.now();
		deps.hold?.();
		setTimeout(tick, tickMs);
		const gap = Math.max(0, earliest() - Date.now());
		const why = [busy.length ? `waiting for: ${busy.join(", ")}` : "", gap ? `coalescing for ${Math.ceil(gap / 1000)}s` : ""].filter(Boolean);
		if (why.length) deps.log(`gateway restart requested; ${why.join("; ")}`);
		return why.length ? `gateway restarts when idle (${why.join("; ")}; a busy lane is never killed)` : "gateway restarting";
	}

	return { request, waiting: () => since !== undefined };
}
