// The KakaoTalk adapter of the one reply flow (the reply unification design, 1.8 column 4) and its in-process sender: the room drafts as the
// one view, a revise through the room's own prompt (lint, lesson, stored before anything is learned) and a send through dispatchSend with the
// lease, the newer-message check and the room list, as the web's own send does.
import type { SendJob } from "../approval-send.ts";
import { sinceMidnight } from "../reply-route.ts";
import { isReasonCode } from "../reply-reasons.ts";
import type { DraftView, LearnInput, LessonOfEdit, ReasonCode, ReplyAdapter, SendOutcome } from "../reply-types.ts";
import { dispatchSend, type DispatchDeps } from "./contract.ts";
import type { Made } from "./make-draft.ts";
import { claimEditLearned, confirmSent, type Draft, draftBlock, dropDraft, editDraft, kakaoView, readDrafts, restoreDraft, type SendResult } from "./send.ts";
import type { KakaoPaths } from "./types.ts";

/** What createKakaoWeb hands the adapter: the store, a revise through its own model call, and the deps of one send. */
// original: the message a draft answers (absent in tests that build the adapter alone).
export type KakaoKit = { paths: KakaoPaths; original?: (d: Draft) => Promise<DraftView["original"]>; revise: (chatId: string, revise: { code: string; draft: string; change: string; intent?: string }) => Promise<Made>; sendDeps: () => Promise<DispatchDeps>; edits?: EditLearning };
/** What a sent draft the owner edited teaches (design 3.4): the chat lines the draft answered, the room's reply model, the lesson reader, and the learning entry it goes to (kakaoKeys: that room's profile). */
export type EditLearning = { answered: (d: Draft) => Promise<string>; ask: (system: string, user: string, chatId: string) => Promise<string>; lessonOfEdit: LessonOfEdit; learn: (input: LearnInput) => void };

/** The profile a KakaoTalk lesson goes to: the room, which is the person a reply goes to (there is no recipient of its own). */
export const kakaoKeys = (chatId: string): LearnInput["keys"] => ({ channel: { app: "kakao", room: chatId } });

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
	const sentAtOf = (d: Draft): number | undefined => {
		const at = d.status === "sent" && !d.unconfirmed && d.sentAt ? Date.parse(d.sentAt) : Number.NaN;
		return Number.isFinite(at) ? at : undefined;
	};
	// The card quotes the message it answers; a database that cannot be read leaves the draft without the quote. The view itself is the one the
	// inbox verdict hashes too (send.ts kakaoView).
	const withOriginal = async (d: Draft): Promise<DraftView> => {
		const v = kakaoView(d, readDrafts(kit.paths)), original = kit.original ? await kit.original(d).catch(() => undefined) : undefined;
		const at = sentAtOf(d);
		return { ...v, ...(original ? { original } : {}), ...(at === undefined ? {} : { sent: { at, how: "owner" as const } }) };
	};
	const done = (r: SendResult) => (r.ok ? { ok: true as const } : { ok: false as const, reason: { code: codeOf(r.code), text: r.reason ?? "" } });
	const learnEdit = (ref: string): void => {
		const d = draftOf(ref), e = kit.edits;
		if (!e || d?.status !== "sent" || d.unconfirmed || d.editedFrom === undefined) return;
		const before = d.editedFrom;
		const learning = async (): Promise<void> => {
			if (!claimEditLearned(kit.paths, ref)) return;
			const received = await e.answered(d);
			const taught = await e.lessonOfEdit({ before, after: d.text, received }, (system, user) => e.ask(system, user, d.chatId)).catch(err => (console.error(`kakao: what the edit of ${ref} teaches was not read: ${err instanceof Error ? err.message : String(err)}`), undefined));
			e.learn({ source: "edit", ref, keys: kakaoKeys(d.chatId), words: taught?.lesson ?? "", ...(taught?.everywhere ? { proposal: { scope: "everywhere" } } : {}) });
		};
		void learning().catch(err => console.error(`kakao: what the edit of ${ref} teaches was not recorded: ${err instanceof Error ? err.message : String(err)}`));
	};

	return {
		kind: "kakao",
		get: async ref => {
			const d = draftOf(ref);
			return d ? withOriginal(d) : undefined;
		},
		list: async () => Promise.all(readDrafts(kit.paths).filter(d => d.status === "pending" || sinceMidnight(sentAtOf(d) ?? Number.NEGATIVE_INFINITY)).map(withOriginal)),
		target: ref => (draftOf(ref) ? { kind: "kakao", lane: "kakao" } : undefined),
		// The inbox verdict is skipped (ownerApproved) only because every job the queue runs is the owner's own act or code's retry of one, and the
		// queue's gate (hub/approval-send.ts) checked it carries the version he approved; any other job is refused. The 다시 보내기 after 확인 필요
		// (force) takes over a dead sender.
		run: async (job: SendJob) => {
			if (job.by !== "owner" && job.by !== "auto") return { sent: "no", code: "not_approved" };
			const o = outcomeOf(await dispatchSend({ kind: "draft", code: job.ref, ownerApproved: true, ...(job.force ? { retry: true } : {}) }, await kit.sendDeps()));
			if (o.sent === "yes") learnEdit(job.ref);
			return o;
		},
		learnSent: learnEdit,
		revise: async (ref, change) => {
			const d = draftOf(ref);
			if (!d) return { ok: false, reason: { code: "gone", text: "그 초안을 찾지 못했어요" } };
			const made = await kit.revise(d.chatId, { code: d.code, draft: d.text, change, ...(d.intent ? { intent: d.intent } : {}) });
			if (!made.ok || !made.code) return { ok: false, reason: { code: "revise_failed", text: made.ok ? "고친 초안을 만들지 못했어요" : made.error } };
			return { ok: true, ref: made.code, replaces: ref, ...(made.learned ? { lesson: { keys: kakaoKeys(d.chatId), words: made.learned.line, proposal: { once: made.learned.once, scope: made.learned.scope, forbid: made.learned.forbid }, evidence: { draft: d.text, change } } } : {}) };
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
