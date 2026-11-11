// The owner's past replies of the sources he chose, read back for tone (hub/comments/engine.ts returns `refreshPast` from here).
import { type CommentAdapter, type RawComment, type SourceConfig, type SourceKind, toComment } from "./contract.ts";
import { mergePast, PAST_TARGET, pairKey, type PastPair, pastPairs } from "./past.ts";
import type { Store } from "./store.ts";

export type PastDeps = {
	/** The owner's past pairs of a source in a file of their own (features/reply-drafts/lib/pairs.ts), so a store that trims old rows loses none. `save` replaces the whole list. Missing = the store's pairs only, and no history is read. */
	pairs?: { load: (key: string) => PastPair[]; save: (key: string, pairs: PastPair[]) => void };
	/** What was learned, by mark (features/reply-drafts learned.json): `pairs-<key>@1` = the history was read, `pairs-<key>~tried` = a read failed at that time. Missing = no history is read. */
	learned?: { read: () => Record<string, string>; mark: (marks: string[], now: Date) => void };
	/** The one-time identity of a source's tone profile from its past replies, newest first, each followed by the comment it answered as `> ` lines (persona.ts learnFirst). */
	identity?: (src: SourceConfig, replies: string[], where: string, call: (system: string, user: string) => Promise<string>, now: Date) => Promise<unknown>;
};
type Deps = PastDeps & { now: () => number; collector: string; adapters: Partial<Record<SourceKind, CommentAdapter>>; model?: (system: string, user: string, app?: string) => Promise<{ text: string }> };

const PAST_RETRY_MS = 24 * 3600_000;
const IDENTITY_MIN = 20;
const PLACE: Record<SourceKind, string> = { youtube: "유튜브 댓글", instagram: "인스타 댓글", website: "웹사이트 댓글" };
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

// The pairs the store holds for a source; a site whose own replies never carry a parent is read as private messages (a reply answers the message before it).
export const storedPairs = (store: Store, src: SourceConfig): PastPair[] => {
	const own = store.comments().filter(c => c.source === src.key);
	return pastPairs(own, store.replies(), src.key, store.drafts(), src.kind === "website" && !own.some(c => c.mine && c.parent));
};

// 1) every run saves the store's pairs into the pair file, with no platform call, so the store trimming old rows loses nothing;
// 2) unless `read` is false, at most ONE source whose history was never read (`pairs-<key>@1`) and did not fail in the last 24 h (`~tried`) reads it, newest first up to
//    PAST_TARGET pairs. `key` (setting a source up) reads that source now, whatever failed before. With 20 or more replies the source's tone profile learns its identity once.
// Undefined = nothing was read (no history here, nothing due, or not wired). Nothing is posted, stored as a comment, drafted or woken.
export function createPastRefresh(store: Store, deps: Deps, ownerOf: (src: SourceConfig) => string) {
	return async function refreshPast(opts: { deadline: number; key?: string; read?: boolean }): Promise<{ key: string; status: "read" | "known" | "failed"; pairs: number; replies: string[]; error?: string } | undefined> {
		const cfg = store.config();
		const { pairs, learned } = deps;
		if (!cfg.enabled || !pairs || !learned) return undefined;
		const sources = Object.values(cfg.sources).filter(s => s.watch.length);
		for (const src of sources) {
			const fresh = storedPairs(store, src);
			const have = new Map(pairs.load(src.key).map(p => [pairKey(p), p]));
			if (fresh.some(p => !have.has(pairKey(p)) || (p.edited && !have.get(pairKey(p))!.edited))) pairs.save(src.key, mergePast([...have.values()], fresh));
		}
		if (opts.read === false) return undefined;
		const marks = learned.read();
		const mark = (key: string) => `pairs-${key}@1`;
		const tried = (key: string) => `pairs-${key}~tried`;
		const src = opts.key
			? sources.find(s => s.key === opts.key && deps.adapters[s.kind]?.history)
			: sources.find(s => deps.adapters[s.kind]?.history && !marks[mark(s.key)] && !(Date.parse(marks[tried(s.key)] ?? "") > deps.now() - PAST_RETRY_MS));
		if (!src) return undefined;
		if (marks[mark(src.key)]) return { key: src.key, status: "known", pairs: 0, replies: [] };
		const stamp = () => new Date(deps.now());
		let rows: RawComment[];
		try {
			rows = await deps.adapters[src.kind]!.history!(src, { target: PAST_TARGET, deadline: opts.deadline });
		} catch (e) {
			learned.mark([tried(src.key)], stamp());
			return { key: src.key, status: "failed", pairs: 0, replies: [], error: e instanceof Error ? clip(e.message, 160) : "지난 답글을 읽지 못했어요" };
		}
		const comments = rows.map(r => toComment(src, r, deps.collector));
		const found = pastPairs(comments, [], src.key, store.drafts(), src.kind === "website" && !comments.some(c => c.mine && c.parent))
			.sort((a, b) => b.at - a.at)
			.slice(0, PAST_TARGET);
		if (found.length) pairs.save(src.key, mergePast(pairs.load(src.key), found));
		learned.mark([mark(src.key)], stamp());
		const replies = found.map(p => p.reply);
		if (found.length >= IDENTITY_MIN && deps.identity && deps.now() < opts.deadline) {
			const call = async (system: string, user: string): Promise<string> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const late = new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new Error("시간 안에 끝내지 못했어요")), Math.max(0, opts.deadline - deps.now()))));
				try {
					return await Promise.race([deps.model!(system, user, ownerOf(src)).then(r => r.text), late]);
				} finally {
					clearTimeout(timer);
				}
			};
			try {
				if (deps.model) await deps.identity(src, found.map(p => `${p.reply}\n${p.comment.split("\n").map(l => `> ${l}`).join("\n")}`), PLACE[src.kind], call, stamp());
			} catch (e) {
				console.error(`comments: tone of ${src.key} not learned: ${e instanceof Error ? clip(e.message, 160) : "error"}`);
			}
		}
		return { key: src.key, status: "read", pairs: found.length, replies };
	};
}
