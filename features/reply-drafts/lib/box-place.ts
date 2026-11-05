// The mailbox a mail is in, as the gateway's offer sees it (docs/mailbox.md "Handling"): which box, and the judge boxes it may still move to.
// A mail in no stored box, or in a base box that sets nothing and has no voice of its own, has no box here: offer.ts then takes today's path with no extra call.
import { mailByKey, type MailRecord } from "../../../hub/mail.ts";
import { boxesOf, loadMailboxes, type Box } from "../../../hub/mailbox.ts";
import { boxPass, placeByJudge } from "../../../hub/routes-mailbox.ts";
import { dataDir, identityOf } from "./settings.ts";

export type BoxMail = { key: string; source: string; id: string; subject: string; from?: string };
export type BoxDeps = {
	/** The stored record of a mail (hub/mail.ts mailByKey); tests inject it. */
	mailOf?: (key: string) => MailRecord | undefined;
	/** Puts a mail in the box a judge chose (hub/routes-mailbox.ts placeByJudge); tests inject it. */
	place?: (key: string, box: string) => unknown;
};
export type BoxCtx = { box?: Box; /** The other boxes of the account that judge the content: only for a mail still in the base box. */ judges: Box[] };

const plain = (instance: string, b: Box): boolean => !!b.base && !b.mode && !b.how && !b.greets.length && !b.folders.length && !b.bans.length && !b.rules.length && !identityOf({ app: instance, room: b.id }).length;

/** The box of the mail now (its record's own, a pin, else base) and the judge boxes. No stored boxes for the account = nothing, after one cached stat. */
export function boxCtx(instance: string, m: BoxMail, deps: BoxDeps): BoxCtx {
	const dir = dataDir();
	if (!loadMailboxes(dir).accounts[instance]) return { judges: [] };
	const boxes = boxesOf(dir, instance);
	const rec = (deps.mailOf ?? mailByKey)(m.key) ?? { key: m.key, source: m.source, id: m.id, subject: m.subject, from: m.from ?? "", at: "" };
	const id = boxPass(dir)(rec).box, found = boxes.find(b => b.id === id);
	return { ...(found && !plain(instance, found) ? { box: found } : {}), judges: !found || found.base ? boxes.filter(b => !b.base && b.judge.on && b.judge.text) : [] };
}

/** A judge hit: the mail moves to `to` (record mbox, mwhy judge) before drafting. */
export const moveByJudge = (deps: BoxDeps, key: string, to: Box): unknown => (deps.place ?? placeByJudge)(key, to.id);
