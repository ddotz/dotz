// The gateway's hook for a new mail: when this install turned the feature on (and auto), a mail that warrants a reply gets a draft in
// the user's tone, offered as a send-approval [ask] (hub/draft-approval.ts). Never throws; nothing is sent from here.
import { addressesOf, precheck, withSenderAddress, type ReplyItem } from "../../../hub/reply-draft.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { asksForFile } from "../../../hub/draft-approval.ts";
import { askText, attachFolder, buildDraft, callOf, draftTrace, libraryFor, stageForReply, traceLine, type DraftTrace } from "./flow.ts";
import { anyRuleOn, mailInstanceOf, matchRule, ruleFileMissing, ruleInstruction, rulesOf, stageRuleFiles } from "./rules.ts";
import { learnFirst } from "./persona.ts";
import { appOn, ensureSwitch, loadSettings } from "./settings.ts";
import { addDraft, isDrafted, markDrafted } from "./store.ts";

export type OfferMail = { key: string; instruction?: string; messageId?: string; target: string; thread?: string; source: string; id: string; subject: string; from?: string; to?: string; summary?: string; body?: string; attachments?: { name: string; size?: number }[] };
export type OfferDeps = {
	send: (target: string, text: string) => unknown;
	call?: ModelCall;
	/** Picks among tied 첨부 파일 폴더 files by name (flow.ts stageForReply); tests inject it. */
	pick?: (names: string[]) => Promise<string[]>;
	/** The identity sweep: the model call, and the user's sent mail (persona.ts learnFirst), run once before the first draft. */
	analyze?: ModelCall;
	sentTexts?: () => Promise<string[]>;
	readBody?: (source: string, id: string) => Promise<string | undefined>;
	log?: (line: string) => void;
	/** Records the suggested action on the mail (hub/mail.ts setMailSuggest), for the web's suggestion slot of that mail. */
	suggest?: (key: string, s: { kind: "reply-draft"; label: string; ref: string; rule?: string }) => void;
};

// The text a model call sees is capped; a long thread's tail (quoted history) adds tokens and nothing for the reply.
const BODY_MAX = 8000;

// The cheap checks of offerOne, without side effects: a mail the feature is off for, already looked at, or that needs no reply is not read ahead.
function mayDraft(m: OfferMail): boolean {
	try {
		const settings = loadSettings();
		if (!(appOn(settings, "mail") || (rulesAllowed(settings) && anyRuleOn())) || isDrafted(m.messageId ? `${m.key}#${m.messageId}` : m.key)) return false;
		return !precheck({ kind: "mail", from: m.from ?? "", self: addressesOf(m.to), subject: m.subject, text: "" }, settings.senders, { addressLater: true });
	} catch {
		return false;
	}
}

// A 자동 초안 규칙 is its own opt-in: it drafts its mails while the app's 자동 초안 switch is off, but not on an install whose owner turned the
// whole feature off (onboard.ts off).
const rulesAllowed = (s: ReturnType<typeof loadSettings>) => !(s.decided && !s.enabled);

// Offers run one at a time: a burst of new mail never starts many model calls at once.
let chain: Promise<unknown> = Promise.resolve();
/** 초안 작성 on a mail (POST /api/mail/<key>/draft): the owner asked for a draft himself, so the auto-draft switch, the one-look-per-message mark and
 *  the sender filter do not apply, and the model must draft (ReplyItem.requested). The draft arrives like an offered one: the send-approval card
 *  in the mail's conversation and the 답장 초안 chip on its row. */
export function requestMailDraft(m: OfferMail, deps: OfferDeps): Promise<"offered" | "skipped" | "off" | "failed"> {
	const body = m.body !== undefined || !deps.readBody ? Promise.resolve(m.body) : deps.readBody(m.source, m.id).catch(() => undefined);
	const queued = Date.now();
	const next = chain.then(() => offerOne(m, deps, body, queued, true));
	chain = next.catch(() => undefined);
	return next;
}
export function offerMailDraft(m: OfferMail, deps: OfferDeps): Promise<"offered" | "skipped" | "off" | "failed"> {
	// The body read (a mail CLI or webmail round trip) starts now, while an earlier offer may still be in its model call; only the model calls queue.
	const body = m.body !== undefined || !deps.readBody || !mayDraft(m) ? Promise.resolve(m.body) : deps.readBody(m.source, m.id).catch(e => ((deps.log ?? console.error)(`reply draft: mail ${m.key} body not read: ${(e as Error).message}`), undefined));
	const queued = Date.now();
	const next = chain.then(() => offerOne(m, deps, body, queued));
	chain = next.catch(() => undefined);
	return next;
}

async function offerOne(m: OfferMail, deps: OfferDeps, body: Promise<string | undefined>, queued: number, requested = false): Promise<"offered" | "skipped" | "off" | "failed"> {
	const log = deps.log ?? ((line: string) => console.error(line));
	const started = Date.now();
	let trace: DraftTrace | undefined;
	try {
		const settings = loadSettings();
		const auto = appOn(settings, "mail");
		// The rules of the mail's own app instance; a mail of an instance without a rule switched on costs nothing more.
		const own = rulesAllowed(settings) ? await rulesOf(await mailInstanceOf(m.key)) : undefined;
		const rules = own?.rules.filter(r => r.on) ?? [];
		if (!requested && !auto && !rules.length) return "off";
		// One look per message: a newer message of the same thread (messageId) is looked at again, a repeat of the same one is not.
		const looked = m.messageId ? `${m.key}#${m.messageId}` : m.key;
		if (!requested && isDrafted(looked)) return "skipped";
		const item: ReplyItem = { kind: "mail", from: m.from ?? "", self: addressesOf(m.to), subject: m.subject, text: "", ...(requested ? { requested: true } : {}) };
		if (!requested && precheck(item, settings.senders, { addressLater: true })) {
			markDrafted(looked);
			return "skipped";
		}
		item.text = ((await body) ?? m.summary ?? "").trim().slice(0, BODY_MAX) || m.subject;
		// A source that reports the sender by name only: the address comes from the mail's own text (its quoted headers, the signature).
		item.from = withSenderAddress(item.from, item.text, item.self);
		if (!requested && precheck(item, settings.senders)) {
			markDrafted(looked);
			return "skipped";
		}
		// One budget for every model call of this draft: the rule match, the draft call and the file tie-break.
		trace = draftTrace();
		const flow = { call: deps.call, pick: deps.pick, trace };
		const rule = rules.length ? await matchRule({ from: item.from, subject: item.subject, text: item.text }, rules, callOf(flow, item, m.key, "rule")).catch(e => (log(`reply draft: rules for mail ${m.key} not matched: ${(e as Error).message}`), undefined)) : undefined;
		if (!requested && !auto && !rule) {
			markDrafted(looked);
			return "skipped";
		}
		const instruction = ruleInstruction(own?.base ?? "", rule, requested ? m.instruction?.trim().slice(0, 500) : undefined);
		if (instruction) item.instruction = instruction;
		const read = Date.now();
		if (deps.analyze && deps.sentTexts) await learnFirst({ app: "mail" }, deps.sentTexts, "메일 (보낸 메일함)", deps.analyze).catch(e => log(`reply draft: mail identity not learned: ${(e as Error).message}`));
		const learned = Date.now();
		// The file match (and its tie-break call, if any) runs beside the draft call; a rule that names its files stages those instead.
		const ruleFiles = !!rule?.files.length;
		const files = ruleFiles ? undefined : libraryFor(item, { source: m.source, ref: m.key }, flow).catch(e => (log(`reply draft: files for mail ${m.key} not matched: ${(e as Error).message}`), undefined));
		const built = await buildDraft(item, { source: m.source, mailId: m.id, ref: m.key, ...(m.attachments?.length ? { origAttachments: m.attachments.length } : {}) }, flow);
		if (built.action !== "draft") {
			markDrafted(looked);
			return "skipped";
		}
		ensureSwitch();
		if (rule) built.rec.rule = { id: rule.id, name: rule.name };
		const warnings = [...built.warnings];
		if (rule && ruleFiles) {
			built.rec.asksFile = asksForFile(item.text) || undefined;
			const missing = stageRuleFiles(built.rec.id, rule, await attachFolder(m.key));
			if (missing.length) warnings.push(ruleFileMissing(missing));
		} else await stageForReply(built.rec, flow, files).catch(e => log(`reply draft: files for mail ${m.key} not staged: ${(e as Error).message}`));
		await deps.send(m.thread ? `th:${m.thread}` : m.target, askText(built.rec, warnings));
		addDraft(built.rec);
		markDrafted(looked);
		deps.suggest?.(m.key, { kind: "reply-draft", label: "답장 초안", ref: built.rec.id, ...(rule ? { rule: rule.name } : {}) });
		// Where the time went, so a slow draft can be traced: queue wait, body read, identity sweep (first draft only), the draft model call and the rest.
		log(`reply draft: mail ${m.key} offered in ${Date.now() - queued}ms (queue ${started - queued}, body ${read - started}, identity ${learned - read}, draft+files ${Date.now() - learned})`);
		return "offered";
	} catch (e) {
		log(`reply draft: offer for mail ${m.key} failed: ${(e as Error).message}`);
		return "failed";
	} finally {
		// Every model call this draft made (skipped, failed or offered), so a slow or costly draft can be traced.
		if (trace) log(`reply draft: mail ${m.key} ${traceLine(trace)}`);
	}
}
