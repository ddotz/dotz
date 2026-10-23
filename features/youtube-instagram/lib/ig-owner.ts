// "Did the owner already answer this comment?" for Instagram. A reply carries no author in the Graph payload, so (like the old comment
// script) the owner's side is found two ways: an id that is one of the owner's own comments (the media /comments list has `from.id`), and
// the owner @mentioning the commenter under the same media. Pure: no network, no fs.
import type { IgComment } from "./instagram.ts";

export type IgOwner = { userId?: string; username: string };
export const UNKNOWN_USER = "알 수 없는 사용자";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` @mentions `username` (case-insensitive, whole name: "@bob" is not in "@bob.smith" or "@bobby"). */
export function mentions(text: string, username: string): boolean {
	if (!username || username === UNKNOWN_USER) return false;
	return new RegExp(`(?<![\\w.@])@${escape(username)}(?![\\w]|\\.\\w)`, "i").test(text);
}

type Who = { id?: string; username?: string; fromId?: string };

export type OwnerView = {
	/** Is this comment or reply the owner's own. */
	isOwner: (c: Who) => boolean;
	/** The owner already answered this top-level comment (own reply under it, or an @mention of its author under the same media). */
	answered: (c: IgComment) => boolean;
};

/** `list` = every top-level comment of ONE media as /comments returned it (replies nested). */
export function ownerView(list: IgComment[], owner: IgOwner): OwnerView {
	const name = owner.username.toLowerCase();
	const byField = (c: Who): boolean => Boolean((owner.userId && c.fromId === owner.userId) || (c.username && c.username.toLowerCase() === name));
	const repliesOf = (c: IgComment) => c.replies ?? [];
	const ids = new Set<string>();
	for (const c of list) {
		if (byField(c)) ids.add(c.id);
		for (const r of repliesOf(c)) if (r.id && byField(r)) ids.add(r.id);
	}
	const isOwner = (c: Who): boolean => Boolean((c.id && ids.has(c.id)) || byField(c));
	const said: { at?: number; text: string }[] = [];
	for (const c of list) {
		if (isOwner(c)) said.push({ at: Date.parse(c.timestamp) || undefined, text: c.text ?? "" });
		for (const r of repliesOf(c)) if (isOwner(r)) said.push({ at: Date.parse(r.timestamp ?? "") || undefined, text: r.text ?? "" });
	}
	const answered = (c: IgComment): boolean => {
		if (isOwner(c)) return false;
		if (repliesOf(c).some(isOwner)) return true;
		const at = Date.parse(c.timestamp) || 0;
		return said.some(s => (s.at === undefined || s.at >= at) && mentions(s.text, c.username));
	};
	return { isOwner, answered };
}
