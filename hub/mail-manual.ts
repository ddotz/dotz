// The drafts the owner writes himself in the mail app (web/js/30-mail-box.js: the 메일 쓰기 sheet and the reply box under an open mail):
// POST /api/mail/compose with a body and no ref makes the draft, stages his files and the gateway posts the send-approval card (hub/routes.ts).
// Nothing is sent from here: the owner's 보내기 on that card runs features/reply-drafts/bin/draft.ts send (hub/approval-send.ts), which goes
// through the same gate, claim and mailer as every other draft (features/reply-drafts/lib/flow.ts sendDraft).
import { statSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { appEntries } from "./integrations.ts";
import { sourceOf } from "./mail-cli.ts";
import { mailByKey, type MailRecord } from "./mail.ts";
import { instanceOf } from "./reply-model.ts";
import { addStagedBytes, stagedFiles, type StagedFile } from "../features/reply-drafts/lib/staged.ts";
import { addDraft, newId, type DraftRec } from "../features/reply-drafts/lib/store.ts";
import { DATA_DIR } from "./config.ts";

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

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The mail app instance a draft from the app belongs to: the one that owns the answered mail, else the default. */
export const manualApp = (mail?: MailRecord): string => {
	const key = instanceOf(appEntries(DATA_DIR), "mail", mail ? `mail:${mail.key}` : undefined);
	return key || "mail";
};

/** The mail a reply box answers: the record, so its sender, subject and account ride on the draft. */
const answered = (key: string): MailRecord | undefined => (key ? mailByKey(key) : undefined);

export function manualDraft(i: ManualIn): Manual {
	const body = text(i.body, 20_000);
	const to = text(i.to, 500);
	if (!body) return { ok: false, error: "내용을 적어 주세요", code: 400 };
	if (!to) return { ok: false, error: "받는 사람을 적어 주세요", code: 400 };
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
	// the name he picked (an upload is stored with a timestamp in front of it).
	const staged: StagedFile[] = [];
	for (const f of files) staged.push(addStagedBytes(id, f.name || basename(f.path), readFileSync(f.path)));
	const subject = text(i.subject, 300) || (mail ? `Re: ${mail.subject}` : "");
	const cc = text(i.cc, 500);
	const rec: DraftRec = {
		id,
		kind: "mail",
		app,
		source: via.source,
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
