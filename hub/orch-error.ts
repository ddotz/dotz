// The orchestrator stopped working on errors (its automatic retries gave up): what the owner is told, how the owner's
// answer is read, and the one automatic resume once the model is reachable again. Detection itself is in orchestrator.ts
// (orch.error); this file has no model calls. The web banner reads orch.error from /api/state (web/js/40-orch-error.js).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { DATA_DIR, TZ, writeAtomic } from "./config.ts";

export type OrchError = { since: string; kind: "timeout" | "dns" | "network" | "overload" | "crash" | "other"; text: string; raw: string; waiting?: boolean; probed?: boolean };

// The last raw error as one plain Korean line (a provider's error strings mean nothing to the owner).
export function plainError(raw: string): Pick<OrchError, "kind" | "text"> {
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bdns\b/i.test(raw)) return { kind: "dns", text: "네트워크(DNS)가 안 돼요" };
	if (/timed? ?out|timeout|ETIMEDOUT/i.test(raw)) return { kind: "timeout", text: "모델 연결이 계속 시간 초과로 끊겨요" };
	if (/ECONN|fetch failed|network|socket|other side closed|connection|terminated/i.test(raw)) return { kind: "network", text: "네트워크 연결이 계속 끊겨요" };
	if (/overload|\b5\d\d\b|server error|bad gateway|unavailable/i.test(raw)) return { kind: "overload", text: "모델 서버가 계속 바빠요" };
	if (/exited repeatedly/i.test(raw)) return { kind: "crash", text: "어시스턴트 프로세스가 계속 죽어요" };
	return { kind: "other", text: "모델 오류가 계속돼요" };
}

const hm = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

// The one [ask] per error episode: Discord shows buttons for the choice block, the web a decision card, push the ask kind.
export const errorAsk = (name: string, e: OrchError): string =>
	`[ask] ${name}: ${e.text}. ${hm(e.since)}부터 오케스트레이터가 멈춰 있어요.\n${issueBlock("오케스트레이터를 어떻게 할까요?", [
		{ name: "다시 시작", result: "오케스트레이터만 다시 시작하고, 답하지 못한 요청을 오래된 것부터 한 번씩 다시 처리해요." },
		{ name: "기다리기", result: "연결이 돌아오면 한 번 자동으로 다시 시도해요." },
	])}`;

// The ask waits (owner 2026-10-29: "장애 알림이 너무 자주 와요"; 7 of 9 asks in a week ended on their own, 3 of them within 20
// minutes): the error watch below resumes by itself, so an episode that ends inside the hold leaves one worklog line and no
// alert. A new episode within ERROR_ASK_COOLDOWN_MS of the last ask sent waits longer: the owner already knows the model is flaky.
export const ERROR_ASK_HOLD_MS = 20 * 60_000;
export const ERROR_ASK_REPEAT_HOLD_MS = 60 * 60_000;
export const ERROR_ASK_COOLDOWN_MS = 6 * 3600_000;
export const errorAskFile = () => join(DATA_DIR, "error-ask.json");
export function errorAskHold(now = Date.now()): number {
	let last = 0;
	try {
		last = Number(JSON.parse(readFileSync(errorAskFile(), "utf8")).at) || 0;
	} catch {}
	return now - last < ERROR_ASK_COOLDOWN_MS ? ERROR_ASK_REPEAT_HOLD_MS : ERROR_ASK_HOLD_MS;
}
export const noteErrorAsked = (at = Date.now()): void => writeAtomic(errorAskFile(), `${JSON.stringify({ at })}\n`);

// The owner's answer to that ask (a Discord button click or the web card types it); only read while an error is on.
export function errorAnswer(text: string): "restart" | "wait" | undefined {
	if (/^\s*(?:\*\*)?1\)\s*다시 시작/.test(text)) return "restart";
	if (/^\s*(?:\*\*)?2\)\s*기다리기/.test(text)) return "wait";
	return undefined;
}

// One cheap reachability check of the model host: no tokens, any HTTP answer means DNS, TCP and TLS work again.
export async function modelReachable(url = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"): Promise<boolean> {
	try {
		await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
		return true;
	} catch {
		return false;
	}
}

export const PROBE_EVERY_MS = 30_000;
// Resumes once per episode (error.probed) as soon as the model host answers; the restart replays the owner's open
// requests, or, with none open, one tiny probe turn runs (orchestrator.ts start()). Returns the timer.
export function startErrorWatch(deps: { error: () => OrchError | undefined; reachable?: () => Promise<boolean>; resume: () => void; log: (s: string) => void; every?: number }): ReturnType<typeof setInterval> {
	let busy = false;
	return setInterval(async () => {
		const e = deps.error();
		if (!e || e.probed || busy) return;
		busy = true;
		try {
			if (!(await (deps.reachable ?? modelReachable)())) return;
			if (deps.error() !== e || e.probed) return;
			e.probed = true;
			deps.log("orchestrator error: the model host answers again; one automatic resume");
			deps.resume();
		} finally {
			busy = false;
		}
	}, deps.every ?? PROBE_EVERY_MS);
}
