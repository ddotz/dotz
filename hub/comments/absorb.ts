// Storing what the adapters read: new comments are added, position-keyed Instagram replies are renamed to their real ids, and old twin rows are merged.
// These work on the store they are given and hold no engine state; `unknownUser` is the author an adapter could not name (ig-owner.ts UNKNOWN_USER).
import { type Comment, type RawComment, type SourceConfig, toComment, watches } from "./contract.ts";
import type { Store } from "./store.ts";

// Stores what an adapter read. New ids are added (and returned). A stored reply row keyed by position (Instagram's old `<comment>.<index>`) is replaced by
// the same reply under its real id, with everything that pointed at it (drafts, send records, 답장 안 함) moved along; a stored row whose author or
// `mine` could not be known then gets it once the adapter can tell. Reading the same thing again changes nothing.
export function absorbComments(store: Store, collector: string, unknownUser: string, src: SourceConfig, raws: RawComment[]): Comment[] {
	const incoming = raws.filter(r => watches(src, r.thread)).map(r => toComment(src, r, collector));
	if (!incoming.length) return [];
	const stored = store.comments();
	const byId = new Map(stored.map(c => [c.id, c]));
	const matched = new Set<string>();
	const renames: { from: string; to: Comment }[] = [];
	const refine: Record<string, Partial<Comment>> = {};
	const add: Comment[] = [];
	for (const c of incoming) {
		const old = byId.get(c.id);
		if (old) {
			const patch: Partial<Comment> = {};
			if (c.mine && !old.mine) patch.mine = true;
			// A reply first stored as a comment of its own (Instagram listed it top-level) gets its comment once a read names it (issue #31).
			if (c.parent && !old.parent) patch.parent = c.parent;
			if (old.author === unknownUser && c.author !== unknownUser) patch.author = c.author;
			if (Object.keys(patch).length) refine[old.id] = { ...refine[old.id], ...patch };
			continue;
		}
		const positional = c.parent
			? stored.find(x => x.source === c.source && x.thread === c.thread && x.parent === c.parent && !matched.has(x.id) && x.text === c.text && x.native.startsWith(`${c.parent}.`) && /^\d+$/.test(x.native.slice(c.parent!.length + 1)))
			: undefined;
		if (positional) {
			matched.add(positional.id);
			renames.push({ from: positional.id, to: { ...c, collector: positional.collector, ...(positional.gone ? { gone: positional.gone } : {}) } });
		} else add.push(c);
		byId.set(c.id, c);
	}
	store.replaceComments(renames);
	store.patchComments(refine);
	return store.addComments(add);
}

// Issue #31: older Instagram reads stored each reply twice, as `<comment>.<n>` (no author, not his, the comment's time) and under its real id (often
// top-level, without its comment). Each such pair becomes one row: the real one, under its comment, with what pointed at the copy moved to it.
// Idempotent: once merged nothing of the pattern is left with a twin.
export function mergeIgTwins(store: Store, unknownUser: string): number {
	const ig = new Set(Object.values(store.config().sources).filter(s => s.kind === "instagram").map(s => s.key));
	if (!ig.size) return 0;
	const all = store.comments().filter(c => ig.has(c.source));
	const synthetic = (c: Comment) => !!c.parent && c.native.startsWith(`${c.parent}.`) && /^\d+$/.test(c.native.slice(c.parent.length + 1));
	const used = new Set<string>();
	const pairs: { from: string; to: Comment }[] = [];
	// The same short text (an emoji) can stand under several comments of one post: a twin already under this comment wins, else the earliest unused one
	// not older than the copy (the copies are taken in order, as the replies came).
	const order = (a: Comment, b: Comment) => a.at - b.at || (a.native < b.native ? -1 : 1);
	for (const s of all.filter(synthetic).sort(order)) {
		const cands = all.filter(t => !used.has(t.id) && t.source === s.source && t.thread === s.thread && !synthetic(t) && t.text === s.text && (!t.parent || t.parent === s.parent)).sort(order);
		const twin = cands.find(t => t.parent === s.parent) ?? cands.find(t => t.at >= s.at) ?? cands[0];
		if (!twin) continue;
		used.add(twin.id);
		pairs.push({ from: s.id, to: { ...twin, parent: s.parent, ...(twin.author === unknownUser && s.author !== unknownUser ? { author: s.author } : {}) } });
	}
	store.replaceComments(pairs);
	return pairs.length;
}
