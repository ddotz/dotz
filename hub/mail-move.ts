// Moving a stored mail to another mail app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BODY_FILE, deleteMail, insideMailFiles, MAIL_FILES, mailByKey, MailError, type MailDeps, type MailResult, postMail, recordMail, storedBodyText } from "./mail.ts";

/**
 * Refiles a stored mail under another source (POST /api/mail/move): a mail's app is fixed when it is posted, so a filing rule fixed later leaves the
 * mails it got wrong where they are. It is posted again under the new source, so it gets its conversation and draft there, keeps its reply state, and
 * the old key stays deleted, so a repost of the watch does not bring it back.
 */
export async function moveMail(key: string, source: string, deps: MailDeps): Promise<MailResult> {
	const r = mailByKey(key);
	if (!r) throw new MailError(`no mail ${key}`, 404);
	const page = r.html ? insideMailFiles(BODY_FILE(key)) : undefined;
	const moved = await postMail({ source, id: r.id, subject: r.subject, from: r.from, to: r.to, cc: r.cc, account: r.account, at: r.at, messageId: r.msg, summary: r.summary, body: storedBodyText(key) ?? r.preview, ...(page ? { html: readFileSync(page, "utf8") } : {}), attachments: r.attachments?.map(a => ({ name: a.name, type: a.type, path: join(MAIL_FILES, a.file), ...(a.cid ? { cid: a.cid } : {}) })) }, deps);
	if (moved.skipped || moved.duplicate) throw new MailError(`${moved.key} is already there`, 409);
	const now = mailByKey(moved.key);
	if (now && r.reply) recordMail({ ...now, reply: r.reply, ...(r.sentAt ? { sentAt: r.sentAt } : {}), ...(r.reply_by ? { reply_by: r.reply_by, reply_at: r.reply_at } : {}) });
	deleteMail(key);
	return moved;
}

/** POST /api/mail/move { key, source }. */
export async function moveMailRoute(b: unknown, deps: MailDeps): Promise<Response> {
	const { key, source } = (b ?? {}) as { key?: unknown; source?: unknown };
	if (typeof key !== "string" || typeof source !== "string" || !source.trim()) return Response.json({ error: "key and source are required" }, { status: 400 });
	try {
		return Response.json(await moveMail(key, source.trim(), deps));
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: error instanceof MailError ? error.status : 500 });
	}
}
