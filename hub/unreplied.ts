// 미답장: the one shared rule for "this item still waits for the owner's reply", kept apart from read/unread (reading never clears it).
// Each app keeps the facts in its own state (comments: custom/comments, mail: mail-conversations.json, kakao: kakao/unreplied.json) and
// asks these pure rules. An item leaves 미답장 when a reply went out for it, when the owner answered himself, or when he taps 답장 안 함.

/** Older items are history, not a backlog: they never count as 미답장. */
export const UNREPLIED_WINDOW_MS = 30 * 24 * 3600 * 1000;
export const unrepliedFresh = (at: number, now: number): boolean => Number.isFinite(at) && now - at <= UNREPLIED_WINDOW_MS;

/** Mail: set when the mail expects an answer (a reply draft was offered, a reply is awaited, or a poster marked it `needsReply`);
 *  cleared by a sent draft for it, by the reply state "sent", or by the owner's 답장 안 함 (`noReply`). */
export type MailFacts = { key: string; at: string; suggest?: { state?: string }; needsReply?: boolean; noReply?: boolean };
export function mailUnreplied(m: MailFacts, sentRefs: ReadonlySet<string>, now: number): boolean {
	if (m.noReply || sentRefs.has(m.key) || m.suggest?.state === "sent") return false;
	return (m.needsReply === true || !!m.suggest) && unrepliedFresh(Date.parse(m.at), now);
}

/** Kakao: a watched room waits for a reply while the newest message with words is from someone else. The owner's own message after it
 *  (typed in KakaoTalk or sent from the web) is newer, so it clears the room by itself; `dismissed` is the logId he waved off. */
export type KakaoFact = { logId: string; fromMe: boolean; sentAt: number };
export function kakaoUnreplied(newest: KakaoFact | undefined, dismissed: string | undefined, now: number): boolean {
	if (!newest || newest.fromMe || !unrepliedFresh(newest.sentAt, now)) return false;
	return !dismissed || BigInt(newest.logId) > BigInt(dismissed);
}
