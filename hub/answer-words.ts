// The user's 금지 낱말 목록 on a turn's final answer. The check itself is hub/prompts.ts rewrite: an answer with a listed word is held
// and its session gets the note as that request's next prompt. This is the `review` it calls: the note for a text, or none.
import { attachNote } from "./attach-lines.ts";
import { bannedHits, bannedNote } from "./word-ban.ts";

/**
 * `canTake` says whether the session can take a prompt now (idle or working). A stopped, starting or paused session would hold the
 * note for minutes or hours, so the answer is delivered as it is instead.
 */
export function answerReview(canTake: () => boolean): (text: string) => string | undefined {
	return text => {
		if (!canTake()) return undefined;
		const hits = bannedHits(text);
		// The session must send the whole answer again: a bare "fixed" would replace the held answer and lose its content.
		if (hits.length) return `[dotz gateway] ${bannedNote(hits)} That answer was held back and not delivered: send the whole answer again with only those words changed.`;
		return attachNote(text);
	};
}
