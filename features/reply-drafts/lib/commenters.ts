import type { Comment } from "../../../hub/comments/contract.ts";
import { recipientFile } from "./settings.ts";

const CARD_HINT = '대신 그분 댓글 카드에서 답글을 "이분께는 ..."처럼 고쳐 주세요';

const sameAs = (a: string, b: string | undefined): boolean => b !== undefined && recipientFile(a) !== undefined && recipientFile(a) === recipientFile(b);
const others = (comments: Comment[], source: string): Comment[] => comments.filter(c => c.source === source && !c.mine).sort((a, b) => b.at - a.at);

/** The newest display name the stored comments of `source` show for the author with platform id `id` (ids compared as recipientFile normalises them); undefined when none has that id. */
export function authorName(comments: Comment[], source: string, id: string): string | undefined {
	return others(comments, source).find(c => sameAs(id, c.authorId))?.author;
}

/** The commenter `value` names in `source` (`draft.ts correct|tone --to`): a stored `authorId`, else the one author whose stored display name it is (compared as recipientFile normalises it); else why not, as one Korean line: no stored comment of the source has an id yet, the name is only on comments stored without an id, the name is unknown, or several authors share it. */
export function commentRecipient(comments: Comment[], source: string, value: string): { id: string; name: string } | { refused: string } {
	const own = others(comments, source);
	if (own.length && !own.some(c => c.authorId)) return { refused: `${source}에서 모은 댓글에는 쓴 사람을 가릴 아이디가 아직 없어요. 유튜브와 인스타그램은 새 댓글이 들어오면 정할 수 있고, 웹사이트 댓글은 아이디가 없어서 한 사람에게만 정할 수 없어요` };
	const byId = own.find(c => sameAs(value, c.authorId));
	if (byId?.authorId !== undefined) return { id: byId.authorId, name: byId.author };
	const named = own.filter(c => sameAs(value, c.author));
	const ids = [...new Set(named.flatMap(c => (c.authorId !== undefined ? [c.authorId] : [])))];
	const [id] = ids;
	if (ids.length === 1 && id !== undefined) return { id, name: authorName(comments, source, id) ?? value };
	if (ids.length > 1) return { refused: `${source}에서 모은 댓글에 '${value}'(이)라는 이름을 쓰는 사람이 ${ids.length}명이라 누구인지 알 수 없어요. ${CARD_HINT}` };
	if (named.length) return { refused: `'${value}'님의 댓글은 아이디 없이 모은 예전 댓글뿐이에요. 그분의 새 댓글이 들어오면 정할 수 있어요` };
	return { refused: `${source}에서 모은 댓글에 '${value}'(이)라는 이름이나 아이디가 없어요. 그분 댓글이 들어오면 그 카드에서 답글을 "이분께는 ..."처럼 고쳐도 돼요` };
}
