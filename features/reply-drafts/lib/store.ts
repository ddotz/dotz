// Drafts made by the feature: <DATA_DIR>/custom/reply-drafts/drafts.json = { drafts, keys }. `keys` remembers every mail key that
// was already looked at (drafted or skipped) so a mail is never drafted twice, even after its draft is gone.
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
	source: string; // "zele" | "webmail:<site>" | anything else (cannot be sent from here)
	mailId: string; // the id the source knows the mail by
	ref: string; // the gateway's mail key
	account?: string; // the zele account the mail belongs to: every zele read / reply of this draft passes `--account` with it
	origAttachments?: number; // files the mail it answers has; the senders carry none of them along, which the approval says
	asksFile?: boolean; // the mail it answers asks for a file (hub/draft-approval.ts asksForFile)
	libraryMiss?: boolean; // the 첨부 파일 폴더 is set and held no file that fits
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
	status: DraftStatus;
	created: string;
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

// The parsed file is kept while its identity (path, inode, mtime, size) is the same: every write is an atomic rename, so a write by the CLI in another
// process changes the inode. Every public read hands out a copy of what it returns; `read()` (the write paths) works on a copy too.
let cached: { id: string; file: File } | undefined;

function parsed(): File {
	const path = paths.drafts();
	try {
		const st = statSync(path);
		const id = `${path}|${st.ino}|${st.mtimeMs}|${st.size}`;
		if (cached?.id === id) return cached.file;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const file = { drafts: Array.isArray(raw?.drafts) ? raw.drafts : [], keys: Array.isArray(raw?.keys) ? raw.keys : [] };
		cached = { id, file };
		return file;
	} catch {
		cached = undefined;
		return { drafts: [], keys: [] };
	}
}
const read = (): File => structuredClone(parsed());

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
export const getDraft = (id: string): DraftRec | undefined => {
	const d = parsed().drafts.find(x => x.id === id);
	return d && structuredClone(d);
};
export const isDrafted = (ref: string): boolean => parsed().keys.includes(ref);

export function markDrafted(ref: string): void {
	const f = read();
	if (!f.keys.includes(ref)) write({ ...f, keys: [...f.keys, ref] });
}

// A newer draft for the same mail makes every older pending (or held) one stale.
export function addDraft(rec: DraftRec): void {
	const f = read();
	for (const d of f.drafts) if (d.ref === rec.ref && (d.status === "pending" || d.status === "held")) d.status = "stale";
	write({ drafts: [...f.drafts, rec], keys: f.keys.includes(rec.ref) ? f.keys : [...f.keys, rec.ref] });
}

export function patchDraft(id: string, patch: Partial<Pick<DraftRec, "to" | "cc" | "mode" | "ownerRecipients" | "item" | "questions" | "body" | "wantFiles">>): void {
	const f = read();
	write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, ...patch } : d)) });
}

// 답장 안 해도 돼요 on a mail: its waiting drafts are kept aside (held), not dropped, so the undo can bring them back. Returns the held ids.
export const holdDrafts = (ref: string): string[] => holdDraftsOf(new Set([ref]));
export function holdDraftsOf(refs: ReadonlySet<string>): string[] {
	const f = read();
	const hit = f.drafts.filter(d => refs.has(d.ref) && d.status === "pending");
	if (hit.length) write({ ...f, drafts: f.drafts.map(d => (hit.includes(d) ? { ...d, status: "held" as const } : d)) });
	return hit.map(d => d.id);
}

// Its undo: the newest held draft of the mail waits for approval again (older held ones were already replaced by it: stale). Returns its id.
export const restoreDrafts = (ref: string): string | undefined => restoreDraftsOf(new Set([ref]))[0];
export function restoreDraftsOf(refs: ReadonlySet<string>): string[] {
	const f = read();
	const held = f.drafts.filter(d => refs.has(d.ref) && d.status === "held");
	const newest = new Map<string, DraftRec>();
	for (const d of held) { const a = newest.get(d.ref); if (!a || d.created >= a.created) newest.set(d.ref, d); }
	if (!newest.size) return [];
	const top = new Set(newest.values());
	write({ ...f, drafts: f.drafts.map(d => (top.has(d) ? { ...d, status: "pending" as const } : held.includes(d) ? { ...d, status: "stale" as const } : d)) });
	return [...top].map(d => d.id);
}

// The mail was answered outside dotz: its waiting drafts (pending or held) are closed as answered. Returns their ids.
export function answerDrafts(ref: string): string[] {
	const f = read();
	const hit = f.drafts.filter(d => d.ref === ref && (d.status === "pending" || d.status === "held"));
	if (hit.length) write({ ...f, drafts: f.drafts.map(d => (hit.includes(d) ? { ...d, status: "answered" as const } : d)) });
	return hit.map(d => d.id);
}

export function setStatus(id: string, status: DraftStatus): void {
	const f = read();
	write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, status } : d)) });
}
