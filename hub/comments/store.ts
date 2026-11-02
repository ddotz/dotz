// Files of the comment feature, all under <dataDir>/custom/comments/ (per install, never in the repo): config.json (the owner's choices),
// comments.json, drafts.json, replies.json (send records), cursors.json, reads.json, dismissed.json (comment id -> time of 답장 안 함), authors.json (Instagram
// reply id -> who wrote it; an author never changes, so an entry is kept for good). Every write is atomic and private (0600).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Comment, CommentsConfig, SourceConfig } from "./contract.ts";

// "answered": the comment stopped waiting without this draft (the owner answered on the platform, it was deleted, 답장 안 함); see closedReason.
export type DraftStatus = "pending" | "sent" | "dropped" | "stale" | "answered";
export type ClosedReason = "answered-on-platform" | "deleted" | "dismissed";
export type Author = { username?: string; fromId?: string };
export type Tokens = { in: number; out: number; estimated?: true };
// `mail`: the id of the mail draft (features/reply-drafts, hub/mail-cli.ts compose) that goes out right after this reply, approved by the same pick;
// `mailAt`: when it was attached, so a pick made on a card that did not show the mail does not approve it. Such a draft is never clean (no rule sends it).
export type Draft = { code: string; commentId: string; source: string; thread: string; text: string; status: DraftStatus; created: number; changes: string[]; clean: boolean; notes: string[]; tokens?: Tokens; mail?: string; mailAt?: number; closedReason?: ClosedReason;
	/** The mail draft that was linked to this draft and left on its own (the reply was answered elsewhere, or 메일만 보내기 sent it): the comment keeps showing its state. */
	mailKept?: string };
export type MailOutcome = { state: "sent" | "failed"; text: string };
export type Reply = { id: string; commentId: string; source: string; thread: string; text: string; state: "sending" | "sent" | "failed"; reason?: string; at: number; draft: string; via: "owner" | "rule"; collector: string; ref?: string; mail?: MailOutcome };
// `queue`: ids of new comments waiting for an auto-draft (engine.ts collect), left for the next run when one run's cap or budget is reached.
export type Cursor = { cursor?: string; ranAt?: number; error?: string; queue?: string[] };

const MAX_COMMENTS = 3000;
const MAX_DRAFTS = 300;
const MAX_REPLIES = 300;
const EMPTY: CommentsConfig = { enabled: false, sources: {} };

export const commentsDir = (dataDir: string): string => join(dataDir, "custom", "comments");

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

export function createStore(dir: string) {
	const f = (name: string) => join(dir, name);
	const config = (): CommentsConfig => {
		const c = readJson<Partial<CommentsConfig>>(f("config.json"), EMPTY);
		return { enabled: c.enabled === true, sources: c.sources && typeof c.sources === "object" ? c.sources : {} };
	};
	const comments = (): Comment[] => readJson<Comment[]>(f("comments.json"), []);
	const drafts = (): Draft[] => readJson<Draft[]>(f("drafts.json"), []);
	const replies = (): Reply[] => readJson<Reply[]>(f("replies.json"), []);
	const cursors = (): Record<string, Cursor> => readJson<Record<string, Cursor>>(f("cursors.json"), {});
	const reads = (): Record<string, number> => readJson<Record<string, number>>(f("reads.json"), {});
	const dismissed = (): Record<string, number> => readJson<Record<string, number>>(f("dismissed.json"), {});
	const authors = (): Record<string, Author> => readJson<Record<string, Author>>(f("authors.json"), {});
	const upsert = <T extends { [k: string]: any }>(list: T[], item: T, key: keyof T, cap: number): T[] => [...list.filter(x => x[key] !== item[key]), item].slice(-cap);
	return {
		dir,
		config,
		saveConfig: (c: CommentsConfig) => writeAtomic(f("config.json"), c),
		setSource: (src: SourceConfig) => writeAtomic(f("config.json"), { ...config(), sources: { ...config().sources, [src.key]: src } }),
		comments,
		// Adds the comments whose id is not stored yet; returns the new ones. A stored copy is never replaced, except that it learns its parent
		// when it was stored as a top-level comment and is now seen as a reply (Instagram shows a reply both ways).
		addComments: (list: Comment[]): Comment[] => {
			const have = comments();
			const known = new Map(have.map(c => [c.id, c]));
			const fresh: Comment[] = [];
			let linked = false;
			for (const c of list) {
				const old = known.get(c.id);
				if (!old) {
					known.set(c.id, c);
					fresh.push(c);
				} else if (c.parent && !old.parent) {
					old.parent = c.parent;
					linked = true;
				}
			}
			if (fresh.length || linked) writeAtomic(f("comments.json"), [...have, ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_COMMENTS));
			return fresh;
		},
		// Changes fields of stored comments by id (the owner's reply resolved later, `gone`); writes only when something differs.
		patchComments: (patch: Record<string, Partial<Comment>>) => {
			const have = comments();
			let changed = false;
			const next = have.map(c => {
				const p = patch[c.id];
				if (!p || !Object.entries(p).some(([k, v]) => (c as Record<string, unknown>)[k] !== v)) return c;
				changed = true;
				return { ...c, ...p };
			});
			if (changed) writeAtomic(f("comments.json"), next);
		},
		// Replaces stored comments by re-keyed copies (Instagram replies were keyed `<comment>.<index>`, now by their real id) and moves everything that points
		// at the old id: drafts, send records (`send:<id>`) and 답장 안 함. A stored comment that already has the new id is dropped as the duplicate.
		replaceComments: (pairs: { from: string; to: Comment }[]) => {
			if (!pairs.length) return;
			const moved = new Map(pairs.map(p => [p.from, p.to.id]));
			const copy = new Map(pairs.map(p => [p.from, p.to]));
			const targets = new Set(moved.values());
			writeAtomic(f("comments.json"), comments().filter(c => copy.has(c.id) || !targets.has(c.id)).map(c => copy.get(c.id) ?? c).sort((a, b) => a.at - b.at));
			const d = drafts();
			if (d.some(x => moved.has(x.commentId))) writeAtomic(f("drafts.json"), d.map(x => (moved.has(x.commentId) ? { ...x, commentId: moved.get(x.commentId)! } : x)));
			const r = replies();
			if (r.some(x => moved.has(x.commentId))) writeAtomic(f("replies.json"), r.map(x => (moved.has(x.commentId) ? { ...x, commentId: moved.get(x.commentId)!, id: x.id === `send:${x.commentId}` ? `send:${moved.get(x.commentId)}` : x.id } : x)));
			const dis = dismissed();
			if (Object.keys(dis).some(k => moved.has(k))) writeAtomic(f("dismissed.json"), Object.fromEntries(Object.entries(dis).map(([k, v]) => [moved.get(k) ?? k, v])));
		},
		authors,
		putAuthors: (entries: Record<string, Author>) => {
			if (Object.keys(entries).length) writeAtomic(f("authors.json"), { ...authors(), ...entries });
		},
		// Gives the stored comments of one post their title / link / thumbnail (the only change ever made to a stored comment).
		retitle: (source: string, thread: string, p: { postTitle: string; postLink?: string; thumb?: string }) => {
			const have = comments();
			if (!have.some(c => c.source === source && c.thread === thread)) return;
			writeAtomic(f("comments.json"), have.map(c => (c.source === source && c.thread === thread ? { ...c, postTitle: p.postTitle, ...(p.postLink ? { postLink: p.postLink } : {}), ...(p.thumb ? { thumb: p.thumb } : {}) } : c)));
		},
		drafts,
		putDraft: (d: Draft) => writeAtomic(f("drafts.json"), upsert(drafts(), d, "code", MAX_DRAFTS)),
		patchDraft: (code: string, patch: Partial<Draft>) => writeAtomic(f("drafts.json"), drafts().map(d => (d.code === code ? { ...d, ...patch } : d))),
		setDraftStatus: (code: string, status: DraftStatus) => writeAtomic(f("drafts.json"), drafts().map(d => (d.code === code ? { ...d, status } : d))),
		replies,
		putReply: (r: Reply) => writeAtomic(f("replies.json"), upsert(replies(), r, "id", MAX_REPLIES)),
		removeReply: (id: string) => writeAtomic(f("replies.json"), replies().filter(r => r.id !== id)),
		cursors,
		setCursor: (key: string, c: Cursor) => writeAtomic(f("cursors.json"), { ...cursors(), [key]: c }),
		dismissed,
		dismiss: (id: string, at: number, on = true) => {
			const { [id]: _old, ...rest } = dismissed();
			writeAtomic(f("dismissed.json"), on ? { ...rest, [id]: at } : rest);
		},
		reads,
		markRead: (key: string, at: number) => {
			const r = reads();
			if (!r[key] || at > r[key]!) writeAtomic(f("reads.json"), { ...r, [key]: at });
		},
	};
}
export type Store = ReturnType<typeof createStore>;
