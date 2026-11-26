// The real MailLink of the comment engine (engine.ts): the mail that rides on a comment reply is a compose draft of hub/mail-cli.ts, sent and
// revised through the same reply-drafts flow, so its lint, files and sender are the ones of every other mail. It is not listed in the web mail
// app on its own (the card of the comment reply is the one place to approve it).
import { accountHold, draftAttachIssues, draftLintFailures, dropDraft, editDraft, withRecipient, mailStyleOf, realRunner, reviseDraft, sendAccountOf, sendDraft, type FlowDeps } from "../../features/reply-drafts/lib/flow.ts";
import { getDraft, listDrafts, patchDraft } from "../../features/reply-drafts/lib/store.ts";
import { addressesOf, generateReply } from "../reply-draft.ts";
import { callReplyModel } from "../reply-model.ts";
import { composeMail } from "../mail-cli.ts";
import type { MailLink, MailSpec, MailView, MailWrite } from "./engine.ts";
import { mailRecordOf, mailViewOf } from "./linked.ts";

/** What composing the mail said beyond its id: `notes` are the owner-facing warnings (composeMail's), `libraryMiss` = the 첨부 파일 폴더 held no file that fits. The comment card shows them. */
export type MailComposed = { ok: true; id: string; notes: string[]; libraryMiss?: boolean } | { ok: false; reason: string };
export type RealMailLink = Omit<MailLink, "compose" | "view"> & { compose: (spec: MailSpec) => Promise<MailComposed>; view: (id: string) => MailView | undefined };
const LIBRARY_MISS_NOTE = "확인: 첨부 파일 폴더에서 맞는 파일을 찾지 못했어요";
const INSTRUCTION = "This message is a request for material. The requested material goes by this mail: write the mail that sends it (the files ride on it), not a reply that asks anything back. What is asked for is the work of the post (the context): never ask which song or file is meant.";

/** The mail text in the owner's voice (the profile the source's mail app reads and the recipient's own conditions, as the mail's lint reads them: mailStyleOf), by the reply model of that mail app; undefined = no profile yet or the model skipped. A failed model call throws. */
export async function writeMail(spec: MailWrite): Promise<string | undefined> {
	const style = mailStyleOf(spec.app, spec.text, spec.to);
	if (!style) return undefined;
	const item = { kind: "mail" as const, app: spec.app, from: spec.to, text: spec.text, instruction: INSTRUCTION, ...(spec.postTitle ? { context: spec.postTitle } : {}) };
	const r = await generateReply(item, style, async (system, user) => (await callReplyModel(spec.app, undefined, system, user)).text);
	return r.action === "draft" ? r.draft.body.trim() || undefined : undefined;
}

function withAccount(v: MailView | undefined): MailView | undefined {
	const rec = v && getDraft(v.id);
	const from = rec ? sendAccountOf(rec) : {};
	return v && { ...v, ...(from.account ? { account: from.account } : {}), ...(from.held ? { accountHeld: true as const } : {}) };
}

export function realMailLink(deps: FlowDeps = { run: realRunner }): RealMailLink {
	return {
		write: writeMail,
		async compose(spec) {
			const to = addressesOf(spec.to);
			if (!to.length) return { ok: false, reason: "메일 받는이 주소가 없어요" };
			if (!spec.subject.trim() || !spec.body.trim()) return { ok: false, reason: "메일 제목과 본문이 필요해요" };
			const r = await composeMail({ app: spec.app, to, subject: spec.subject.trim(), body: spec.body.trim(), ...(spec.attach?.length ? { attach: spec.attach } : {}), ...(spec.fromLibrary ? { fromLibrary: spec.fromLibrary } : {}), ...(spec.request ? { request: spec.request } : {}), notify: false }, deps);
			return r.ok ? { ok: true, id: r.rec.id, notes: r.notes, ...(r.rec.libraryMiss ? { libraryMiss: true } : {}) } : { ok: false, reason: r.error };
		},
		state: id => getDraft(id)?.status,
		record: id => withAccount(mailRecordOf(id)),
		pendingFor: commentId => listDrafts().find(d => d.compose && d.status === "pending" && d.origin?.kind === "comment" && d.origin.id === commentId)?.id,
		send: async (id, opts) => {
			const r = await sendDraft(id, deps, { withReply: true, learn: false, ...(opts?.asIs ? { asIs: true as const } : {}), ...(opts?.retry ? { retry: true as const } : {}) });
			return { ok: r.ok, text: r.text };
		},
		issues: id => {
			const rec = getDraft(id);
			return rec ? draftAttachIssues(rec) : [];
		},
		lint: id => {
			const rec = getDraft(id);
			const hold = rec && accountHold(rec);
			return rec ? [...draftLintFailures(withRecipient(rec)), ...(hold ? [hold] : [])] : [];
		},
		drop: id => void dropDraft(id),
		retarget: (id, to) => {
			if (getDraft(id)?.status === "pending") patchDraft(id, { to });
		},
		edit: (id, text, subject) => {
			const r = editDraft(id, text, subject);
			return r.ok ? { ok: true } : { ok: false, reason: r.text, ...(r.code ? { code: r.code } : {}), ...(r.lint ? { lint: r.lint } : {}) };
		},
		async revise(id, change) {
			const r = await reviseDraft(id, change, deps, { learn: false });
			if (!r.ok || !r.id) return { ok: false, reason: r.text };
			const lesson = r.lesson && { key: r.lesson.key, line: r.lesson.line, forbid: r.lesson.forbid, evidence: r.lesson.evidence };
			return { ok: true, id: r.id, ...(lesson ? { lesson } : {}) };
		},
		view: id => {
			const v = mailViewOf(id), rec = v && getDraft(id), issues = rec ? draftAttachIssues(rec) : [];
			const shown = withAccount(v && (issues.length ? { ...v, attachIssues: issues } : v));
			const hold = rec && accountHold(rec);
			const notes = [...(shown?.libraryMiss ? [LIBRARY_MISS_NOTE] : []), ...(hold ? [`확인: ${hold}`] : [])];
			return shown && (notes.length ? { ...shown, notes } : shown);
		},
	};
}
