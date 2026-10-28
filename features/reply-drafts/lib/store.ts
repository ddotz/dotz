// Drafts made by the feature: <DATA_DIR>/custom/reply-drafts/drafts.json = { drafts, keys }. `keys` remembers every mail key that
// was already looked at (drafted or skipped) so a mail is never drafted twice, even after its draft is gone.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ReplyItem, ReplyKind } from "../../../hub/reply-draft.ts";
import { paths, writeAtomic } from "./settings.ts";

// held = set aside by 답장 안 해도 돼요 on its mail (holdDrafts); 되돌리기 makes it pending again (restoreDrafts).
export type DraftStatus = "pending" | "sent" | "dropped" | "stale" | "held";
export type DraftRec = {
	id: string;
	kind: ReplyKind;
	app: string; // tone profile of the draft: mail, youtube, instagram, kakao, ...
	room?: string; // the messenger conversation, when the app has rooms
	source: string; // "zele" | "webmail:<site>" | anything else (cannot be sent from here)
	mailId: string; // the id the source knows the mail by
	ref: string; // the gateway's mail key
	origAttachments?: number; // files the mail it answers has; the senders carry none of them along, which the approval says
	asksFile?: boolean; // the mail it answers asks for a file (hub/draft-approval.ts asksForFile)
	libraryMiss?: boolean; // the 첨부 파일 폴더 is set and held no file that fits
	compose?: boolean; // a new mail the bot wrote (hub/mail-cli.ts compose), not an answer to a received one: `mailId` is not a mail, `ref` is its own key
	origin?: { kind: string; id: string; text: string; link?: string }; // the approved action it follows up (hub/followup.ts): the card says so
	to: string; // the 받는 사람, one address or a comma list (features/reply-drafts/lib/recipients.ts recipientText)
	cc?: string[]; // 참조 addresses; absent = none
	mode?: "reply" | "all"; // 답장 | 전체 답장 of the card: which answer the recipients came from (absent on older records and on a chat or comment draft)
	ownerRecipients?: true; // the owner set the 받는 사람·참조 himself on the card: any address he added is sent, not only the original's people
	subject?: string;
	body: string;
	status: DraftStatus;
	created: string;
	changes: string[];
	questions: string[];
	item: ReplyItem;
};
type File = { drafts: DraftRec[]; keys: string[] };

const MAX_DRAFTS = 200;
const MAX_KEYS = 2000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function read(): File {
	if (!existsSync(paths.drafts())) return { drafts: [], keys: [] };
	try {
		const raw = JSON.parse(readFileSync(paths.drafts(), "utf8"));
		return { drafts: Array.isArray(raw?.drafts) ? raw.drafts : [], keys: Array.isArray(raw?.keys) ? raw.keys : [] };
	} catch {
		return { drafts: [], keys: [] };
	}
}

const write = (f: File) => writeAtomic(paths.drafts(), `${JSON.stringify({ drafts: f.drafts.slice(-MAX_DRAFTS), keys: f.keys.slice(-MAX_KEYS) }, null, 1)}\n`);

export function newId(taken: Set<string> = new Set(listDrafts().map(d => d.id))): string {
	for (;;) {
		const id = `R${Array.from(randomBytes(6), b => ALPHABET[b % 32]).join("")}`;
		if (!taken.has(id)) return id;
	}
}

export const listDrafts = (): DraftRec[] => read().drafts;
export const getDraft = (id: string): DraftRec | undefined => read().drafts.find(d => d.id === id);
export const isDrafted = (ref: string): boolean => read().keys.includes(ref);

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

export function patchDraft(id: string, patch: Partial<Pick<DraftRec, "to" | "cc" | "mode" | "ownerRecipients" | "item" | "questions">>): void {
	const f = read();
	write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, ...patch } : d)) });
}

// 답장 안 해도 돼요 on a mail: its waiting drafts are kept aside (held), not dropped, so the undo can bring them back. Returns the held ids.
export function holdDrafts(ref: string): string[] {
	const f = read();
	const hit = f.drafts.filter(d => d.ref === ref && d.status === "pending");
	if (hit.length) write({ ...f, drafts: f.drafts.map(d => (hit.includes(d) ? { ...d, status: "held" as const } : d)) });
	return hit.map(d => d.id);
}

// Its undo: the newest held draft of the mail waits for approval again (older held ones were already replaced by it: stale). Returns its id.
export function restoreDrafts(ref: string): string | undefined {
	const f = read();
	const held = f.drafts.filter(d => d.ref === ref && d.status === "held");
	const top = held.reduce<DraftRec | undefined>((a, d) => (!a || d.created >= a.created ? d : a), undefined);
	if (!top) return undefined;
	write({ ...f, drafts: f.drafts.map(d => (d === top ? { ...d, status: "pending" as const } : held.includes(d) ? { ...d, status: "stale" as const } : d)) });
	return top.id;
}

export function setStatus(id: string, status: DraftStatus): void {
	const f = read();
	write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, status } : d)) });
}
