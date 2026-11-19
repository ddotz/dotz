// Drafts made by the feature: <DATA_DIR>/custom/reply-drafts/drafts.json = { drafts, keys }. `keys` remembers every mail key that
// was already looked at (drafted or skipped) so a mail is never drafted twice, even after its draft is gone.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { withLock } from "../../../hub/file-lock.ts";
import type { DraftBrief } from "../../../hub/mail-lines.ts";
import { stateIntact } from "../../../hub/statefile.ts";
import type { ReplyItem, ReplyKind } from "../../../hub/reply-draft.ts";
import { paths, writeAtomic } from "./settings.ts";

// held = set aside by 답장 안 해도 돼요 on its mail (holdDrafts); 되돌리기 makes it pending again (restoreDrafts).
// answered = the owner replied to the mail outside dotz (hub/mail-reconcile.ts); the draft is closed like a sent one, never sent.
export type DraftStatus = "pending" | "sent" | "dropped" | "stale" | "held" | "answered";
export type DraftRec = {
	id: string;
	recipient?: { who: string; evidence: string }; // who the model judged the sender to be and the sender's words it rests on (audit only)
	kind: ReplyKind;
	app: string; // tone profile of the draft: mail, youtube, instagram, kakao, ...
	room?: string; // the messenger conversation, when the app has rooms
	profile?: string; // the mail app instance whose own tone profile wrote this draft (ReplyItem.profile); `app` stays the app
	box?: string; // the mailbox (hub/mailbox.ts Box id) the mail was in when drafted: its reply settings and tone (tone/<instance>/<box>.md) follow revise and send checks
	instance?: string; // the mail app instance of `box`
	source: string; // "zele" | "webmail:<site>" | anything else (cannot be sent from here)
	mailId: string; // the id the source knows the mail by
	ref: string; // the gateway's mail key
	account?: string; // the zele account the mail belongs to: every zele read / reply of this draft passes `--account` with it
	accounts?: string[]; // several zele accounts and none could be settled when the draft was made: the card names them and says it holds the send
	brief?: DraftBrief; // a mail draft: the sender, summary, 할 일 and 직접 답할 것 its card keeps above the draft (hub/draft-approval.ts)
	origAttachments?: number; // files the mail it answers has; the senders carry none of them along, which the approval says
	asksFile?: boolean; // the mail it answers asks for a file (hub/draft-approval.ts asksForFile)
	libraryMiss?: boolean; // the 첨부 파일 폴더 is set and held no file that fits
	fileChangeMissed?: string[]; // a 고치기 asked for other files and these stayed on it: the card's 첨부 확인 says so while they are still the draft's files
	wantFiles?: { name: string; path: string }[]; // files chosen for the draft that are not on it yet (an iCloud file still downloading): the send gate waits for them
	compose?: boolean; // a new mail the bot wrote (hub/mail-cli.ts compose), not an answer to a received one: `mailId` is not a mail, `ref` is its own key
	origin?: { kind: string; id: string; text: string; link?: string }; // the approved action it follows up (hub/followup.ts): the card says so
	to: string; // the 받는 사람, one address or a comma list (features/reply-drafts/lib/recipients.ts recipientText)
	cc?: string[]; // 참조 addresses; absent = none
	mode?: "reply" | "all"; // 답장 | 전체 답장 of the card: which answer the recipients came from (absent on older records and on a chat or comment draft)
	ownerRecipients?: true; // the owner set the 받는 사람·참조 himself on the card: any address he added is sent, not only the original's people
	rule?: { id: string; name: string }; // the 자동 초안 규칙 that drafted it (lib/rules.ts): its name is the card's badge
	subject?: string;
	body: string;
	replaces?: string; // the id of the draft this one replaced (a revise)
	editedFrom?: string; // the model's text before the owner's first direct edit (직접 수정); set once, never overwritten
	subjectEdited?: true;
	status: DraftStatus;
	created: string;
	/** When it went out (ISO): stamped once by setStatus(id, "sent"); a draft sent before this field existed has none. */
	sentAt?: string;
	closedAt?: string;
	changes: string[];
	questions: string[];
	item: ReplyItem;
};
type File = { drafts: DraftRec[]; keys: string[] };

/** The file whose existence says a sender holds draft `id` (hub/draft-claim.ts). */
export const claimFile = (id: string): string => join(dirname(paths.drafts()), "sending", id);

const MAX_DRAFTS = 200;
const MAX_KEYS = 2000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The shape of a draft id newId() makes. */
export const DRAFT_ID = new RegExp(`^R[${ALPHABET}]{6}$`);

// The parsed file is kept while its identity (path, inode, mtime, size) is the same: every write is an atomic rename, so a write by the CLI in another
// process changes the inode. Every public read hands out a copy of what it returns; `read()` (the write paths) works on a copy too.
let cached: { id: string; file: File; heads?: readonly DraftHead[] } | undefined;

/** drafts.json exists but could not be read (EACCES, EMFILE, ...): no reader may take it for an empty store and no writer may write over it. */
export class DraftStoreUnreadable extends Error {}

/** `read()`, or `fallback` after one line to `note` when the store cannot be read (DraftStoreUnreadable); any other error is thrown. */
export function unlessUnreadable<T>(read: () => T, fallback: T, note: (line: string) => void): T {
	try {
		return read();
	} catch (e) {
		if (!(e instanceof DraftStoreUnreadable)) throw e;
		note(e.message);
		return fallback;
	}
}

/** Whether the store can say a draft is gone: drafts.json is absent or parses and no quarantined copy (`drafts.json.corrupt-*`) lies beside it. Reads only. */
export const draftStoreIntact = (): boolean => stateIntact(paths.drafts(), ".corrupt-");

const empty = (): File => ({ drafts: [], keys: [] });
const fileId = (path: string): string => {
	const st = statSync(path);
	return `${path}|${st.ino}|${st.mtimeMs}|${st.size}`;
};

function parsed(): File {
	const path = paths.drafts();
	let id: string, text: string;
	try {
		id = fileId(path);
		if (cached?.id === id) return cached.file;
		text = readFileSync(path, "utf8");
	} catch (e) {
		cached = undefined;
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
		throw new DraftStoreUnreadable(`답장 초안 파일을 읽지 못했어요 (${path}): ${(e as Error).message}`);
	}
	let raw: { drafts?: unknown; keys?: unknown } | null;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		cached = undefined;
		return quarantined(path, id, e as Error);
	}
	const file = { drafts: Array.isArray(raw?.drafts) ? (raw.drafts as DraftRec[]) : [], keys: Array.isArray(raw?.keys) ? (raw.keys as string[]) : [] };
	cached = { id, file };
	return file;
}

function quarantined(path: string, id: string, why: Error): File {
	const moveAside = () => {
		let now: string;
		try {
			now = fileId(path);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
			throw e;
		}
		if (now !== id) return;
		const moved = `${path}.corrupt-${Date.now()}`;
		renameSync(path, moved);
		console.error(`reply draft: ${path} did not parse (${why.message}); kept as ${moved}, the store starts empty`);
	};
	if (holding) moveAside();
	else locked(moveAside);
	return holding ? empty() : parsed();
}
const read = (): File => structuredClone(parsed());

let holding = false;
function locked<T>(fn: () => T): T {
	return withLock(paths.drafts(), "답장 초안", () => {
		holding = true;
		try {
			return fn();
		} finally {
			holding = false;
		}
	});
}

// Only closed drafts (sent, dropped, stale, answered) are trimmed, oldest first: a pending or held draft still has a card, so it always stays.
// A key of a kept draft is never forgotten either (the mail would be drafted twice); other keys beyond MAX_KEYS go oldest first.
function trimmed(f: File): File {
	let skip = f.drafts.reduce((n, d) => n + (d.status === "pending" || d.status === "held" ? 0 : 1), 0) - MAX_DRAFTS;
	const drafts = skip > 0 ? f.drafts.filter(d => d.status === "pending" || d.status === "held" || skip-- <= 0) : f.drafts;
	let over = f.keys.length - MAX_KEYS;
	if (over <= 0) return { drafts, keys: f.keys };
	const kept = new Set(drafts.map(d => d.ref));
	return { drafts, keys: f.keys.filter(k => over <= 0 || kept.has(k) || (over--, false)) };
}

const write = (f: File) => writeAtomic(paths.drafts(), `${JSON.stringify(trimmed(f), null, 1)}\n`);

export function newId(taken: Set<string> = new Set(listDrafts().map(d => d.id))): string {
	for (;;) {
		const id = `R${Array.from(randomBytes(6), b => ALPHABET[b % 32]).join("")}`;
		if (!taken.has(id)) return id;
	}
}

// What the readers get is a copy, so nothing they change reaches the kept parse.
export const listDrafts = (): DraftRec[] => structuredClone(parsed().drafts);

/** What a status check needs of a draft. */
export type DraftHead = { id: string; ref: string; status: string; created: string };
/**
 * Every draft's id, ref, status and created, built once per version of the file and shared (read-only) by all callers, so asking for it once per card
 * of a sweep copies nothing. Use listDrafts() when the caller needs the whole record or may change it.
 */
export function draftHeads(): readonly DraftHead[] {
	const file = parsed();
	if (cached?.file !== file) return file.drafts.map(({ id, ref, status, created }) => ({ id, ref, status, created }));
	return (cached.heads ??= file.drafts.map(({ id, ref, status, created }) => ({ id, ref, status, created })));
}
export const getDraft = (id: string): DraftRec | undefined => {
	const d = parsed().drafts.find(x => x.id === id);
	return d && structuredClone(d);
};
export const isDrafted = (ref: string): boolean => parsed().keys.includes(ref);

export function markDrafted(ref: string): void {
	locked(() => {
		const f = read();
		if (!f.keys.includes(ref)) write({ ...f, keys: [...f.keys, ref] });
	});
}

const waiting = (d: DraftRec, ref: string) => d.ref === ref && (d.status === "pending" || d.status === "held");
// A newer draft for the same mail makes every older pending (or held) one stale.
function withDraft(f: File, rec: DraftRec): File {
	const older = (d: DraftRec) => d.id === rec.replaces || d.created <= rec.created;
	const newer = f.drafts.some(d => waiting(d, rec.ref) && !older(d));
	for (const d of f.drafts) if (waiting(d, rec.ref) && older(d)) d.status = "stale";
	return { drafts: [...f.drafts, newer ? { ...rec, status: "stale" } : rec], keys: f.keys.includes(rec.ref) ? f.keys : [...f.keys, rec.ref] };
}
export function addDraft(rec: DraftRec): void {
	locked(() => write(withDraft(read(), rec)));
}

/** Why a revision of draft `id` is not stored: that draft is gone or left `pending` while the model worked, or a newer draft of its mail waits. */
export type RevisionConflict = { kind: "gone" } | { kind: "closed"; status: DraftStatus } | { kind: "newer"; id: string };
function revisionConflict(f: File, id: string): RevisionConflict | undefined {
	const old = f.drafts.find(d => d.id === id);
	if (!old) return { kind: "gone" };
	if (old.status !== "pending") return { kind: "closed", status: old.status };
	const newer = f.drafts.find(d => d.id !== id && waiting(d, old.ref) && d.created > old.created);
	return newer && { kind: "newer", id: newer.id };
}
/** Stores `rec` as the revision of draft `id` unless a RevisionConflict stands, checked and written under the store's lock. */
export function addRevision(rec: DraftRec, id: string): RevisionConflict | undefined {
	return locked(() => {
		const f = read();
		const conflict = revisionConflict(f, id);
		if (!conflict) write(withDraft(f, rec));
		return conflict;
	});
}

export function patchDraft(id: string, patch: Partial<Pick<DraftRec, "to" | "cc" | "mode" | "ownerRecipients" | "item" | "questions" | "body" | "wantFiles" | "editedFrom" | "subject" | "subjectEdited" | "account">>): void {
	locked(() => {
		const f = read();
		write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, ...patch } : d)) });
	});
}

// 답장 안 해도 돼요 on a mail: its waiting drafts are kept aside (held), not dropped, so the undo can bring them back. Returns the held ids.
export const holdDrafts = (ref: string): string[] => holdDraftsOf(new Set([ref]));
export function holdDraftsOf(refs: ReadonlySet<string>): string[] {
	return locked(() => {
		const f = read();
		const hit = f.drafts.filter(d => refs.has(d.ref) && d.status === "pending");
		if (hit.length) write({ ...f, drafts: f.drafts.map(d => (hit.includes(d) ? { ...d, status: "held" as const } : d)) });
		return hit.map(d => d.id);
	});
}

// Its undo: the newest held draft of the mail waits for approval again (older held ones were already replaced by it: stale). Returns its id.
export const restoreDrafts = (ref: string): string | undefined => restoreDraftsOf(new Set([ref]))[0];
export function restoreDraftsOf(refs: ReadonlySet<string>): string[] {
	return locked(() => {
		const f = read();
		const held = f.drafts.filter(d => refs.has(d.ref) && d.status === "held");
		const newest = new Map<string, DraftRec>();
		for (const d of held) { const a = newest.get(d.ref); if (!a || d.created >= a.created) newest.set(d.ref, d); }
		if (!newest.size) return [];
		const top = new Set(newest.values());
		write({ ...f, drafts: f.drafts.map(d => (top.has(d) ? { ...d, status: "pending" as const } : held.includes(d) ? { ...d, status: "stale" as const } : d)) });
		return [...top].map(d => d.id);
	});
}

// The mail was answered outside dotz: its waiting drafts (pending or held) are closed as answered. Returns their ids.
export function answerDrafts(ref: string): string[] {
	return locked(() => {
		const f = read();
		const hit = f.drafts.filter(d => waiting(d, ref));
		if (hit.length) write({ ...f, drafts: f.drafts.map(d => (hit.includes(d) ? { ...d, status: "answered" as const } : d)) });
		return hit.map(d => d.id);
	});
}

export function setStatus(id: string, status: DraftStatus): void {
	locked(() => {
		const f = read();
		const at = new Date(Date.now()).toISOString();
		write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, status, ...(status === "sent" && !d.sentAt ? { sentAt: at } : {}), ...(status === "pending" ? {} : { closedAt: at }) } : d)) });
	});
}
