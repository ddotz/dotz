// The one check a draft passes before its card (and again, without the model, when it is sent): bans (the tone files' literals, patterns and wording rules, the mailbox's 설정 금지),
// placeholders, the recipient, the length and the style judge with the owner's content bans. Every path that makes a draft (mail auto draft, compose, the mail riding on a comment
// reply, a revise) calls checkDraft once and keeps the result on the record (`rec.check`); the card and the send read it (flow.ts askText, draftAttachIssues, sendDraft).
// A recipient, length or placeholder finding refuses the send. A ban the text still holds after the one rewrite, and a judge note, are warnings: the owner sends the draft
// only by 이대로 보내기 (hub/draft-approval.ts), and no auto-send takes it.
import { lintReply, ownerLint, styleConditions } from "../../../hub/reply-draft.ts";
import { type JudgeAsk, judgeStyle, styleWarnings } from "../../../hub/style-judge.ts";
import { draftRules } from "./draft-rules.ts";
import { type DraftCheck, type DraftRec, getDraft, patchDraft } from "./store.ts";

const BAN_FINDING = /^it uses the forbidden expression |^it breaks the owner's wording rule /;

/** The findings of `rec` now, with `judged` (the style judge's notes, kept from the check that asked the model) as they are: no model, so the send and the card read it as often as they like. */
export function checkText(rec: DraftRec, judged: readonly string[]): DraftCheck {
	const found = (rec.editedFrom !== undefined ? ownerLint : lintReply)({ to: rec.to, cc: rec.cc, subject: rec.subject, body: rec.body }, rec.item, draftRules(rec, rec.item).checkStyle(), { anyRecipient: rec.ownerRecipients === true });
	return { refuse: found.filter(f => !BAN_FINDING.test(f)), warn: [...found.filter(f => BAN_FINDING.test(f)), ...judged], judged: [...judged] };
}

/** The check as it was stored, its text-only part read again (an owner who set the recipients since changes what refuses). A draft with no stored check reads as unjudged. */
export const readCheck = (rec: DraftRec): DraftCheck => checkText(rec, rec.check?.judged ?? []);

/** The one check before a card: `judged` = the notes the call that wrote the text already got from the style judge (none asked again); without it `judge` is asked once. Stored on `rec` (and in the store when `rec` is in it). */
export async function checkDraft(rec: DraftRec, judge: JudgeAsk | undefined, judged?: readonly string[]): Promise<DraftCheck> {
	const check = checkText(rec, judged ?? (await judgeNotes(rec, judge)));
	rec.check = check;
	if (getDraft(rec.id)) patchDraft(rec.id, { check });
	return check;
}

async function judgeNotes(rec: DraftRec, judge: JudgeAsk | undefined): Promise<string[]> {
	if (!judge) return [];
	const { standing, corrections, recipient, contentBans } = styleConditions(draftRules(rec, rec.item).checkStyle());
	if (!standing.length && !corrections.length && !recipient && !contentBans) return [];
	return styleWarnings(await judgeStyle({ standing, corrections, ...(recipient ? { recipient } : {}), ...(contentBans ? { contentBans } : {}), received: rec.request ?? rec.item.text, draft: rec.body }, judge));
}
