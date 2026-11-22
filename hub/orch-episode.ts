import { log } from "./config.ts";
import { markTold, noteBlock } from "./limit-alert.ts";
import { errorAskHold, noteErrorAsked, type OrchError, plainError } from "./orch-error.ts";

export type EpisodeHost = {
	who: string;
	agent: string;
	orch: { error: OrchError | undefined };
	ask: (e: OrchError) => void;
	notice: (text: string) => void;
};

/** The error episode of one orchestrator session: it begins when automatic retries give up, the owner is asked once if it lasts past the hold, and it ends with the first turn that succeeds. */
export function createErrorEpisode(h: EpisodeHost) {
	let askTimer: Timer | undefined;
	const cancelAsk = (): void => {
		clearTimeout(askTimer);
		askTimer = undefined;
	};
	return {
		cancelAsk,
		markError(raw: string): void {
			if (h.orch.error) return;
			const e = (h.orch.error = { since: new Date().toISOString(), ...plainError(raw), raw: raw.replace(/\s+/g, " ").slice(0, 200) });
			log(`${h.who} error episode begins: ${e.kind} (${e.raw.slice(0, 120)})`);
			const note = noteBlock(h.agent, "", "error", Date.now(), true);
			if (!note.alert) return;
			cancelAsk();
			askTimer = setTimeout(() => {
				askTimer = undefined;
				if (h.orch.error !== e) return;
				markTold(h.agent);
				noteErrorAsked();
				h.ask(e);
			}, Math.max(0, note.since + errorAskHold() - Date.now()));
		},
		clearError(): void {
			const e = h.orch.error;
			if (!e) return;
			if (askTimer) {
				cancelAsk();
				const min = Math.max(1, Math.round((Date.now() - Date.parse(e.since)) / 60_000));
				h.notice(`모델 오류로 ${min}분 멈춘 뒤 스스로 다시 연결됐어요(${e.text}). 알림은 보내지 않았어요.`);
			}
			log(`${h.who} error episode over: a turn succeeded`);
			h.orch.error = undefined;
		},
	};
}
