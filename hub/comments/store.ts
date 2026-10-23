// Files of the comment feature, all under <dataDir>/custom/comments/ (per install, never in the repo): config.json (the owner's choices),
// comments.json, drafts.json, replies.json (send records), cursors.json, reads.json. Every write is atomic and private (0600).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Comment, CommentsConfig, SourceConfig } from "./contract.ts";

export type DraftStatus = "pending" | "sent" | "dropped" | "stale";
export type Tokens = { in: number; out: number; estimated?: true };
export type Draft = { code: string; commentId: string; source: string; thread: string; text: string; status: DraftStatus; created: number; changes: string[]; clean: boolean; notes: string[]; tokens?: Tokens };
export type Reply = { id: string; commentId: string; source: string; thread: string; text: string; state: "sending" | "sent" | "failed"; reason?: string; at: number; draft: string; via: "owner" | "rule"; collector: string; ref?: string };
export type Cursor = { cursor?: string; ranAt?: number; error?: string };

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
	const upsert = <T extends { [k: string]: any }>(list: T[], item: T, key: keyof T, cap: number): T[] => [...list.filter(x => x[key] !== item[key]), item].slice(-cap);
	return {
		dir,
		config,
		saveConfig: (c: CommentsConfig) => writeAtomic(f("config.json"), c),
		setSource: (src: SourceConfig) => writeAtomic(f("config.json"), { ...config(), sources: { ...config().sources, [src.key]: src } }),
		comments,
		// Adds the comments whose id is not stored yet (the stored copy of an id is never replaced); returns the new ones.
		addComments: (list: Comment[]): Comment[] => {
			const have = comments();
			const known = new Set(have.map(c => c.id));
			const fresh: Comment[] = [];
			for (const c of list)
				if (!known.has(c.id)) {
					known.add(c.id);
					fresh.push(c);
				}
			if (fresh.length) writeAtomic(f("comments.json"), [...have, ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_COMMENTS));
			return fresh;
		},
		drafts,
		putDraft: (d: Draft) => writeAtomic(f("drafts.json"), upsert(drafts(), d, "code", MAX_DRAFTS)),
		setDraftStatus: (code: string, status: DraftStatus) => writeAtomic(f("drafts.json"), drafts().map(d => (d.code === code ? { ...d, status } : d))),
		replies,
		putReply: (r: Reply) => writeAtomic(f("replies.json"), upsert(replies(), r, "id", MAX_REPLIES)),
		cursors,
		setCursor: (key: string, c: Cursor) => writeAtomic(f("cursors.json"), { ...cursors(), [key]: c }),
		reads,
		markRead: (key: string, at: number) => {
			const r = reads();
			if (!r[key] || at > r[key]!) writeAtomic(f("reads.json"), { ...r, [key]: at });
		},
	};
}
export type Store = ReturnType<typeof createStore>;
