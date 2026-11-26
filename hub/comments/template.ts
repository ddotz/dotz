// A comment source's fixed texts (SourceConfig.template, off by default): for a comment that asks for a file and names an address, the reply and the mail that rides on it
// are the owner's own text with {author} (the commenter's name) and {title} (the post's title) filled in. The text is used as is, the model never writes or rewrites it;
// it only goes through the checks every draft passes (the comment reply's lint, the mail's checkDraft), and a banned phrase is told when the template is saved.
import { banHit, banLabel, parseBan } from "../ban.ts";
import { asksForFile } from "../draft-approval.ts";
import { lintReply, type ReplyItem, type ReplyResult, type ReplyStyle } from "../reply-draft.ts";
import { type Comment, isUntitled, type SourceConfig, type SourceTemplate } from "./contract.ts";
import { ADDRESS } from "./no-mail.ts";

const TITLE_MAX = 60;
/** The post's title as the mail's subject and the library search take it; "" when the platform gave none. */
export const postTitleOf = (c: Pick<Comment, "postTitle">): string => (isUntitled(c) ? "" : c.postTitle.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX));

/** The text of `part` filled for comment `c`; undefined when the source has no such template or the comment is no file request with an address. */
export function templateText(src: SourceConfig, c: Comment, part: keyof SourceTemplate): string | undefined {
	const text = src.template?.[part]?.trim();
	if (!text || !asksForFile(c.text) || !ADDRESS.test(c.text)) return undefined;
	return text.replaceAll("{author}", c.author).replaceAll("{title}", postTitleOf(c));
}

/** The reply as the model's would come back, with the template as its body: no model call, the lint findings as its warnings. */
export const fixedReply = (body: string, item: ReplyItem, style: ReplyStyle): Extract<ReplyResult, { action: "draft" }> => ({ action: "draft", draft: { to: item.from, body }, questions: [], warnings: lintReply({ to: item.from, body }, item, style), tries: 0 });

/** `patch` over the stored template: an empty text clears that part, and no part left clears the template. */
export function withTemplate(cur: SourceTemplate | undefined, patch: SourceTemplate): SourceTemplate | undefined {
	const next: SourceTemplate = { ...cur };
	for (const part of ["reply", "mail"] as const) {
		const text = patch[part];
		if (text === undefined) continue;
		if (text.trim()) next[part] = text;
		else delete next[part];
	}
	return next.reply || next.mail ? next : undefined;
}

/** What the rules of each target ban that its template holds: the comment source's tone for the reply, the mail app's for the mail (`mailBans`; the mailbox of the recipient is only known when a mail is made). */
export function templateWarnings(src: SourceConfig, style: Pick<ReplyStyle, "forbidden"> | undefined, mailBans: readonly string[] | undefined): string[] {
	const held = (label: string, text: string | undefined, bans: readonly string[] = []): string[] => (text ? bans.map(parseBan).filter(b => banHit(text, b)).map(b => `${label} 틀에 금지 표현이 있어요: ${banLabel(b)}`) : []);
	return [...held("답글", src.template?.reply, style?.forbidden), ...held("메일", src.template?.mail, mailBans)];
}
