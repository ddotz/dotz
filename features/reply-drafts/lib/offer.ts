// The gateway's hook for a new mail: when this install turned the feature on (and auto), a mail that warrants a reply gets a draft in
// the user's tone, offered as a send-approval [ask] (hub/draft-approval.ts). Never throws; nothing is sent from here.
import { addressesOf, precheck, type ReplyItem } from "../../../hub/reply-draft.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { askText, buildDraft } from "./flow.ts";
import { learnFirst } from "./persona.ts";
import { appOn, ensureSwitch, loadSettings } from "./settings.ts";
import { addDraft, isDrafted, markDrafted } from "./store.ts";

export type OfferMail = { key: string; target: string; thread?: string; source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string };
export type OfferDeps = {
	send: (target: string, text: string) => unknown;
	call?: ModelCall;
	/** The identity sweep: the model call, and the user's sent mail (persona.ts learnFirst), run once before the first draft. */
	analyze?: ModelCall;
	sentTexts?: () => Promise<string[]>;
	readBody?: (source: string, id: string) => Promise<string | undefined>;
	log?: (line: string) => void;
	/** Records the suggested action on the mail (hub/mail.ts setMailSuggest), for the web's suggestion slot of that mail. */
	suggest?: (key: string, s: { kind: "reply-draft"; label: string; ref: string }) => void;
};

// The text a model call sees is capped; a long thread's tail (quoted history) adds tokens and nothing for the reply.
const BODY_MAX = 8000;

// Offers run one at a time: a burst of new mail never starts many model calls at once.
let chain: Promise<unknown> = Promise.resolve();
export function offerMailDraft(m: OfferMail, deps: OfferDeps): Promise<"offered" | "skipped" | "off" | "failed"> {
	const next = chain.then(() => offerOne(m, deps));
	chain = next.catch(() => undefined);
	return next;
}

async function offerOne(m: OfferMail, deps: OfferDeps): Promise<"offered" | "skipped" | "off" | "failed"> {
	const log = deps.log ?? ((line: string) => console.error(line));
	try {
		const settings = loadSettings();
		if (!appOn(settings, "mail")) return "off";
		if (isDrafted(m.key)) return "skipped";
		const item: ReplyItem = { kind: "mail", from: m.from ?? "", self: addressesOf(m.to), subject: m.subject, text: "" };
		if (precheck(item, settings.senders)) {
			markDrafted(m.key);
			return "skipped";
		}
		item.text = (m.body ?? (await deps.readBody?.(m.source, m.id).catch(e => (log(`reply draft: mail ${m.key} body not read: ${(e as Error).message}`), undefined))) ?? m.summary ?? "").trim().slice(0, BODY_MAX) || m.subject;
		if (deps.analyze && deps.sentTexts) await learnFirst({ app: "mail" }, deps.sentTexts, "메일 (보낸 메일함)", deps.analyze).catch(e => log(`reply draft: mail identity not learned: ${(e as Error).message}`));
		const built = await buildDraft(item, { source: m.source, mailId: m.id, ref: m.key }, { call: deps.call });
		if (built.action === "skip") {
			markDrafted(m.key);
			return "skipped";
		}
		ensureSwitch();
		await deps.send(m.thread ? `th:${m.thread}` : m.target, askText(built.rec, built.warnings));
		addDraft(built.rec);
		deps.suggest?.(m.key, { kind: "reply-draft", label: "답장 초안", ref: built.rec.id });
		return "offered";
	} catch (e) {
		log(`reply draft: offer for mail ${m.key} failed: ${(e as Error).message}`);
		return "failed";
	}
}
