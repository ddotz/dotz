// The gateway's hook for a new mail: when this install turned the feature on (and auto), a mail that warrants a reply gets a draft in
// the user's tone, offered as a send-approval [ask] (hub/draft-approval.ts). Never throws; nothing is sent from here.
import { addressesOf, precheck, withSenderAddress, type ReplyItem } from "../../../hub/reply-draft.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { asksForFile } from "../../../hub/draft-approval.ts";
import { threadText } from "../../../hub/zele.ts";
import { ownAddresses } from "../../../hub/mail-state.ts";
import { threadIdOf, webmailSite } from "./senders.ts";
import { retryWanted, type StageOpts, type Want } from "./staged.ts";
import { askText, attachFolder, buildDraft, callOf, candidatesFor, chosenFrom, draftTrace, libraryFor, stageForReply, traceLine, type DraftTrace } from "./flow.ts";
import { anyRuleOn, mailInstanceOf, matchRule, ruleFileMissing, ruleInstruction, rulesOf, stageRuleFiles } from "./rules.ts";
import { learnFirst, MAIL_TONE_VERSION } from "./persona.ts";
import { appOn, ensureSwitch, loadSettings } from "./settings.ts";
import { addDraft, isDrafted, markDrafted } from "./store.ts";

export type OfferMail = { account?: string; key: string; /** false: the gateway judged the mail needs no reply (hub/mail.ts); only a draft rule drafts it then */ needs?: boolean; instruction?: string; messageId?: string; target: string; thread?: string; source: string; id: string; subject: string; from?: string; to?: string; cc?: string; summary?: string; body?: string; attachments?: { name: string; size?: number }[] };
export type OfferDeps = {
	send: (target: string, text: string) => unknown;
	call?: ModelCall;
	/** Picks among tied 첨부 파일 폴더 files by name (flow.ts stageForReply); tests inject it. */
	pick?: (names: string[]) => Promise<string[]>;
	/** How 첨부 파일 폴더 files are copied onto the draft (staged.ts stageLibraryFile); tests inject it. */
	stage?: StageOpts;
	/** The identity sweep: the model call, and the user's sent mail (persona.ts learnFirst), run once before the first draft. */
	analyze?: ModelCall;
	sentTexts?: () => Promise<string[]>;
	readBody?: (source: string, id: string, account?: string) => Promise<string | undefined>;
	/** Lines `<date> <subject>: <snippet>` of earlier mail from one sender, the current thread left out (senders.ts senderHistory); started beside the body read. */
	history?: (address: string, account?: string, thread?: string) => Promise<string[]>;
	/** Keeps the past reply pairs current (tone.ts refreshPairs); fire and forget beside the identity sweep. */
	refreshPairs?: () => Promise<void>;
	log?: (line: string) => void;
	/** Records the suggested action on the mail (hub/mail.ts setMailSuggest), for the web's suggestion slot of that mail. */
	suggest?: (key: string, s: { kind: "reply-draft"; label: string; ref: string; rule?: string }) => void;
	/** The owner's own addresses (hub/mail-state.ts ownAddresses in the gateway): never a recipient of 전체 답장. Absent = the mail's 받는 사람. */
	own?: () => string[];
};

// The text a model call sees is capped; a long thread's tail (quoted history) adds tokens and nothing for the reply.
const BODY_MAX = 8000;

// The full text of a mail, read before the poster's snippet is trusted (a watch posts a 300-character snippet as `body`); the snippet is the fallback.
// A webmail watch posts the mail it already read: reading it again costs a site round trip and adds nothing.
// The account: the poster's, else for a source that is not zele the first address the mail came to (a category of one mailbox).
const accountOf = (m: OfferMail): string | undefined => m.account || (m.source !== "zele" ? addressesOf(m.to)[0] : undefined);
function fullBody(m: OfferMail, deps: OfferDeps): Promise<string | undefined> {
	if (!deps.readBody || (m.body !== undefined && webmailSite(m.source))) return Promise.resolve(m.body);
	return deps.readBody(m.source, m.id, accountOf(m)).then(t => t ?? m.body, e => ((deps.log ?? console.error)(`reply draft: mail ${m.key} body not read: ${(e as Error).message}`), m.body));
}

// One pair refresh at a time; it never delays or fails a draft.
let refreshing = false;
function refreshPairs(deps: OfferDeps, log: (line: string) => void): void {
	if (!deps.refreshPairs || refreshing) return;
	refreshing = true;
	deps.refreshPairs().catch(e => log(`reply draft: past mail pairs not refreshed: ${(e as Error).message}`)).finally(() => void (refreshing = false));
}

// Earlier mail from the sender: never delays a draft past this long, and a failure is no history.
const HISTORY_WAIT_MS = 8000;
function startHistory(m: OfferMail, deps: OfferDeps): Promise<string[]> {
	const address = addressesOf(m.from)[0];
	if (!deps.history || !address) return Promise.resolve([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<string[]>(done => void (timer = setTimeout(() => done([]), HISTORY_WAIT_MS)));
	return Promise.race([deps.history(address, accountOf(m), threadIdOf(m.source, m.id)).catch(() => [] as string[]), late]).finally(() => clearTimeout(timer));
}

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
	const body = fullBody(m, deps), history = startHistory(m, deps);
	const queued = Date.now();
	const next = chain.then(() => offerOne(m, deps, body, history, queued, true));
	chain = next.catch(() => undefined);
	return next;
}
export function offerMailDraft(m: OfferMail, deps: OfferDeps): Promise<"offered" | "skipped" | "off" | "failed"> {
	// The body read (a mail CLI or webmail round trip) starts now, while an earlier offer may still be in its model call; only the model calls queue.
	const may = mayDraft(m);
	const body = may ? fullBody(m, deps) : Promise.resolve(m.body), history = may ? startHistory(m, deps) : Promise.resolve([] as string[]);
	const queued = Date.now();
	const next = chain.then(() => offerOne(m, deps, body, history, queued));
	chain = next.catch(() => undefined);
	return next;
}

async function offerOne(m: OfferMail, deps: OfferDeps, body: Promise<string | undefined>, history: Promise<string[]>, queued: number, requested = false): Promise<"offered" | "skipped" | "off" | "failed"> {
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
		if (!requested && m.needs === false && !rules.length) return "off";
		// One look per message: a newer message of the same thread (messageId) is looked at again, a repeat of the same one is not.
		const looked = m.messageId ? `${m.key}#${m.messageId}` : m.key;
		if (!requested && isDrafted(looked)) return "skipped";
		const item: ReplyItem = { kind: "mail", from: m.from ?? "", self: deps.own?.() ?? addressesOf(m.to), to: addressesOf(m.to), ...(m.cc ? { cc: addressesOf(m.cc) } : {}), subject: m.subject, text: "", ...(requested ? { requested: true } : {}), ...(requested && m.instruction?.trim() ? { instruction: m.instruction.trim().slice(0, 500) } : {}) };
		if (!requested && precheck(item, settings.senders, { addressLater: true })) {
			markDrafted(looked);
			return "skipped";
		}
		// A thread read: the newest message of the sender is the text, the earlier ones the context. Any other text is the text. A read with no text of its own
		// (a mail of html or images only) leaves what the poster gave.
		const thread = threadText((await body) ?? m.summary ?? "", ownAddresses(item.self));
		item.text = (thread.text.trim() || m.body?.trim() || m.summary?.trim() || "").slice(0, BODY_MAX) || m.subject;
		const earlier = await history;
		const context = [thread.context, ...(earlier.length ? ["Earlier mail from this sender:", ...earlier] : [])].filter(Boolean).join("\n");
		if (context) item.context = context;
		// A source that reports the sender by name only: the address comes from the mail's own text (its quoted headers, the signature).
		item.from = withSenderAddress(item.from, item.text, item.self);
		if (!requested && precheck(item, settings.senders)) {
			markDrafted(looked);
			return "skipped";
		}
		// One budget for every model call of this draft: the rule match, the draft call and the file tie-break.
		trace = draftTrace();
		// A short wait for an iCloud file to come back (the offer queue waits on this draft); what is still away is retried in the background (wantFiles).
		const flow = { call: deps.call, pick: deps.pick, trace, stage: { tries: 5, ...deps.stage } };
		const rule = rules.length ? await matchRule({ from: item.from, subject: item.subject, text: item.text }, rules, callOf(flow, item, m.key, "rule")).catch(e => (log(`reply draft: rules for mail ${m.key} not matched: ${(e as Error).message}`), undefined)) : undefined;
		if (!requested && !auto && !rule) {
			markDrafted(looked);
			return "skipped";
		}
		const instruction = ruleInstruction(own?.base ?? "", rule, requested ? m.instruction?.trim().slice(0, 500) : undefined);
		if (instruction) item.instruction = instruction;
		const read = Date.now();
		refreshPairs(deps, log);
		if (deps.analyze && deps.sentTexts) await learnFirst({ app: "mail" }, deps.sentTexts, "메일 (보낸 메일함)", deps.analyze, undefined, MAIL_TONE_VERSION).catch(e => log(`reply draft: mail identity not learned: ${(e as Error).message}`));
		const learned = Date.now();
		// The files are picked BEFORE the words are written, so the draft is told which files ride on it (and that none fits) and its text agrees
		// with the attachments. A rule that names its files stages those instead.
		const ruleFiles = !!rule?.files.length;
		// The model chooses among candidates (the rule's files first, then the library matches); no model call picks them.
		const asked = asksForFile(item.text);
		const cands = ruleFiles || asked ? await candidatesFor(item, { source: m.source, ref: m.key }, rule).catch(e => (log(`reply draft: files for mail ${m.key} not matched: ${(e as Error).message}`), undefined)) : undefined;
		if (cands?.files.length) item.candidates = cands.files.map(f => f.rel);
		else if (cands && asked) item.files = [];
		const built = await buildDraft(item, { source: m.source, mailId: m.id, ref: m.key, ...(m.account ? { account: m.account } : {}), ...(m.attachments?.length ? { origAttachments: m.attachments.length } : {}) }, flow);
		if (built.action !== "draft") {
			markDrafted(looked);
			return "skipped";
		}
		// A mail draft starts as 답장 (the sender alone); the card's 전체 답장 switch reads the original's 받는 사람·참조 from the mail record.
		built.rec.mode = "reply";
		ensureSwitch();
		if (rule) built.rec.rule = { id: rule.id, name: rule.name };
		const warnings = [...built.warnings];
		const chosen = chosenFrom(cands, built.files);
		const notStaged = (e: Error): string[] => (log(`reply draft: files for mail ${m.key} not staged: ${e.message}`), []);
		if (chosen) {
			// Exactly what the model chose; with no `files` in its answer (chosen undefined) the matching below is today's.
			warnings.push(...(await stageForReply(built.rec, flow, Promise.resolve(chosen)).catch(notStaged)));
			if (cands?.missing.length) warnings.push(ruleFileMissing(cands.missing));
		} else if (rule && ruleFiles) {
			built.rec.asksFile = asksForFile(item.text) || undefined;
			const later = { want: [] as Want[], why: [] as string[] };
			const missing = await stageRuleFiles(built.rec.id, rule, await attachFolder(m.key), flow.stage, later);
			if (later.want.length) built.rec.wantFiles = later.want;
			warnings.push(...later.why);
			if (missing.length) warnings.push(ruleFileMissing(missing));
		} else warnings.push(...(await stageForReply(built.rec, flow).catch(notStaged)));
		await deps.send(m.thread ? `th:${m.thread}` : m.target, askText(built.rec, warnings));
		addDraft(built.rec);
		if (built.rec.wantFiles?.length) retryWanted(built.rec.id, flow.stage);
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
