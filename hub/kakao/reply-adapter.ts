// The KakaoTalk adapter of the one reply flow (the reply unification design, 1.8 column 4) and its in-process sender: the room drafts as the
// one view, a revise through the room's own prompt (lint, lesson, stored before anything is learned) and a send through dispatchSend with the
// lease, the newer-message check and the room list, as the web's own send does.
import type { SendJob } from "../approval-send.ts";
import { isReasonCode } from "../reply-reasons.ts";
import type { DraftView, ReasonCode, ReplyAdapter, SendOutcome } from "../reply-types.ts";
import { dispatchSend, type DispatchDeps } from "./contract.ts";
import type { Made } from "./make-draft.ts";
import { confirmSent, type Draft, draftBlock, dropDraft, editDraft, readDrafts, restoreDraft, type SendResult } from "./send.ts";
import type { KakaoPaths } from "./types.ts";

/** What createKakaoWeb hands the adapter: the store, a revise through its own model call, and the deps of one send. */
// original: the message a draft answers (absent in tests that build the adapter alone).
export type KakaoKit = { paths: KakaoPaths; original?: (d: Draft) => Promise<DraftView["original"]>; revise: (chatId: string, revise: { code: string; draft: string; change: string }) => Promise<Made>; sendDeps: () => Promise<DispatchDeps> };

const STATE: Record<string, DraftView["draft"]["state"]> = { pending: "pending", dropped: "dropped", stale: "stale", sent: "sent" };
const codeOf = (c: string | undefined): ReasonCode => (isReasonCode(c) ? c : "unknown");

/** A send result as the queue reads it: sent, surely not sent, may be in the room, or some parts in. */
export function outcomeOf(r: SendResult): SendOutcome {
	if (r.ok && !r.unconfirmed) return { sent: "yes" };
	if (r.ok) return { sent: "maybe", code: "press_unconfirmed" };
	const code = codeOf(r.code);
	if (r.sent === "partial") return { sent: "partial", done: r.done ?? 0, total: r.total ?? 0, code, rest: code === "press_unconfirmed" || code === "unknown" || code === "state_write" ? "maybe" : "no" };
	return r.sent === "maybe" || code === "unknown" ? { sent: "maybe", code } : { sent: "no", code };
}

export function kakaoAdapter(kit: KakaoKit): ReplyAdapter {
	const draftOf = (ref: string): Draft | undefined => readDrafts(kit.paths).find(d => d.code === ref);
	const viewOf = (d: Draft): DraftView => {
		const pending = d.status === "pending";
		const before = d.replaces ? draftOf(d.replaces) : undefined;
		const fixed = (d.sentParts ?? 0) > 0;
		return {
			item: `kakao:${d.chatId}`,
			ref: d.code,
			kind: "kakao",
			app: "kakao",
			label: d.roomName,
			conv: `kakao:${d.chatId}`,
			at: Date.parse(d.created) || 0,
			can: { send: pending, revise: pending && !fixed, edit: pending && !fixed, drop: pending && !fixed, restore: d.status === "dropped" },
			draft: {
				state: d.status === "sent" && d.unconfirmed ? "pending" : (STATE[d.status] ?? "closed"),
				toLabel: "대화방",
				to: d.roomName,
				text: d.text,
				...(d.sentParts ? { sentParts: d.sentParts } : {}),
				...(d.notes?.length ? { notes: d.notes } : {}),
				...(before ? { replaces: { ref: before.code, text: before.text } } : {}),
				...(d.editedFrom !== undefined ? { edited: true as const } : {}),
			},
		};
	};
	// The card quotes the message it answers; a database that cannot be read leaves the draft without the quote.
	const withOriginal = async (d: Draft): Promise<DraftView> => {
		const v = viewOf(d), original = kit.original ? await kit.original(d).catch(() => undefined) : undefined;
		return original ? { ...v, original } : v;
	};
	const done = (r: SendResult) => (r.ok ? { ok: true as const } : { ok: false as const, reason: { code: codeOf(r.code), text: r.reason ?? "" } });

	return {
		kind: "kakao",
		get: async ref => {
			const d = draftOf(ref);
			return d ? withOriginal(d) : undefined;
		},
		list: async () => Promise.all(readDrafts(kit.paths).filter(d => d.status === "pending").map(withOriginal)),
		target: ref => (draftOf(ref) ? { kind: "kakao", lane: "kakao" } : undefined),
		// The owner's pick is in the inbox (written by hub/reply-actions.ts); the 다시 보내기 after 확인 필요 (force) takes over a dead sender.
		run: async (job: SendJob) => outcomeOf(await dispatchSend({ kind: "draft", code: job.ref, ownerApproved: true, ...(job.force ? { retry: true } : {}) }, await kit.sendDeps())),
		revise: async (ref, change) => {
			const d = draftOf(ref);
			if (!d) return { ok: false, reason: { code: "gone", text: "그 초안을 찾지 못했어요" } };
			const made = await kit.revise(d.chatId, { code: d.code, draft: d.text, change });
			if (!made.ok || !made.code) return { ok: false, reason: { code: "revise_failed", text: made.ok ? "고친 초안을 만들지 못했어요" : made.error } };
			return { ok: true, ref: made.code, replaces: ref, ...(made.lesson ? { lesson: { key: { app: "kakao", room: d.chatId }, line: made.lesson } } : {}) };
		},
		edit: async (ref, text) => done(editDraft(ref, text, { paths: kit.paths })),
		drop: async ref => done(dropDraft(ref, { paths: kit.paths })),
		restore: async ref => done(restoreDraft(ref, { paths: kit.paths })),
		markSent: async ref => done(confirmSent(ref, { paths: kit.paths })),
		prove: async ref => {
			const d = draftOf(ref);
			return d?.status === "sent" && !d.unconfirmed ? "sent" : "unknown";
		},
		// The ladder brings KakaoTalk's window up itself on the next attempt; a login needs the owner.
		repair: async (_ref, code) => (code === "app_not_ready" ? "fixed" : "needs_owner"),
		ask: async (ref, headline = "카카오톡 답장 초안을 만들었어요") => {
			const d = draftOf(ref);
			return d ? `[ask] ${headline}\n${draftBlock(d)}` : undefined;
		},
		question: ref => `카톡 답장 보낼까요? (${ref})`,
	};
}
