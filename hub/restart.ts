// When a requested gateway restart may exit. A busy orchestrator or lane (task workers included) is never killed: the
// restart waits for idle however long that takes, and says once that it is waiting (2026-10-19: three forced kills of a
// lane after 20 min). Requests close together are coalesced: every request while one waits joins it, and a restart never
// happens sooner than minGapMs after this process started (2026-10-19: 30 restarts in a day from a lane developing dotz).
// A restart waiting on busy work posts one notice after this long (hub/main.ts).
export const RESTART_NOTICE_MS = 20 * 60_000;

type RestartGateDeps = {
	busy: () => string[];
	/** Owner messages still being collected; they go into the ledger at shutdown, but waiting for them is cheaper. */
	collecting: () => boolean;
	startedAt: number;
	minGapMs: number;
	noticeAfterMs: number;
	tickMs?: number;
	notice: (text: string) => void;
	log: (line: string) => void;
	exit: () => void;
};

export function createRestartGate(deps: RestartGateDeps) {
	const tickMs = deps.tickMs ?? 2000;
	let since: number | undefined;
	let requests = 0;
	let noticed = false;

	const earliest = () => deps.startedAt + deps.minGapMs;
	const tick = () => {
		const busy = deps.busy();
		if (Date.now() < earliest() || busy.length || deps.collecting()) {
			if (busy.length && !noticed && Date.now() - since! >= deps.noticeAfterMs) {
				noticed = true;
				deps.notice(`게이트웨이 재시작을 기다리는 중이에요: ${busy.join(", ")} 작업이 끝나면 다시 시작해요 (강제로 끊지 않아요).`);
			}
			return void setTimeout(tick, tickMs);
		}
		deps.log(`gateway restart (${requests} request(s) coalesced, waited ${Math.round((Date.now() - since!) / 1000)}s)`);
		deps.exit();
	};

	function request(): string {
		requests++;
		if (since !== undefined) return `gateway restart is already waiting (${requests} requests coalesced)`;
		since = Date.now();
		setTimeout(tick, tickMs);
		const busy = deps.busy();
		const gap = Math.max(0, earliest() - Date.now());
		const why = [busy.length ? `waiting for: ${busy.join(", ")}` : "", gap ? `coalescing for ${Math.ceil(gap / 1000)}s` : ""].filter(Boolean);
		return why.length ? `gateway restarts when idle (${why.join("; ")}; a busy lane is never killed)` : "gateway restarting";
	}

	return { request, waiting: () => since !== undefined };
}
