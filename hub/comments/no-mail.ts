import { claimsAttachment, NO_CLAIM } from "../attach-claim.ts";
import { MAIL_PROMISE, PAIR_NOTE, asksForFile } from "../draft-approval.ts";
import type { Comment, SourceConfig } from "./contract.ts";
import type { Draft, Store } from "./store.ts";

/** The card line of a comment whose mail app is not set, so no mail draft was written. */
export const MAIL_NO_APP_NOTE = "확인: 메일 앱이 정해지지 않아 메일 초안은 만들지 않았어요";
/** The card line of a linked mail whose compose failed; the reason follows after " - ". */
export const MAIL_FAILED_NOTE = "확인: 메일 초안을 만들지 못했어요";
/** The card line prefix of a task the owner does beside the reply (the model's extra), which covers what the reply promises. */
export const EXTRA_NOTE = "함께 할 일: ";
/** The send refusal of a reply that promises a mail or a file no mail carries. */
export const NO_MAIL_REFUSED = "답글은 메일이나 파일을 보낸다고 하는데 함께 보낼 메일이 없어요";
/** A mail address as a comment writes it. */
export const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const NO_MAIL_NOTE = "확인: 메일 초안이 없어요";
const CONDITION_WORD = /(?:시면|으면|다면|라면|하면|되면|[기리이니]면),?$|^(?:if|once|when|unless),?$/i;
const EARLIER_MAIL = /(?:보내\s*드린|보내\s*드렸던|보낸|보냈던)\s*\S+|보내\s*주(?:신|셨던)\s*\S+/g;
const ASKING_THEM = /(?:보내|전달해|발송해|전송해)\s*(?:주세요|주시|주십|주실|줘|줄래|달라)\S*/g;
const DECLINING = /어려|어렵|힘들|곤란|불가|수\s*없|못\s*(?:보내|드리)|드리지\s*못|지\s*않|안\s*(?:돼|됩)|\b(?:can'?t|cannot|won'?t|unable|not)\b|n't\b/i;
const EMAILS_THEM = /\be-?mail(?:ed|ing)?\s+(?:you|it|them|that|this|these|those|the|your|a|an|over|out|across|back)\b/i;
const ASKS_IN_ENGLISH = /\b(?:please|pls|kindly|could you|can you|would you|will you)\b|\byou(?:'ve|\s+have|\s+just)?\s+e-?mailed\b|\bfor\s+e-?mail(?:ing|ed)\b/i;

const beforeCondition = (sentence: string): string => {
	const words = sentence.split(/\s+/);
	const at = words.findIndex(w => CONDITION_WORD.test(w));
	return at < 0 ? sentence : words.slice(0, at).join(" ");
};
const promisesInSentence = (sentence: string): boolean => {
	const head = beforeCondition(sentence).replace(EARLIER_MAIL, " ").replace(ASKING_THEM, " ");
	if (DECLINING.test(head) || NO_CLAIM.test(head)) return false;
	return MAIL_PROMISE.test(head) || claimsAttachment(head) || (EMAILS_THEM.test(head) && !ASKS_IN_ENGLISH.test(head));
};
/** Whether some sentence of a reply promises a mail or a file; a condition, a refusal, an ask back or a mail sent earlier promises nothing. */
export const promisesMail = (text: string): boolean => text.split(/(?<=[.!?。])\s+|\n+/).some(promisesInSentence);

/** Whether writing the reply to `c` also writes its linked mail draft (engine.ts linkMail): the comment asks for a file and names an address. */
export const mailPlanned = (c: Comment, src: SourceConfig, mailOn: boolean): boolean => mailOn && !!src.autoMail && !!src.mailApp && asksForFile(c.text) && ADDRESS.test(c.text);

function noMailReason(c: Comment, src: SourceConfig, mailOn: boolean): string {
	if (!src.autoMail) return "이 출처는 메일 자동 초안이 꺼져 있어요";
	if (!mailOn) return "메일을 쓸 수 없어요";
	if (!asksForFile(c.text)) return "파일 요청이 아니에요";
	if (!ADDRESS.test(c.text)) return "주소가 없어요";
	if (!src.mailApp) return "메일 앱이 정해지지 않았어요";
	return "메일을 만들지 못했어요";
}

/** What the no-mail check reads: the engine's store and lookups, `covered` (a mail goes or went with the draft) and whether mail can be written at all. */
export type NoMailCtx = { store: Store; emit: (e: Record<string, unknown>) => void; find: (id: string) => Comment | undefined; sourceOf: (key: string) => SourceConfig | undefined; covered: (d: Draft) => boolean; mailOn: boolean };

/** Sets the "메일 초안이 없어요" line of the pending draft `code` fresh: there while its reply promises a mail none covers and no other line says why, gone otherwise. */
export function checkNoMail(ctx: NoMailCtx, code: string): Draft | undefined {
	const d = ctx.store.drafts().find(x => x.code === code && x.status === "pending");
	if (!d) return undefined;
	const c = ctx.find(d.commentId);
	const src = ctx.sourceOf(d.source);
	const kept = d.notes.filter(n => !n.startsWith(NO_MAIL_NOTE));
	const explained = kept.some(n => n === MAIL_NO_APP_NOTE || n.startsWith(MAIL_FAILED_NOTE) || PAIR_NOTE.test(n));
	const added = c && src && !explained && !ctx.covered(d) && promisesMail(d.text) ? [`${NO_MAIL_NOTE} (${noMailReason(c, src, ctx.mailOn)})`] : [];
	const notes = [...kept, ...added];
	if (notes.join("\n") === d.notes.join("\n")) return d;
	const next: Draft = { ...d, notes, ...(added.length ? { clean: false } : {}) };
	ctx.store.putDraft(next);
	ctx.emit({ kind: "comment_draft", source: d.source, thread: d.thread });
	return next;
}
