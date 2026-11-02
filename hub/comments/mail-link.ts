// The real MailLink of the comment engine (engine.ts): the mail that rides on a comment reply is a compose draft of hub/mail-cli.ts, sent and
// revised through the same reply-drafts flow, so its lint, files and sender are the ones of every other mail. It is not listed in the web mail
// app on its own (the card of the comment reply is the one place to approve it).
import { dropDraft, reviseDraft, sendDraft, type FlowDeps } from "../../features/reply-drafts/lib/flow.ts";
import { getDraft } from "../../features/reply-drafts/lib/store.ts";
import { addressesOf } from "../reply-draft.ts";
import { composeMail } from "../mail-cli.ts";
import type { MailLink, MailSpec, MailView } from "./engine.ts";
import { mailViewOf } from "./linked.ts";

/** What composing the mail said beyond its id: `notes` are the owner-facing warnings (composeMail's), `libraryMiss` = the 첨부 파일 폴더 held no file that fits. The comment card shows them. */
export type MailComposed = { ok: true; id: string; notes: string[]; libraryMiss?: boolean } | { ok: false; reason: string };
/** The mail part of a comment card, with the same notes (a missing file is a warning the owner reads before approving). */
export type MailViewNotes = MailView & { notes?: string[] };
export type RealMailLink = Omit<MailLink, "compose" | "view"> & { compose: (spec: MailSpec) => Promise<MailComposed>; view: (id: string) => MailViewNotes | undefined };
const LIBRARY_MISS_NOTE = "확인: 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요";

export function realMailLink(deps: FlowDeps = {}): RealMailLink {
	return {
		async compose(spec) {
			const to = addressesOf(spec.to);
			if (!to.length) return { ok: false, reason: "메일 받는이 주소가 없어요" };
			if (!spec.subject.trim() || !spec.body.trim()) return { ok: false, reason: "메일 제목과 본문이 필요해요" };
			const r = await composeMail({ app: spec.app, to, subject: spec.subject.trim(), body: spec.body.trim(), ...(spec.attach?.length ? { attach: spec.attach } : {}), ...(spec.fromLibrary ? { fromLibrary: spec.fromLibrary } : {}), ...(spec.library ? { library: spec.library } : {}), notify: false }, deps);
			return r.ok ? { ok: true, id: r.rec.id, notes: r.notes, ...(r.rec.libraryMiss ? { libraryMiss: true } : {}) } : { ok: false, reason: r.error };
		},
		state: id => getDraft(id)?.status,
		send: async id => {
			const r = await sendDraft(id, deps, { withReply: true });
			return { ok: r.ok, text: r.text };
		},
		drop: id => void dropDraft(id),
		async revise(id, change) {
			const r = await reviseDraft(id, change, deps);
			return r.ok && r.id ? { ok: true, id: r.id } : { ok: false, reason: r.text };
		},
		view: id => {
			const v = mailViewOf(id);
			return v && (v.libraryMiss ? { ...v, notes: [LIBRARY_MISS_NOTE] } : v);
		},
	};
}
