// The comment adapter of the one reply flow (the reply unification design, 1.8 column 3): the engine's drafts (YouTube, Instagram, site
// comments and site DMs) as the one view, and its revise, direct edit, drop, restore and read-back behind the adapter interface.
import { reasonOf } from "../reply-reasons.ts";
import type { DraftView, ReasonCode, ReplyAdapter } from "../reply-types.ts";
import { commentAsk } from "./ask.ts";
import type { Engine } from "./engine.ts";
import type { Draft } from "./store.ts";

const STATE: Record<string, DraftView["draft"]["state"]> = { pending: "pending", dropped: "dropped", stale: "stale", sent: "sent", answered: "closed" };
const question = (d: Draft | undefined) => (d?.mail ? "이 답글을 올리고 메일도 보낼까요?" : "이 답글 올릴까요?");

export function commentAdapter(engine: Engine): ReplyAdapter {
	// By the store, not the ref's shape: older and seeded codes do not all follow D + 6.
	const draftOf = (ref: string): Draft | undefined => engine.store.drafts().find(d => d.code === ref);
	const viewOf = (d: Draft): DraftView | undefined => {
		const src = engine.store.config().sources[d.source];
		const c = engine.store.comments().find(x => x.id === d.commentId);
		if (!src || !c) return undefined;
		const pending = d.status === "pending";
		const mail = engine.mailView(d);
		const before = d.replaces ? draftOf(d.replaces) : undefined;
		return {
			item: `comment:${d.commentId}`,
			ref: d.code,
			kind: "comment",
			app: engine.ownerOf(src),
			label: src.label,
			conv: `comment:${d.source}`,
			at: d.created,
			can: { send: pending, revise: pending, edit: pending, drop: pending, restore: d.status === "dropped" && !d.mail },
			draft: {
				state: STATE[d.status] ?? "closed",
				toLabel: "대상",
				to: `${c.author} 댓글`,
				text: d.text,
				...(d.notes.length ? { notes: d.notes } : {}),
				...(mail ? { mail: { ref: mail.id, to: mail.to, ...(mail.subject ? { subject: mail.subject } : {}), text: mail.body } } : {}),
				...(before ? { replaces: { ref: before.code, text: before.text } } : {}),
				...(d.editedFrom !== undefined ? { edited: true as const } : {}),
			},
			original: { who: c.author, text: c.text, at: c.at, ...(c.postTitle ? { post: c.postTitle } : {}) },
		};
	};
	const reason = (text: string | undefined, code: ReasonCode = "not_pending") => ({ code, text: text ?? reasonOf(code).text });
	const done = (r: { ok: boolean; reason?: string }) => (r.ok ? { ok: true as const } : { ok: false as const, reason: reason(r.reason) });

	return {
		kind: "comment",
		get: async ref => {
			const d = draftOf(ref);
			return d ? viewOf(d) : undefined;
		},
		list: async () => engine.store.drafts().filter(d => d.status === "pending").flatMap(d => viewOf(d) ?? []),
		target: ref => {
			const d = draftOf(ref);
			return d ? { kind: "comment", lane: `comment:${d.source}` } : undefined;
		},
		revise: async (ref, change, part) => {
			const r = await engine.revise(ref, change, part ?? "reply", false, { learn: false });
			if (!r.ok) return { ok: false, reason: reason(r.reason, "revise_failed") };
			const src = engine.store.config().sources[r.draft.source];
			return { ok: true, ref: r.draft.code, replaces: ref, ...(r.lesson && src ? { lesson: { key: { app: src.key }, line: r.lesson } } : {}) };
		},
		edit: async (ref, text, part) => {
			const r = engine.edit(ref, text, part ?? "reply");
			return r.ok ? { ok: true } : { ok: false, reason: reason(r.reason, (r.code as ReasonCode | undefined) ?? "not_pending"), ...(r.lint ? { lint: r.lint } : {}) };
		},
		drop: async ref => done(engine.drop(ref)),
		restore: async ref => done(engine.restore(ref)),
		markSent: async ref => {
			const r = engine.store.replies().filter(x => x.draft === ref).at(-1);
			if (r?.state === "unsure") return done(engine.markPosted(r.id));
			if (draftOf(ref)?.status !== "pending") return { ok: false, reason: reasonOf("gone") };
			engine.store.setDraftStatus(ref, "sent");
			return { ok: true };
		},
		// Proof read back from the platform: only an unsure reply whose words show there becomes sent.
		prove: async ref => {
			if (draftOf(ref)?.status === "sent") return "sent";
			await engine.proveSends();
			return draftOf(ref)?.status === "sent" ? "sent" : "unknown";
		},
		learned: async ref => engine.learned(ref),
		ask: async (ref, headline) => {
			const d = draftOf(ref);
			const src = d && engine.store.config().sources[d.source];
			const c = d && engine.store.comments().find(x => x.id === d.commentId);
			if (!d || !src || !c) return undefined;
			const mail = engine.mailView(d);
			return commentAsk(src, c, d, headline, mail ? { to: mail.to, ...(mail.subject ? { subject: mail.subject } : {}), body: mail.body, id: mail.id, ...(mail.notes ? { notes: mail.notes } : {}) } : undefined);
		},
		question: ref => `${question(draftOf(ref))} (${ref})`,
	};
}
