// What happened to the replies the owner approved, for the 답장 대기 screen (GET /api/replies: failed, sent, stops) and the retry of a failed
// gateway send (POST /api/approvals/failed). Pure: every input is an argument (hub/routes.ts and hub/approval-wire.ts read the stores and pass them),
// so a request costs the reads the caller already does, no subprocess, and the output is bounded.
//   failed  one row per approved send that failed and can still be sent: a mail / gateway send (a notice's decision.send), a comment reply, a KakaoTalk send
//   sent    the replies sent since local midnight, newest first (the same three sources)
//   stops   per pending comment draft, why an enabled auto-send rule did not send it (contract.ts ruleRefusal: the gate's own reasons)
// Nothing here sends or approves anything: a retry hands the pick the owner already made back to the sender, whose own gate still checks it.
import { type SourceConfig, ruleRefusal } from "./comments/contract.ts";
import type { Draft, Reply } from "./comments/store.ts";
import { type SendAction, type SendJob, sendActionOf } from "./approval-send.ts";
import { DRAFT_BODY_MAX } from "./draft-approval.ts";

export type Failed = { key: string; kind: "mail" | "comment" | "kakao"; app: string; who: string; what: string; why?: string; at: number; ref?: string; conv?: string; sendId?: string; chatId?: string; text: string; original?: { who: string; text: string }; attempts?: number };
export type Sent = { key: string; kind: "mail" | "comment" | "kakao"; app: string; who: string; what: string; at: number; how: "owner" | "rule" | "retry"; text: string; original?: { who: string; text: string } };

/** The parts of a decision notice (hub/notices.ts) the outcomes read. */
export type NoticeLike = {
	title: string;
	decision?: {
		to: string;
		state: string;
		answer?: string;
		options: { n: number; label: string }[];
		draft?: { ref?: string; to: string; body: string };
		send?: { state: string; text?: string; at: string; attempts?: number };
	};
};
export type CommentFacts = {
	sources: Record<string, { src: SourceConfig; app: string }>;
	/** The pending reply drafts of the configured sources. */
	drafts: Draft[];
	replies: Reply[];
	comments: { id: string; author: string; text: string; postTitle: string }[];
};
export type KakaoFacts = {
	sends: { id: string; chatId: string; text: string; state: string; reason?: string; at: number; draft: string; retried?: string }[];
	drafts: Record<string, { status: string; room: string }>;
};
export type OutcomeInputs = {
	notices: NoticeLike[];
	/** Which CLI would send draft `ref` now (approval-wire sendTargetOf), undefined when it cannot be sent any more. */
	sendKind: (ref: string) => "mail" | "comment" | undefined;
	appOf: (ref: string) => string | undefined;
	comments: CommentFacts;
	kakao: KakaoFacts;
	/** Local midnight, ms. */
	since: number;
	now: number;
};

export const SENT_CAP = 100;
export const FAILED_CAP = 200;
const WHY_MAX = 300;
const ORIGINAL_MAX = 200;
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const stamp = (iso: string | undefined): number => Date.parse(iso ?? "") || 0;
const whatOf = (title: string) => title.replace(/\s*\([^()]*\)\s*$/, "");
const original = (c: { author: string; text: string } | undefined) => (c ? { original: { who: c.author, text: clip(c.text, ORIGINAL_MAX) } } : {});
const newest = <T extends { at: number }>(list: T[]): T[] => list.sort((a, b) => b.at - a.at);

export function localMidnight(at: number): number {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** The newest gateway send of draft `ref` per notice (the same draft can be asked twice in one conversation). */
function sendCards(notices: NoticeLike[]) {
	const by = new Map<string, { n: NoticeLike & { decision: NonNullable<NoticeLike["decision"]> }; ref: string; at: number }>();
	for (const n of notices) {
		const d = n.decision, ref = d?.draft?.ref;
		if (!d || !ref || !d.send) continue;
		const key = `${d.to}\n${ref}`, at = stamp(d.send.at), old = by.get(key);
		if (!old || at >= old.at) by.set(key, { n: n as never, ref, at });
	}
	return [...by.values()];
}

export function collectOutcomes(i: OutcomeInputs): { failed: Failed[]; sent: Sent[]; stops: Record<string, string> } {
	const { comments: cf, kakao: kf } = i;
	const failed: Failed[] = [], sent: Sent[] = [], stops: Record<string, string> = {};
	const byComment = new Map(cf.comments.map(c => [c.id, c]));
	const pending = new Set(cf.drafts.map(d => d.code));

	// Comment replies: the store's record has its own retry, so it wins over a notice that failed for the same draft.
	const commentFailed = new Set<string>();
	for (const r of cf.replies) {
		const s = cf.sources[r.source], c = byComment.get(r.commentId);
		if (!s) continue;
		if (r.state === "failed" && pending.has(r.draft)) {
			commentFailed.add(r.draft);
			failed.push({ key: `comment:${r.id}`, kind: "comment", app: s.app, who: c?.author ?? "", what: c?.postTitle ?? "", ...(r.reason ? { why: clip(r.reason, WHY_MAX) } : {}), at: r.at, ref: r.draft, sendId: r.id, text: r.text.slice(0, DRAFT_BODY_MAX), ...original(c), ...(r.attempts ? { attempts: r.attempts } : {}) });
		} else if (r.state === "sent" && r.at >= i.since)
			sent.push({ key: `comment:${r.id}`, kind: "comment", app: s.app, who: c?.author ?? "", what: c?.postTitle ?? "", at: r.at, how: r.via === "rule" ? "rule" : (r.attempts ?? 1) > 1 ? "retry" : "owner", text: r.text.slice(0, DRAFT_BODY_MAX), ...original(c) });
	}
	const commentSent = new Set(cf.replies.filter(r => r.state === "sent").map(r => r.draft));

	// Mail and gateway sends: the notice that carried the approval keeps how the send went.
	for (const { n, ref, at } of sendCards(i.notices)) {
		const d = n.decision, send = d.send!;
		if (send.state === "failed") {
			const kind = i.sendKind(ref);
			if (!kind || commentFailed.has(ref)) continue;
			failed.push({ key: `${kind}:${ref}`, kind, app: i.appOf(ref) ?? kind, who: d.draft!.to, what: whatOf(n.title), ...(send.text ? { why: clip(send.text, WHY_MAX) } : {}), at, ref, conv: d.to, text: d.draft!.body.slice(0, DRAFT_BODY_MAX), ...(send.attempts ? { attempts: send.attempts } : {}) });
		} else if (send.state === "sent" && at >= i.since && !commentSent.has(ref))
			sent.push({ key: `mail:${ref}`, kind: "mail", app: i.appOf(ref) ?? "mail", who: d.draft!.to, what: whatOf(n.title), at, how: (send.attempts ?? 1) > 1 ? "retry" : "owner", text: d.draft!.body.slice(0, DRAFT_BODY_MAX) });
	}

	// KakaoTalk: a failed send that 다시 보내기 replaced stays on record marked `retried`, so a chain of tries is told from the records.
	const before = new Map(kf.sends.flatMap(s => (s.retried ? [[s.retried, s] as const] : [])));
	const tries = (id: string): number => {
		let n = 1;
		for (let p = before.get(id); p && n < 50; p = before.get(p.id)) n++;
		return n;
	};
	for (const s of kf.sends) {
		const d = kf.drafts[s.draft];
		if (s.state === "failed" && !s.retried && d?.status === "pending") {
			const n = tries(s.id);
			failed.push({ key: `kakao:${s.id}`, kind: "kakao", app: "kakao", who: d.room, what: "카카오톡 답장", ...(s.reason ? { why: clip(s.reason, WHY_MAX) } : {}), at: s.at, ref: s.draft, conv: `kakao:${s.chatId}`, sendId: s.id, chatId: s.chatId, text: s.text.slice(0, DRAFT_BODY_MAX), ...(n > 1 ? { attempts: n } : {}) });
		} else if (s.state === "sent" && s.at >= i.since) sent.push({ key: `kakao:${s.id}`, kind: "kakao", app: "kakao", who: d?.room ?? "", what: "카카오톡 답장", at: s.at, how: tries(s.id) > 1 ? "retry" : "owner", text: s.text.slice(0, DRAFT_BODY_MAX) });
	}

	// Why a rule that is on did not send each pending comment draft (a source without a rule on gives no entry).
	for (const d of cf.drafts) {
		const s = cf.sources[d.source], c = byComment.get(d.commentId);
		if (!s?.src.autoSend?.on || !c) continue;
		const why = ruleRefusal(s.src, c.text, d, cf.replies, i.now);
		if (why) stops[d.code] = why;
	}
	return { failed: newest(failed).slice(0, FAILED_CAP), sent: newest(sent).slice(0, SENT_CAP), stops };
}

/** The gateway send the owner picked on this card (보내기 / 답글만 / 메일만), or undefined when he never picked one (고치기, 보내지 않기, typed words, no answer). */
export function pickedSend(d: NonNullable<NoticeLike["decision"]>): SendAction | undefined {
	const m = /^(\d+)\) (.+)$/.exec(d.answer ?? "");
	const label = m && d.options.find(o => o.n === Number(m[1]) && o.label === m[2])?.label;
	return label ? sendActionOf(label) : undefined;
}

export type RetryItem = { ref: string; to: string };
export type RetryResult = { ref: string; ok: boolean; reason?: string };
export type RetryDeps = {
	notices: NoticeLike[];
	can: (ref: string, action: SendAction) => boolean;
	enqueue: (j: SendJob) => boolean;
	/** The 보내지 않기 of draft `ref` (dropDraft / dropCommentDraft). */
	drop: (ref: string) => Promise<{ ok: boolean; reason?: string }>;
	/** A comment send of draft `ref` failed in the comment store (its record is the failure, with or without a notice). */
	commentFailed: (ref: string) => boolean;
};

// The newest card of draft `ref` that carries a gateway send (in `to` when it is named).
function cardOf(notices: NoticeLike[], to: string, ref: string) {
	return notices.filter(n => n.decision?.draft?.ref === ref && n.decision.send && (!to || n.decision.to === to)).sort((a, b) => stamp(b.decision!.send!.at) - stamp(a.decision!.send!.at))[0];
}
const valid = (x: unknown): x is RetryItem => !!x && typeof (x as RetryItem).ref === "string" && !!(x as RetryItem).ref && typeof (x as RetryItem).to === "string";

/**
 * 다시 보내기 of failed gateway sends: only a card whose recorded pick was a send and whose send failed. No approval is recorded here; the CLIs
 * (draft.ts, comments.ts send) run their own draftVerdict gate and claim, so a pick that no longer stands is refused there.
 */
export function retryFailed(items: unknown[], deps: RetryDeps): RetryResult[] {
	return items.map(x => {
		if (!valid(x)) return { ref: String((x as { ref?: unknown } | null)?.ref ?? ""), ok: false, reason: "ref와 to가 필요해요" };
		const { ref, to } = x;
		const no = (reason: string): RetryResult => ({ ref, ok: false, reason });
		if (!to || to.startsWith("lane:") || to.startsWith("auth:")) return no("다시 보낼 수 없는 대화예요");
		const card = cardOf(deps.notices, to, ref);
		const d = card?.decision;
		if (!card || !d) return no("보낸 기록이 있는 카드를 찾지 못했어요");
		if (d.send!.state !== "failed") return no("실패한 보내기만 다시 보낼 수 있어요");
		const action = pickedSend(d);
		if (!action) return no("보내기로 고른 카드가 아니라서 다시 보내지 않았어요");
		if (!deps.can(ref, action)) return no("이 초안은 더 이상 보낼 수 없어요");
		return deps.enqueue({ ref, conv: to, action, title: card.title, retry: true }) ? { ref, ok: true } : no("이 초안은 더 이상 보낼 수 없어요");
	});
}

/** 지우기 of failed sends: the draft is dropped through its own 보내지 않기, so it leaves the failed list. Only a draft whose send failed. */
export async function dropFailed(items: unknown[], deps: RetryDeps): Promise<RetryResult[]> {
	const out: RetryResult[] = [];
	for (const x of items) {
		if (!valid(x)) {
			out.push({ ref: String((x as { ref?: unknown } | null)?.ref ?? ""), ok: false, reason: "ref와 to가 필요해요" });
			continue;
		}
		const { ref, to } = x;
		const failed = cardOf(deps.notices, to, ref)?.decision?.send?.state === "failed" || deps.commentFailed(ref);
		if (!failed) {
			out.push({ ref, ok: false, reason: "실패한 보내기만 지울 수 있어요" });
			continue;
		}
		const r = await deps.drop(ref);
		out.push(r.ok ? { ref, ok: true } : { ref, ok: false, ...(r.reason ? { reason: r.reason } : {}) });
	}
	return out;
}
