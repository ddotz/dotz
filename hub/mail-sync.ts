// Two-way sync between a mail in dotz and the real mailbox. API CONTRACT (the web calls only these):
//
// Actions: "read" | "unread" | "archive" | "unarchive" | "trash" | "star" | "unstar".
//   POST /api/mail/<key>/action   {"action": "<action>"}
//     -> 200 {"ok": true, "synced": true}                       dotz changed and the mailbox did too
//     -> 200 {"ok": true, "synced": false, "note": "<one short Korean line>"}   dotz changed; the mailbox could not (no support, or the call failed)
//     -> 400 {"error": "..."} unknown action    -> 404 {"error": "..."} no such mail
//   POST /api/mail/actions        {"keys": ["<key>", ...], "action": "<action>"}   (at most 200 keys, one pass, in order)
//     -> 200 {"ok": true, "results": [{"key": "<key>", "ok": true, "synced": true, "note"?: "..."}, ...]}   a missing key is {"key", "ok": false, "synced": false, "note": "이 메일을 찾지 못했어요"}
//   dotz side of each action: read = the conversation's read position moves up to the mail (POST /api/read does the same); unread = the position moves
//   to just before the mail, so it counts unread again; archive / unarchive = the record's `archived` flag (a newer message of the thread, another
//   messageId, makes it a new mail again and clears it); star / unstar = `starred`; trash = the mail leaves dotz (DELETE /api/mail/<key>) and
//   the mailbox's trash gets it. Opening a mail (POST /api/read moving the position) is "read" toward the mailbox only.
//   Mailbox side: zele = `zele mail read-mark|unread-mark|archive|trash|star|unstar <threadId> [--account <a>]` and unarchive = `mail label --add INBOX`;
//   a webmail-no-api site can do none of them (synced false + note); any other source asks its custom plugin's `mailAction({source, id, action})`
//   (hub/plugins.ts, docs/custom-plugins.md): true = done, false = refused, undefined = not supported (note), a throw = failed (note).
//
// The other way: POST /api/mail/state {"source": "zele", "items": [{"id", "read"?, "unread"?, "replied"?, "archived"?, "trashed"?, "starred"?}]}
//   (booleans; "unread": true is "read": false). The record keeps the last state the mailbox reported (`box`) and applies only a CHANGE of it, so a poll
//   that still shows the old state never undoes what he just did in dotz. The first report of a mail applies only what is not the default
//   (read, archived, starred, trashed). trashed = the mail is gone from dotz. A change to unread moves the read position back; a change to
//   read moves it forward. The zele poll reports unread, starred, trashed (TRASH label) and archived:false (INBOX label) from the lists it already reads.
//
// GET /api/conversations `mail` card (hub/mail.ts mailCard) gains: "read": boolean (nothing of the mail is unread), "archived"?: true, "starred"?: true,
//   "can": string[] = the actions that reach the real mailbox for this mail's source (zele: all seven; webmail-no-api: []; a plugin: what its
//   `mailActions(source)` lists, else []). Every action works in dotz whatever `can` says; it only says whether `synced` can come back true.
//   "base": the subject without Re:/Fwd:, the key the sent replies and the incoming mails of one thread share (sent mails have "dir": "out").
//
// Everything outside (zele, plugins, the read position, deleting) is injected (SyncDeps), so the tests run it with fakes.
import { mailByKey, recordMail, type MailRecord, type MailSourceState } from "./mail.ts";

export const MAIL_ACTIONS = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];
export const isMailAction = (v: unknown): v is MailAction => typeof v === "string" && (MAIL_ACTIONS as readonly string[]).includes(v);
export type ActionResult = { ok: boolean; synced: boolean; note?: string };

export type SyncDeps = {
	/** Runs a command (zele); the code and stderr are all that is looked at. */
	exec: (argv: string[]) => Promise<{ code: number; stderr: string }>;
	/** The custom plugin hook (hub/plugins.ts pluginMailAction): true done, false refused, undefined no plugin takes this source. A throw is a failure. */
	plugin: (a: { source: string; id: string; action: MailAction }) => Promise<boolean | undefined>;
	/** The actions the plugin of this source lists (hub/plugins.ts pluginMailActions). */
	pluginCan: (source: string) => string[];
	/** True for a webmail-no-api site: it can do nothing in the mailbox. */
	webmail: (source: string) => boolean;
	/** Moves the conversation's read position to `ts` (forward for read, back for unread). */
	setRead: (target: string, ts: string, direction: "read" | "unread") => void;
	/** The mail leaves dotz (record, files, drafts, notices); false when it was not there. */
	remove: (key: string) => Promise<boolean>;
	/** The list changed: redraw (broadcast). */
	changed: (key: string) => void;
	log?: (line: string) => void;
};

const ZELE_CMD: Record<Exclude<MailAction, "unarchive">, string> = { read: "read-mark", unread: "unread-mark", archive: "archive", trash: "trash", star: "star", unstar: "unstar" };
const NO_SUPPORT: Record<MailAction, string> = {
	read: "dotz에서만 읽음 표시가 바뀌었어요",
	unread: "dotz에서만 읽음 표시가 바뀌었어요",
	archive: "dotz에서만 보관 상태가 바뀌었어요",
	unarchive: "dotz에서만 보관 상태가 바뀌었어요",
	trash: "dotz에서만 지웠어요",
	star: "dotz에서만 별표가 바뀌었어요",
	unstar: "dotz에서만 별표가 바뀌었어요",
};
const FAILED = "메일함에 반영하지 못했어요 · dotz에서만 바뀌었어요";

/** The actions that reach the real mailbox of a source. */
export const canOf = (source: string, d: Pick<SyncDeps, "webmail" | "pluginCan">): string[] => (source === "zele" ? [...MAIL_ACTIONS] : d.webmail(source) ? [] : d.pluginCan(source));

async function provider(r: MailRecord, action: MailAction, d: SyncDeps): Promise<ActionResult> {
	try {
		if (r.source === "zele") {
			const argv = action === "unarchive" ? ["zele", "mail", "label", r.id, "--add", "INBOX"] : ["zele", "mail", ZELE_CMD[action], r.id];
			const out = await d.exec([...argv, ...(r.account ? ["--account", r.account] : [])]);
			if (out.code === 0) return { ok: true, synced: true };
			d.log?.(`mail ${r.key}: ${action} not done in zele: ${out.stderr.trim().slice(0, 200)}`);
			return { ok: true, synced: false, note: FAILED };
		}
		if (d.webmail(r.source)) return { ok: true, synced: false, note: NO_SUPPORT[action] };
		const done = await d.plugin({ source: r.source, id: r.id, action });
		if (done === undefined) return { ok: true, synced: false, note: NO_SUPPORT[action] };
		return done ? { ok: true, synced: true } : { ok: true, synced: false, note: FAILED };
	} catch (error) {
		d.log?.(`mail ${r.key}: ${action} failed in its mailbox: ${(error as Error).message}`);
		return { ok: true, synced: false, note: FAILED };
	}
}

const patch = (r: MailRecord, change: Partial<MailRecord>, drop: (keyof MailRecord)[] = []): void => {
	const next: MailRecord = { ...r, ...change };
	for (const k of drop) delete next[k];
	recordMail(next);
};

/**
 * One action on one mail: dotz changes at once, then the mailbox. `providerOnly` = dotz already did it (the owner opened the mail, POST /api/read):
 * only the mailbox is told. ok is false only when the mail is not in dotz.
 */
export async function mailAction(key: string, action: MailAction, d: SyncDeps, opts: { providerOnly?: boolean } = {}): Promise<ActionResult> {
	const r = mailByKey(key);
	if (!r) return { ok: false, synced: false, note: "이 메일을 찾지 못했어요" };
	const target = `mail:${key}`;
	if (!opts.providerOnly) {
		if (action === "read") d.setRead(target, r.at, "read");
		else if (action === "unread") d.setRead(target, new Date(Date.parse(r.at) - 1).toISOString(), "unread");
		else if (action === "archive") patch(r, { archived: true });
		else if (action === "unarchive") patch(r, {}, ["archived"]);
		else if (action === "star") patch(r, { starred: true });
		else if (action === "unstar") patch(r, {}, ["starred"]);
	}
	const result = r.dir === "out" ? { ok: true, synced: false, note: NO_SUPPORT[action] } : await provider(r, action, d);
	if (action === "trash" && !opts.providerOnly) await d.remove(key);
	if (!opts.providerOnly) d.changed(key);
	return result;
}

/** POST /api/mail/actions: the same action on many mails, in order. */
export async function mailActions(keys: readonly string[], action: MailAction, d: SyncDeps): Promise<Array<ActionResult & { key: string }>> {
	const results: Array<ActionResult & { key: string }> = [];
	for (const key of keys) results.push({ key, ...(await mailAction(key, action, d)) });
	return results;
}

type Box = NonNullable<MailRecord["box"]>;
const readOf = (it: MailSourceState): boolean | undefined => (it.read !== undefined ? it.read : it.unread !== undefined ? !it.unread : undefined);

/**
 * What the mailbox reports now (POST /api/mail/state), applied as changes only: each mail keeps the last state the mailbox reported (`box`), and only a
 * field that differs from it is applied, so a stale poll never undoes a fresh dotz action. The first report of a field applies only a non-default value.
 * Returns the mail targets that changed. `trashed` removes the mail; ids that are not stored are ignored.
 */
export async function applyMailboxFlags(source: string, items: readonly MailSourceState[], d: Pick<SyncDeps, "setRead" | "remove" | "log"> & { keyOf: (source: string, id: string) => string | undefined }): Promise<string[]> {
	const changed: string[] = [];
	for (const it of items) {
		const key = d.keyOf(source, it.id);
		const r = key ? mailByKey(key) : undefined;
		if (!key || !r || r.dir === "out") continue;
		const seen: Box = r.box ?? {};
		const next: Box = { ...seen };
		const next$ = { ...r } as MailRecord;
		let moved = false;
		const read = readOf(it);
		if (read !== undefined) {
			if (seen.read !== read) {
				if (read) d.setRead(`mail:${key}`, r.at, "read");
				else if (seen.read !== undefined) d.setRead(`mail:${key}`, new Date(Date.parse(r.at) - 1).toISOString(), "unread");
				moved = moved || seen.read !== undefined || read;
			}
			next.read = read;
		}
		for (const f of ["archived", "starred"] as const) {
			const v = it[f];
			if (v === undefined) continue;
			if (seen[f] !== v && (seen[f] !== undefined || v)) {
				if (v) next$[f] = true;
				else delete next$[f];
				moved = true;
			}
			next[f] = v;
		}
		if (it.trashed === true && seen.trashed !== true) {
			next.trashed = true;
			if (await d.remove(key)) changed.push(`mail:${key}`);
			continue;
		}
		next$.box = next;
		if (JSON.stringify(next$) !== JSON.stringify(r)) recordMail(next$);
		if (moved) changed.push(`mail:${key}`);
	}
	return changed;
}
