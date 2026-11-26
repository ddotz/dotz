// The rules that apply to one draft, read in one place: every way a draft is made or checked asks `draftRules` and nothing else builds a tone key, so a mail auto draft, a comment
// reply, the mail that rides on a comment reply (first write, revise, compose check) and the send check all see the same tone files, examples and bans.
// The configured instruction (rules.ts ruleInstruction) is matched once when a draft is first written and rides on `item.configured`, so a later revise reads what the write read.
// A send card the bot writes by hand (hub/reply-actions.ts) has no draft record to read these from: step 7 of the reply-draft plan brings it in as a stored draft; until then it reads none of them.
import { existsSync } from "node:fs";
import { replyAddress, type ReplyItem, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { boxById } from "./box.ts";
import type { EffectiveRules } from "./effective-rules.ts";
import { styleFrom, styleWithExamples } from "./pairs.ts";
import { webmailSite } from "./senders.ts";
import { lessonsOnly, loadStyle, profileApp, toneFile, validApp, type LoadedStyle, type ToneKey } from "./settings.ts";

/** Where the draft is: its app (a mail app instance, a comment source), a room, a profile of its own, the mailbox (`box` of mail app `instance`), the mail source, and for a comment the author's platform id (`authorId`) and the profile its own file falls back to (`base`). A DraftRec fits as it is. */
export type RuleAt = { app?: string; room?: string; profile?: string; box?: string; instance?: string; source?: string; base?: string; authorId?: string; /** the 자동 초안 규칙 that drafted it */ rule?: { id: string } };
export type RuleItem = Pick<ReplyItem, "kind" | "from" | "replyTo" | "self" | "text" | "profile">;
export type DraftRules = {
	/** The profile a draft's style is loaded with: the mailbox's file when it has one, else the app's, plus the recipient's own level (a mail's reply address; a comment's `at.authorId`). */
	key: ToneKey;
	/** `key` without the recipient level: where a lesson for this draft, not for this recipient, is written. */
	tone: ToneKey;
	/** The tone as written in the files (rules, corrections, 금지, recipient conditions), read when asked. */
	style: () => LoadedStyle;
	/** The style a prompt is built from: `style()` plus the owner's real past replies as examples (a mailbox with enough of its own replies shows only those); a comment keeps its own examples (hub/comments/draft-run.ts). */
	examples: () => Promise<ReplyStyle>;
	/** The style a draft is checked against (check-draft.ts): `style()` with the mailbox's 설정 금지 as bans. */
	checkStyle: () => LoadedStyle;
	/** Every rule that applies to this target with its scope, kind and the file:line it is written in, and the conflicts between them (effective-rules.ts); reads only. */
	effective: () => Promise<EffectiveRules>;
};

// A mail draft's style carries the user's closest real past replies of ITS source as examples (a site's own sent folder for its mails, zele's for zele's); chat
// and comments keep theirs. A zele pair does not say which account it came from, so a zele draft with a profile of its own gets none: another account's replies
// must not ride in its prompt.
export const pairSource = (source: string): string => webmailSite(source) ?? source;

/** The tone profile an item or draft belongs to: its room when it has one, else its own profile (a mail app instance's), else its app (mail unless it says otherwise). A draft made in a mailbox (box + instance) uses tone/<instance>/<box>.md when that file exists, falling back to the instance's profile (else the mail one), then the install. */
export function draftRules(at: RuleAt, item: RuleItem): DraftRules {
	const app = at.profile ?? profileApp(at.app ?? "mail");
	const base = at.base ?? (lessonsOnly(app) ? "mail" : undefined);
	const own: ToneKey = { app, ...(base ? { base } : {}), ...(at.room !== undefined ? { room: at.room } : {}) };
	const boxKey: ToneKey | undefined = at.box && at.instance && at.room === undefined && validApp(at.instance) ? { app: at.instance, room: at.box, ...(at.profile ? {} : { base: own.base ?? own.app }) } : undefined;
	const tone = boxKey && existsSync(toneFile(boxKey)) ? boxKey : own;
	const to = at.authorId ?? (item.kind === "mail" ? replyAddress(item) : undefined);
	const key: ToneKey = to === undefined ? tone : { ...tone, to };
	return {
		key,
		tone,
		style: () => loadStyle(key),
		async examples() {
			if (item.kind !== "mail") return loadStyle(key);
			// Loaded on use: only a mail in a mailbox pays for it.
			const mine = at.box && at.instance ? (await import("./box-voice.ts")).boxExamples(at.instance, at.box) : undefined;
			if (mine) return styleFrom(loadStyle(key), mine, item.text, item.from);
			const source = at.source === undefined ? undefined : pairSource(at.source);
			return item.profile && source === "zele" ? loadStyle(key) : styleWithExamples(loadStyle(key), "mail", item.text, item.from, source);
		},
		checkStyle() {
			const style = loadStyle(key), bans = at.box && at.instance ? boxById(at.instance, at.box)?.bans ?? [] : [];
			return bans.length ? { ...style, forbidden: [...style.forbidden, ...bans] } : style;
		},
		effective: async () => (await import("./effective-rules.ts")).effectiveRules(key, at, item),
	};
}
