// The comment a reply draft answers, for the send sheet's 원문 보기 (GET /api/drafts/<code>/original, hub/draft-attach.ts): who wrote it and when, its text, the
// post it is under (title, link, thumbnail) and, when it is a reply in a thread, the comment above it. Read from the stored comments; nothing is fetched.
import type { Store } from "./store.ts";

export type CommentOriginal = {
	kind: "comment";
	key: string;
	author: string;
	date?: string;
	text: string;
	post: { title?: string; link?: string; thumb?: string; kind: string };
	parent?: { author: string; text: string; date: string };
};

const iso = (ms: number) => new Date(ms).toISOString();

// `code` = a draft of the comment engine (Draft.code); undefined when the draft or the comment it answers is not stored any more.
export function commentOriginal(store: Store, code: string): CommentOriginal | undefined {
	const draft = store.drafts().find(d => d.code === code);
	const comment = draft && store.comments().find(c => c.id === draft.commentId);
	if (!draft || !comment) return undefined;
	const parent = comment.parent ? store.comments().find(c => c.source === comment.source && c.native === comment.parent) : undefined;
	const kind = store.config().sources[comment.source]?.kind ?? "website";
	return {
		kind: "comment",
		key: comment.id,
		author: comment.author,
		date: iso(comment.at),
		text: comment.text,
		post: { title: comment.postTitle, ...(comment.postLink ? { link: comment.postLink } : {}), ...(comment.thumb ? { thumb: comment.thumb } : {}), kind },
		...(parent ? { parent: { author: parent.author, text: parent.text, date: iso(parent.at) } } : {}),
	};
}
