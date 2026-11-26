// The drafts the owner writes himself in the mail app (web/js/30-mail-box.js: the 메일 쓰기 sheet and the reply box under an open mail):
// POST /api/mail/compose with a body and no ref makes the draft, stages his files and the gateway posts the send-approval card (hub/routes.ts).
// Nothing is sent from here: the owner's 보내기 on that card runs features/reply-drafts/bin/draft.ts send (hub/approval-send.ts), which goes
// through the same gate, claim and mailer as every other draft (features/reply-drafts/lib/flow.ts sendDraft).
import { statSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { appEntries, instanceIdOf, readAppsFile } from "./integrations.ts";
import { mailByKey, type MailRecord } from "./mail.ts";
import { instanceOf } from "./reply-model.ts";
import { dataDir, validApp, webmailSite } from "./reply-mail.ts";
import { addStagedBytes, removeStagedFile, stagedFiles, type StagedFile } from "../features/reply-drafts/lib/staged.ts";
import { addDraft, getDraft, listDrafts, newId, patchDraft, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { DATA_DIR } from "./config.ts";

const WEBMAIL = /^webmail[:/-]([a-z0-9-]+)$/;

// The mail source that sends for an instance: zele (the default, or an instance filtered to it) or a webmail-no-api site.
export function sourceOf(app: string): { source: string } | { error: string } {
	if (!validApp(app) || !instanceIdOf("mail", app)) return { error: `메일 앱 이름이 아니에요: ${app}` };
	const raw = readAppsFile(dataDir())[app];
	if (app !== "mail" && (!raw || raw.deleted || !appEntries(dataDir()).some(e => e.key === app))) return { error: `그런 메일 앱이 없어요: ${app}` };
	if (raw?.off) return { error: `${app} 앱이 꺼져 있어요` };
	const src = (raw?.filter?.source ?? "").trim().toLowerCase();
	if (!src || src === "zele") return { source: "zele" };
	const site = WEBMAIL.exec(src)?.[1] ?? webmailSite(src);
	// Any other source is a category of the one mailbox (mail-orders = `orders`, posted by a mail watch from zele threads): a new mail goes out through zele.
	return { source: site ? `webmail:${site}` : "zele" };
}

export type ManualIn = {
	/** The text he typed. Empty is refused: a draft with no body is not worth a card. */
	body?: string;
	to?: string;
	cc?: string;
	subject?: string;
	/** The mail he answers (a mail key); without it this is a new mail. */
	replyTo?: string;
	/** The mail app instance; without it the instance that owns the answered mail, else the default one. */
	app?: string;
	/** His uploads, already validated as this gateway's (hub/files.ts ownerFiles). */
	files?: { path: string; name?: string }[];
};
export type Manual = { ok: true; rec: DraftRec; app: string; attachments: StagedFile[] } | { ok: false; error: string; code: number };

const BODY_MAX = 20_000;
const RCPT_MAX = 500;
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The mail app instance a draft from the app belongs to: the one that owns the answered mail, else the default. */
export const manualApp = (mail?: MailRecord): string => {
	const key = instanceOf(appEntries(DATA_DIR), "mail", mail ? `mail:${mail.key}` : undefined);
	return key || "mail";
};

/** The mail a reply box answers: the record, so its sender, subject and account ride on the draft. */
const answered = (key: string): MailRecord | undefined => (key ? mailByKey(key) : undefined);

export function manualDraft(i: ManualIn): Manual {
	const body = text(i.body, Infinity);
	const to = text(i.to, Infinity);
	const cc = text(i.cc, Infinity);
	if (!body) return { ok: false, error: "내용을 적어 주세요", code: 400 };
	if (!to) return { ok: false, error: "받는 사람을 적어 주세요", code: 400 };
	if (body.length > BODY_MAX) return { ok: false, error: "내용이 너무 길어요. 20,000자까지 쓸 수 있어요", code: 400 };
	if (to.length > RCPT_MAX) return { ok: false, error: "받는 사람이 너무 많아요. 500자까지 적을 수 있어요", code: 400 };
	if (cc.length > RCPT_MAX) return { ok: false, error: "참조가 너무 길어요. 500자까지 적을 수 있어요", code: 400 };
	const replyTo = text(i.replyTo, 200);
	const mail = answered(replyTo);
	if (replyTo && !mail) return { ok: false, error: "이 메일을 찾지 못했어요", code: 404 };
	const app = text(i.app, 60) || manualApp(mail);
	const via = sourceOf(app);
	if ("error" in via) return { ok: false, error: via.error, code: 400 };
	const files = i.files ?? [];
	for (const f of files) {
		try {
			if (!statSync(f.path).isFile()) return { ok: false, error: `${f.name ?? f.path}을(를) 붙이지 못했어요`, code: 400 };
		} catch {
			return { ok: false, error: `${f.name ?? f.path}을(를) 찾지 못했어요`, code: 400 };
		}
	}
	const id = newId();
	// The files are staged under the draft's own id, so the approval card, the draft sheet and the send all see the same list; each keeps
	// the name he picked (an upload is stored with a timestamp in front of it). A file that cannot be copied takes the copied ones away again,
	// so nothing is left behind for a draft that was never made.
	const staged: StagedFile[] = [];
	try {
		for (const f of files) staged.push(addStagedBytes(id, f.name || basename(f.path), readFileSync(f.path)));
	} catch (error) {
		for (let n = 0; n < staged.length; n++) removeStagedFile(id, 0);
		return { ok: false, error: `첨부파일을 붙이지 못했어요: ${(error as Error).message}`, code: 400 };
	}
	const subject = text(i.subject, 300) || (mail ? `Re: ${mail.subject}` : "");
	const rec: DraftRec = {
		id,
		kind: "mail",
		app,
		// A reply answers through the mail's own source (a plugin's mail goes back through that plugin), a new mail through the app's.
		source: mail?.source ?? via.source,
		mailId: mail ? mail.id : `compose-${id}`,
		ref: mail ? mail.key : `compose-${id.toLowerCase()}`,
		...(mail ? {} : { compose: true }),
		...(mail?.account ? { account: mail.account } : {}),
		to,
		...(cc ? { cc: [cc] } : {}),
		...(subject ? { subject } : {}),
		body,
		status: "pending",
		created: new Date().toISOString(),
		changes: [],
		questions: [],
		item: { kind: "mail", app, from: mail?.from ?? "", text: "" },
	};
	addDraft(rec);
	return { ok: true, rec, app, attachments: stagedFiles(rec.id) };
}

/** The reply draft of received mail `key` a session writes (hub/mail-cli.ts reply): the pending reply draft of that mail takes the new text as its next version, so asking
 * again is the same draft and never a second; else a new one as the owner's reply box makes it (to the sender, `Re:` subject, the mail's own source). */
export function replyDraft(key: string, d: { body: string; to?: string; cc?: string; subject?: string }): Manual {
	const mail = answered(key);
	if (!mail) return { ok: false, error: "이 메일을 찾지 못했어요", code: 404 };
	const pending = listDrafts().find(x => x.ref === key && x.status === "pending" && !x.compose);
	if (!pending) return manualDraft({ replyTo: key, body: d.body, to: d.to || mail.replyTo || mail.from, ...(d.cc ? { cc: d.cc } : {}), ...(d.subject ? { subject: d.subject } : {}) });
	const body = text(d.body, Infinity);
	if (!body) return { ok: false, error: "내용을 적어 주세요", code: 400 };
	if (body.length > BODY_MAX) return { ok: false, error: "내용이 너무 길어요. 20,000자까지 쓸 수 있어요", code: 400 };
	patchDraft(pending.id, { body, ...(d.to ? { to: d.to } : {}), ...(d.cc ? { cc: [d.cc] } : {}), ...(d.subject ? { subject: d.subject } : {}) });
	const rec = getDraft(pending.id)!;
	return { ok: true, rec, app: rec.app, attachments: stagedFiles(rec.id) };
}
