// HTTP routes of mail: the conversation list, a mail's files, marks, actions, delete, draft request and body, composing / posting / syncing mails, and the mail helpers they share with the gateway (mailSyncDeps, applyMailStates).
// Split out of routes.ts, called there at the same place of the chain; routeMail answers undefined for every path that is not its own.
import { DATA_DIR, log } from "./config.ts";
import { msg } from "./i18n.ts";
import * as discord from "./discord.ts";
import { conversationList } from "./conversations.ts";
import { readAppOff } from "./integrations.ts";
import { conversationPage } from "./conversations-page.ts";
import { lazyMailCard } from "./conversations-mail-card.ts";
import { markRead, markUnread } from "./reads.ts";
import { broadcast } from "./events.ts";
import { askedFile, draftAttachRoute } from "./draft-attach.ts";
import { parseFollowup, triggerFollowup } from "./followup.ts";
import { draftFileRoute } from "./draft-files.ts";
import { draftRecipientsRoute } from "./draft-recipients.ts";
import { stagedFiles } from "../features/reply-drafts/lib/staged.ts";
import { composeMail, deleteMail, mailTargets, sentReplyRefs, unrepliedMails, mailKey, recordSentByDotz, MailError, syncMailStates, type MailSourceState, mailBodyRoute, settleMailDrafts, mailStateOf, mailByKey, mailFileRoute, mailTarget, postMail, setMailFyi, setMailNoReply, setMailsFyi, mailKeep, setMailSuggest, setMailReply, type MailDeps } from "./mail.ts";
import { moveMailRoute } from "./mail-move.ts";
import { applyMailboxFlags, isMailAction, mailAction, mailActions, spawnExec, type SyncDeps } from "./mail-sync.ts";
import { originalDeleteRoute, originalDeps } from "./mail-delete.ts";
import { manualDraft } from "./mail-manual.ts";
import { askText } from "../features/reply-drafts/lib/flow.ts";
import { pluginMailAction, pluginMailActions } from "./plugins.ts";
import { webmailSite } from "../features/reply-drafts/lib/senders.ts";
import { getDraft, holdDrafts, holdDraftsOf, listDrafts, restoreDrafts, restoreDraftsOf } from "../features/reply-drafts/lib/store.ts";
import { FileError, ownerFiles } from "./files.ts";
import { liveLanes } from "./lanes.ts";
import { settleHandledDrafts, readConversationNotices, reopenDraftNotices } from "./notices.ts";
import { out } from "./outbound.ts";
import { json, body, BodyError } from "./routes-util.ts";

// The pending reply drafts of one mail are dropped (the same store step as 보내지 않기) and their approval cards settled at once.
const dropMailDrafts = async (key: string) => {
	const pending = listDrafts().filter(d => d.ref === key && (d.status === "pending" || d.status === "held"));
	if (pending.length) {
		const { dropDraft } = await import("../features/reply-drafts/lib/flow.ts");
		for (const d of pending) { const r = dropDraft(d.id); if (!r.ok) log(`draft ${d.id}: not dropped with its mail: ${r.text}`); }
	}
	await settleHandledDrafts().catch(e => log(`mail ${key}: handled-draft settle failed: ${(e as Error).message}`));
};
/** 삭제 / 휴지통 on a mail: it leaves dotz (record, list entry, counts, its notices and pending drafts); the real mailbox is not touched here. */
const removeMailLocal = async (key: string): Promise<boolean> => {
	if (!deleteMail(key)) return false;
	await dropMailDrafts(key);
	readConversationNotices(mailTarget(key), new Date().toISOString());
	broadcast({ kind: "mail_unreplied", target: mailTarget(key) });
	return true;
};
/** hub/mail-sync.ts wired to the real parts: zele and plugins for the mailbox, the read position, deleting. */
export const mailSyncDeps: SyncDeps = {
	exec: spawnExec,
	plugin: pluginMailAction,
	pluginCan: pluginMailActions,
	webmail: s => !!webmailSite(s),
	setRead: (target, ts, direction) => {
		if (direction === "read") {
			const x = markRead({ target, ts });
			if (x.ok) readConversationNotices(x.target, x.ts);
		} else markUnread({ target, ts });
		broadcast({ kind: "mail_unreplied", target });
	},
	remove: removeMailLocal,
	changed: key => broadcast({ kind: "mail_unreplied", target: mailTarget(key) }),
	log,
};
export const mailOriginal = originalDeps(DATA_DIR, mailSyncDeps);
const keyOfSource = (source: string, id: string): string | undefined => {
	try {
		return mailKey(source, id);
	} catch {
		return undefined;
	}
};

// POST /api/mail/compose without a ref: the draft he wrote in the mail app (web/js/30-mail-box.js), its uploads staged for it, and the
// send-approval card posted to the conversation of the mail it answers (or the new mail's own row gains one). Nothing is sent here.
async function draftFromApp(b: Record<string, unknown>, deps: MailDeps): Promise<Response> {
	let files: { path: string; name: string }[];
	try {
		files = ownerFiles(b.attachments).map(f => ({ path: f.path, name: f.original ?? f.name }));
	} catch (error) {
		return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
	}
	const made = manualDraft({
		body: b.body as string | undefined,
		to: b.to as string | undefined,
		cc: b.cc as string | undefined,
		subject: b.subject as string | undefined,
		replyTo: b.reply_to as string | undefined,
		app: b.app as string | undefined,
		files,
	});
	if (!made.ok) return json({ error: made.error }, made.code);
	const { rec } = made;
	// A new mail is listed like any other draft of the app (hub/mail.ts composeMail); a reply rides on the mail it answers.
	const key = rec.compose ? composeMail({ ref: rec.id, source: rec.source, app: made.app, to: rec.to, subject: rec.subject ?? "" }, deps).key : rec.ref;
	if (!rec.compose) setMailSuggest(rec.ref, { kind: "reply-draft", label: "메일 초안", ref: rec.id });
	await out(mailTarget(key), askText(rec, []));
	return json({ ok: true, key, ref: rec.id, files: made.attachments.map(f => ({ name: f.name, size: f.size })) });
}

/** A mailbox's read / replied state of its mails (POST /api/mail/state, the zele poll in hub/main.ts): read in dotz once read there (its bell items
 *  too, as when he opens it here), 답장함 once answered there; every device redraws the mails that changed. Returns how many changed. */
export async function applyMailStates(source: string, items: readonly MailSourceState[]): Promise<number> {
	const changed = syncMailStates(source, items, (target, ts) => {
		const r = markRead({ target, ts });
		if (r.ok) readConversationNotices(r.target, r.ts);
		return r.ok && r.moved;
	});
	// Then what changed in the mailbox since its last report: unread / starred / archived / trashed (hub/mail-sync.ts applyMailboxFlags).
	const flags = await applyMailboxFlags(source, items, { ...mailSyncDeps, keyOf: keyOfSource });
	for (const target of new Set([...changed, ...flags])) broadcast({ kind: "mail_unreplied", target });
	return new Set([...changed, ...flags]).size;
}
const parseMailStates = (raw: unknown): { source: string; items: MailSourceState[] } | undefined => {
	const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	if (typeof b.source !== "string" || !b.source.trim() || !Array.isArray(b.items)) return undefined;
	const items = b.items.slice(0, 2000).flatMap(x => {
		const i = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
		return typeof i.id === "string" && i.id ? [{ id: i.id.slice(0, 200), ...(typeof i.read === "boolean" ? { read: i.read } : {}), ...(typeof i.unread === "boolean" ? { unread: i.unread } : {}), ...(i.replied === true ? { replied: true } : {}), ...(typeof i.archived === "boolean" ? { archived: i.archived } : {}), ...(i.trashed === true ? { trashed: true } : {}), ...(typeof i.starred === "boolean" ? { starred: i.starred } : {}) }] : [];
	});
	return { source: b.source.trim().slice(0, 60), items };
};

// The sent reply refs and the mails still waiting for a reply: the lists the apps routes (routes-apps.ts) and the conversation list both read.
export const sentMailRefs = () => sentReplyRefs(listDrafts());
export const unrepliedMailList = () => unrepliedMails(sentMailRefs());
export type MailRouteDeps = { peer: string; mailDeps?: () => MailDeps; mailReconcile?: (limit: number) => Promise<{ checked: number; replied: number; notChecked: number; skipped: number }> };
// /api/conversations, a mail's files / marks / actions / delete / draft request / body, a draft's files, /api/followup and the routes that write mail in (compose, reconcile, state, post, move).
export async function routeMail(req: Request, url: URL, { peer, mailDeps, mailReconcile }: MailRouteDeps): Promise<Response | undefined> {
	if (req.method === "GET" && url.pathname === "/api/conversations") {
		settleMailDrafts(listDrafts());   // a dropped draft takes its 초안 있음 off before the rows are drawn
		const owed = new Set(unrepliedMailList().map(m => m.key)), sent = sentMailRefs();
		// Ended sessions are listed too: 답변 필요 stays on their row (their unread is 0, conversations.ts unreadOf) in the folded 끝난 세션 group (web/js/04-state.js endedGroup).
		// A mail conversation is listed only while its mail is: a deleted mail (mail-deleted.json) keeps its log but leaves every list and count here and on the other computer (hub/peer-monitor.ts).
		const lv = liveLanes();   // the page is decided from the cheap fields of a mail; its full card is built only for the rows that go out (conversationPage `build`)
		const items = conversationList([...[...lv.live, ...lv.ended].map(n => `lane:${n}`), ...Object.keys(discord.channels.work).map(id => `ch:${id}`), ...mailTargets()]).flatMap(c => {
			if (!c.target.startsWith("mail:")) return [c];
			const m = mailByKey(c.target.slice(5));
			return m ? [{ ...c, mail: { ...mailStateOf(m, sent.has(m.key)), read: c.unread === 0, ...(m.archived ? { archived: true as const } : {}), source: m.source, ...(owed.has(m.key) ? { unreplied: true as const } : {}) } }] : [];
		});
		const page = conversationPage(items, url.searchParams, lazyMailCard({ owed, sent, dataDir: DATA_DIR, syncDeps: mailSyncDeps })); return json(page.body, page.status);
	}
	// One attached file of a mail: only files the mail's own record names, only inside the mail files folder (hub/mail.ts).
	const mailFile = (req.method === "GET" || req.method === "HEAD") && /^\/api\/mail\/([a-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
	if (mailFile) return mailFileRoute(req, url, mailFile[1]!, mailFile[2]!);
	// One file a draft sends along (the `> 첨부:` lines of a send approval): only files staged for that draft (hub/draft-files.ts).
	const draftFile = (req.method === "GET" || req.method === "HEAD") && /^\/api\/drafts\/([A-Za-z0-9._-]+)\/files\/(\d+)$/.exec(url.pathname);
	if (draftFile) return draftFileRoute(req, url, draftFile[1]!, draftFile[2]!, undefined, askedFile);
	// Add or remove a file of a mail reply draft, and the 첨부 파일 폴더 listing (hub/draft-attach.ts).
	const draftAttach = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/(files|library|original)$/.exec(url.pathname);
	if (draftAttach) return draftAttachRoute(req, url, draftAttach[1]!, draftAttach[2]!);
	// 답장 | 전체 답장 and the 받는 사람·참조 of a waiting mail draft (hub/draft-recipients.ts).
	const draftRecipients = /^\/api\/drafts\/([A-Za-z0-9._-]+)\/recipients$/.exec(url.pathname);
	if (draftRecipients) return draftRecipientsRoute(req, draftRecipients[1]!);
	// 답장 안 함 (no-reply = skipped, fyi; one label to the owner) on a mail (POST) or 답장 필요로 표시 (DELETE): the owner's mark that this mail needs no reply (hub/mail-state.ts).
	// Its reply draft waiting for approval is held in the drafts store (not dropped) and its card leaves 확인 대기 before the answer; taking the
	// mark back restores the newest held draft and reopens its card. A peer's 되돌리기 arrives here too (hub/peer-monitor.ts act fyi / no-reply).
	const mailNoReply = (req.method === "POST" || req.method === "DELETE") && /^\/api\/mail\/([a-z0-9._-]+)\/(no-reply|fyi)$/.exec(url.pathname);
	if (mailNoReply) {
		const key = mailNoReply[1]!;
		if (!(mailNoReply[2] === "fyi" ? setMailFyi : setMailNoReply)(key, req.method === "POST")) return json({ error: "이 메일을 찾지 못했어요" }, 404);
		if (req.method === "POST") {
			holdDrafts(key);
			await settleHandledDrafts().catch(e => log(`mail ${key}: handled-draft settle failed: ${(e as Error).message}`));
		} else {
			const back = restoreDrafts(key);
			if (back) reopenDraftNotices([back]);
		}
		broadcast({ kind: "mail_unreplied", target: mailTarget(key) });
		return json({ ok: true });
	}
	// The same marks on many mails, {keys, on}: one write of each store and one broadcast (open pages only reload on it, the target is not read), however many mails.
	if (req.method === "POST" && url.pathname === "/api/mail/fyi") {
		const b = await body(req).catch(error => { if (error instanceof BodyError) throw error; return {}; }) as { keys?: unknown; on?: unknown };
		if (typeof b.on !== "boolean") return json({ error: "on must be true or false" }, 400);
		if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > mailKeep() || b.keys.some(k => typeof k !== "string" || !/^[a-z0-9._-]+$/.test(k))) return json({ error: "keys must be an array of mail keys" }, 400);
		const keys = [...new Set(b.keys as string[])], found = new Set(setMailsFyi(keys, b.on));
		if (b.on) {
			holdDraftsOf(found);
			await settleHandledDrafts().catch(e => log(`mail batch: handled-draft settle failed: ${(e as Error).message}`));
		} else reopenDraftNotices(restoreDraftsOf(found));
		if (found.size) broadcast({ kind: "mail_unreplied", target: mailTarget(found.values().next().value!) });
		return json({ ok: true, results: keys.map(key => ({ key, ok: found.has(key) })) });
	}
	if (req.method === "POST" && url.pathname === "/api/mail/delete-original") return originalDeleteRoute(req, peer, await body(req), mailOriginal);   // the owner's 삭제 with the switch on
	// 읽음 / 안 읽음 / 보관 / 별표 on a mail: dotz changes at once and the real mailbox follows; 휴지통 stays in dotz (hub/mail-sync.ts has the contract).
	if (req.method === "POST" && url.pathname === "/api/mail/actions") {
		const b = await body(req).catch(error => { if (error instanceof BodyError) throw error; return {}; }) as { keys?: unknown; action?: unknown };
		if (!isMailAction(b.action)) return json({ error: "action must be read, unread, archive, unarchive, trash, star or unstar" }, 400);
		if (!Array.isArray(b.keys) || b.keys.some(k => typeof k !== "string")) return json({ error: "keys must be an array of mail keys" }, 400);
		return json({ ok: true, results: await mailActions((b.keys as string[]).slice(0, 200), b.action, mailSyncDeps) });
	}
	const mailActOne = req.method === "POST" && /^\/api\/mail\/([a-z0-9._-]+)\/action$/.exec(url.pathname);
	if (mailActOne) {
		const b = await body(req).catch(error => { if (error instanceof BodyError) throw error; return {}; }) as { action?: unknown };
		if (!isMailAction(b.action)) return json({ error: "action must be read, unread, archive, unarchive, trash, star or unstar" }, 400);
		const res = await mailAction(mailActOne[1]!, b.action, mailSyncDeps);
		return res.ok ? json(res) : json({ error: res.note }, 404);
	}
	// 삭제 on a mail card: the mail leaves dotz (record, list entry, counts, its notices and pending drafts); the real mailbox is not touched.
	const mailDelete = req.method === "DELETE" && /^\/api\/mail\/([a-z0-9._-]+)$/.exec(url.pathname);
	if (mailDelete) {
		if (!(await removeMailLocal(mailDelete[1]!))) return json({ error: "이 메일을 찾지 못했어요" }, 404);
		return json({ ok: true });
	}
	// 초안 작성 on a mail: the owner asks for a reply draft himself. It is made behind the request (a model call takes a while, and a peer's
	// forwarded act has a short timeout); the draft lands as the send-approval card in the mail's conversation, a failure as a line there.
	const mailDraft = req.method === "POST" && /^\/api\/mail\/([a-z0-9._-]+)\/draft$/.exec(url.pathname);
	if (mailDraft) {
		const key = mailDraft[1]!, r = mailByKey(key), deps = mailDeps?.();
		if (!r || r.dir === "out") return json({ error: "이 메일을 찾지 못했어요" }, 404);
		if (!deps?.requestDraft) return json({ error: "이 설치에는 답장 초안 기능이 없어요" }, 503);
		const target = mailTarget(key);
		// What the owner typed in the 초안 작성 box (empty: the draft is made on its own).
		const instruction = String((await body(req).catch(error => { if (error instanceof BodyError) throw error; return {}; }) as { instruction?: unknown }).instruction ?? "").trim().slice(0, 500);
		void deps.requestDraft({ ...(r.account ? { account: r.account } : {}), key, ...(instruction ? { instruction } : {}), target, ...(r.thread ? { thread: r.thread } : {}), ...(r.msg ? { messageId: r.msg } : {}), source: r.source, id: r.id, subject: r.subject, from: r.from, ...(r.to ? { to: r.to } : {}), ...(r.cc ? { cc: r.cc } : {}), ...(r.summary ? { summary: r.summary } : {}), ...(r.attachments?.some(a => !a.inline) ? { attachments: r.attachments.filter(a => !a.inline).map(a => ({ name: a.name, size: a.size })) } : {}), ...(r.replyFiles ? { replyFiles: r.replyFiles } : {}) })
			.then(res => { if (res !== "offered") return deps.send(target, "답장 초안을 만들지 못했어요. 잠시 뒤 다시 눌러 주세요"); })
			.catch(e => log(`mail ${key}: requested draft failed: ${(e as Error).message}`));
		return json({ ok: true, started: true }, 202);
	}
	const mailBody = req.method === "GET" && /^\/api\/mail\/([a-z0-9._-]+)\/body$/.exec(url.pathname);
	if (mailBody) return mailBodyRoute(mailBody[1]!);
	// A mail from an outside poster (a webmail watcher, a custom plugin): one conversation per mail (hub/mail.ts, docs/custom-plugins.md).
	// The reply and KakaoTalk CLIs report an approved send here; the gateway wakes the bot once when that app has a 이어서 할 일 rule (hub/followup.ts).
	if (req.method === "POST" && url.pathname === "/api/followup") {
		const input = parseFollowup(await body(req));
		// The approved reply went out: the mail is 답장함 (hub/mail-state.ts), whether or not the app has a 이어서 할 일 rule.
		if (input?.kind === "mail" && input.ids.mail && setMailReply(input.ids.mail, "sent")) {
			// What he sent is listed as a sent mail now, with its text and files, in the thread of the mail it answered.
			const d = input.ids.draft ? getDraft(input.ids.draft) : undefined;
			if (d) await recordSentByDotz({ id: d.id, source: d.source, to: d.to, cc: d.cc, subject: d.subject, body: d.body, files: stagedFiles(d.id) }, { answers: input.ids.mail }).catch(e => log(`mail ${input.ids.mail}: sent reply not listed: ${(e as Error).message}`));
			broadcast({ kind: "mail_unreplied", target: mailTarget(input.ids.mail) });
		}
		return input ? json({ ok: true, result: triggerFollowup(input) }) : json({ error: "app, kind (comment|mail|kakao), key required" }, 400);
	}
	if (req.method === "POST" && url.pathname === "/api/mail/compose") {
		if (!mailDeps) return json({ error: msg().refuse.mailNotReady }, 503);
		try {
			const b = await body(req) as Record<string, unknown>;
			// The owner wrote this himself in the mail app (메일 쓰기 / the reply box): a draft with his text and files, then its send-approval card.
			if (b.ref === undefined) return await draftFromApp(b, mailDeps());
			const made = composeMail(b, mailDeps());
			// The new mail went out: its row becomes the sent mail, with the text and the files it carried.
			const d = (b as { state?: unknown }).state === "sent" ? getDraft(String((b as { ref?: unknown }).ref)) : undefined;
			if (d) await recordSentByDotz({ id: d.id, source: d.source, to: d.to, cc: d.cc, subject: d.subject, body: d.body, files: stagedFiles(d.id) }, { compose: made.key });
			return json(made);
		} catch (error) {
			if (error instanceof BodyError) throw error;
			return json({ error: (error as Error).message }, error instanceof MailError ? error.status : 500);
		}
	}
	// Mails that still wait are checked against their real thread; the ones the owner answered elsewhere become 답장함 (idempotent, read-only in the mailbox). `skipped` counts mails of a source no plugin can read.
	if (req.method === "POST" && url.pathname === "/api/mail/reconcile") {
		if (!mailReconcile) return json({ error: msg().refuse.mailNotReady }, 503);
		const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
		return json(await mailReconcile(limit).catch(error => ({ error: (error as Error).message })));
	}
	if (req.method === "POST" && url.pathname === "/api/mail/state") {
		const input = parseMailStates(await body(req));
		return input ? json({ ok: true, changed: await applyMailStates(input.source, input.items) }) : json({ error: "source and items [{id, read?, replied?}] required" }, 400);
	}
	if (req.method === "POST" && url.pathname === "/api/mail") {
		if (!mailDeps) return json({ error: msg().refuse.mailNotReady }, 503);
		if (readAppOff(DATA_DIR).has("mail")) return json({ error: msg().refuse.mailOff }, 409);
		try {
			return json(await postMail(await body(req), mailDeps()));
		} catch (error) {
			if (error instanceof BodyError) throw error;
			return json({ error: (error as Error).message }, error instanceof MailError ? error.status : 500);
		}
	}
	if (req.method === "POST" && url.pathname === "/api/mail/move" && mailDeps) return moveMailRoute(await body(req), mailDeps());
	return undefined;
}
