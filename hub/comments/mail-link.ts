// The real MailLink of the comment engine (engine.ts): the mail that rides on a comment reply is a compose draft of hub/mail-cli.ts, sent and
// revised through the same reply-drafts flow, so its lint, files and sender are the ones of every other mail. It is not listed in the web mail
// app on its own (the card of the comment reply is the one place to approve it).
import { dropDraft, reviseDraft, sendDraft, type FlowDeps } from "../../features/reply-drafts/lib/flow.ts";
import { addressesOf } from "../reply-draft.ts";
import { composeMail } from "../mail-cli.ts";
import type { MailLink } from "./engine.ts";
import { mailViewOf } from "./linked.ts";

export function realMailLink(deps: FlowDeps = {}): MailLink {
	return {
		async compose(spec) {
			const to = addressesOf(spec.to);
			if (!to.length) return { ok: false, reason: "메일 받는이 주소가 없어요" };
			if (!spec.subject.trim() || !spec.body.trim()) return { ok: false, reason: "메일 제목과 본문이 필요해요" };
			const r = await composeMail({ app: spec.app, to, subject: spec.subject.trim(), body: spec.body.trim(), ...(spec.attach?.length ? { attach: spec.attach } : {}), ...(spec.fromLibrary ? { fromLibrary: spec.fromLibrary } : {}), notify: false }, deps);
			return r.ok ? { ok: true, id: r.rec.id } : { ok: false, reason: r.error };
		},
		send: async id => {
			const r = await sendDraft(id, deps, { withReply: true });
			return { ok: r.ok, text: r.text };
		},
		drop: id => void dropDraft(id),
		async revise(id, change) {
			const r = await reviseDraft(id, change, deps);
			return r.ok && r.id ? { ok: true, id: r.id } : { ok: false, reason: r.text };
		},
		view: mailViewOf,
	};
}
