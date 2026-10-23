// Drafts made by the feature: <DATA_DIR>/custom/reply-drafts/drafts.json = { drafts, keys }. `keys` remembers every mail key that
// was already looked at (drafted or skipped) so a mail is never drafted twice, even after its draft is gone.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ReplyItem, ReplyKind } from "../../../hub/reply-draft.ts";
import { paths, writeAtomic } from "./settings.ts";

export type DraftStatus = "pending" | "sent" | "dropped" | "stale";
export type DraftRec = {
	id: string;
	kind: ReplyKind;
	app: string; // tone profile of the draft: mail, youtube, instagram, kakao, ...
	room?: string; // the messenger conversation, when the app has rooms
	source: string; // "zele" | "webmail:<site>" | anything else (cannot be sent from here)
	mailId: string; // the id the source knows the mail by
	ref: string; // the gateway's mail key
	to: string;
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

// A newer draft for the same mail makes every older pending one stale.
export function addDraft(rec: DraftRec): void {
	const f = read();
	for (const d of f.drafts) if (d.ref === rec.ref && d.status === "pending") d.status = "stale";
	write({ drafts: [...f.drafts, rec], keys: f.keys.includes(rec.ref) ? f.keys : [...f.keys, rec.ref] });
}

export function setStatus(id: string, status: DraftStatus): void {
	const f = read();
	write({ ...f, drafts: f.drafts.map(d => (d.id === id ? { ...d, status } : d)) });
}
