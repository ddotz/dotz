// The gateway's hook for a new mail: when this install turned the feature on (and auto), a mail that warrants a reply gets a draft in
// the user's tone, offered as a send-approval [ask] (hub/draft-approval.ts). Never throws; nothing is sent from here.
import { addressesOf, precheck, usableReplyTo, withSenderAddress, type ReplyItem } from "../../../hub/reply-draft.ts";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import type { DraftBrief } from "../../../hub/mail-lines.ts";
import { hasBoxes } from "../../../hub/mailbox.ts";
import { threadText, type RawReplyTo } from "../../../hub/zele.ts";
import { ownAddresses } from "../../../hub/mail-state.ts";
import { threadIdOf, webmailSite } from "./senders.ts";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { retryWanted, stagedName, stageFiles, type StageOpts, type Want } from "./staged.ts";
import { askText, attachFolder, buildDraft, callOf, candidatesFor, chosenFrom, draftTrace, mailAsksFile, replyCall, settleDraft, stageForReply, styleKey, traceLine, type DraftTrace } from "./flow.ts";
import { compactForPrompt } from "./compact.ts";
import { anyRuleOn, mailInstanceOf, matchMail, ruleFileMissing, ruleInstruction, rulesOf, stageRuleFiles, type MailMatch } from "./rules.ts";
import { banWarnings, boxFolders, boxLines, boxRules, noAutoDraft } from "./box.ts";
import { boxCtx, moveByJudge, type BoxDeps } from "./box-place.ts";
import { learnFirst, MAIL_TONE_VERSION } from "./persona.ts";
import { appOn, dataDir, ensureSwitch, hasOwnTone, loadSettings, markLearned, readLearned, writeAtomic } from "./settings.ts";
import { addDraft, draftHeads, isDrafted, markDrafted } from "./store.ts";
import { FairQueue } from "./fair-queue.ts";
import type { OnSentRead, Runner } from "./tone.ts";

export type OfferMail = { account?: string; key: string; /** The card's first line instead of the usual one (hub/mail-unanswered.ts). */ headline?: string; /** false: the gateway judged the mail needs no reply (hub/mail.ts); only a draft rule drafts it then */ needs?: boolean; instruction?: string; messageId?: string; target: string; thread?: string; source: string; id: string; subject: string; from?: string; to?: string; cc?: string; replyTo?: string; summary?: string; body?: string; attachments?: { name: string; size?: number }[]; /** files the poster already chose for the reply (hub/mail.ts reply_files) */ replyFiles?: { path: string }[] };
export type OfferDeps = BoxDeps & {
	send: (target: string, text: string) => unknown;
	call?: ModelCall;
	judge?: ModelCall;
	/** The mail as its draft card shows it (hub/mail.ts mailDraftBrief); without it the card has the sender and summary the offer came with. */
	brief?: (key: string) => DraftBrief | undefined;
	/** Picks among tied 첨부 파일 폴더 files by name (flow.ts stageForReply); tests inject it. */
	pick?: (names: string[]) => Promise<string[]>;
	/** How 첨부 파일 폴더 files are copied onto the draft (staged.ts stageLibraryFile); tests inject it. */
	stage?: StageOpts;
	/** The identity sweep: the model call, and the user's sent mail (persona.ts learnFirst), run once before the first draft. */
	analyze?: ModelCall;
	sentTexts?: (onRead: OnSentRead) => Promise<string[]>;
	readBody?: (source: string, id: string, account?: string) => Promise<string | undefined>;
	/** Lines `<date> <subject>: <snippet>` of earlier mail from one sender, the current thread left out (senders.ts senderHistory); started beside the body read. */
	history?: (address: string, account?: string, thread?: string) => Promise<string[]>;
	/** Keeps the past reply pairs current (tone.ts refreshPairs); fire and forget, on a mail's arrival and beside the identity sweep. */
	refreshPairs?: () => Promise<void>;
	/** Runs zele to settle the account of a new draft (flow.ts settleDraft); without it the send does. */
	run?: Runner;
	log?: (line: string) => void;
	/** Records the suggested action on the mail (hub/mail.ts setMailSuggest), for the web's suggestion slot of that mail. */
	suggest?: (key: string, s: { kind: "reply-draft"; label: string; ref: string; rule?: string; state?: "waiting" }) => void;
	/** The owner's own addresses for a mail source (hub/mail-state.ts ownAddressesFor in the gateway): never a recipient of 전체 답장, and a mail from one gets no draft. Absent = the mail's 받는 사람. */
	own?: (source: string) => string[];
	replyTo?: (m: OfferMail) => Promise<RawReplyTo | undefined>;
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

// One pair read at a time, shared by a mail's arrival and its draft; it never delays or fails a draft.
let reading: Promise<void> | undefined;
const readPairs = (run: () => Promise<void>, log: (line: string) => void): Promise<void> =>
	(reading ??= run().catch(e => log(`reply draft: past mail pairs not refreshed: ${(e as Error).message}`)).finally(() => void (reading = undefined)));

function readOnArrival(deps: OfferDeps): void {
	if (deps.refreshPairs && rulesAllowed(loadSettings())) void readPairs(deps.refreshPairs, deps.log ?? console.error);
}

const DAY = 24 * 60 * 60 * 1000;
const EMPTY_LOG = "mail~empty-logged";

async function learnMailIdentity(analyze: ModelCall, sentTexts: NonNullable<OfferDeps["sentTexts"]>, log: (line: string) => void): Promise<void> {
	if (new Date().getTime() - Date.parse(readLearned()[EMPTY_LOG] ?? "") < DAY) return;
	const read: string[] = [];
	let found = 0;
	const source = async (): Promise<string[]> => {
		const texts = await sentTexts((name, count) => void read.push(`${name} ${count}`));
		found = texts.length;
		return texts;
	};
	let failed = false;
	const result = await learnFirst({ app: "mail" }, source, "메일 (보낸 메일함)", analyze, undefined, MAIL_TONE_VERSION).catch(e => (failed = true, log(`reply draft: mail identity not learned: ${(e as Error).message}`), undefined));
	if (result !== "empty" && !failed) return;
	markLearned([EMPTY_LOG], new Date());
	if (!failed) log(`reply draft: mail identity not learned: ${found ? `${found} sent texts read, the analysis gave no identity` : "no sent text found"} (sources read: ${read.join(", ") || "none"})`);
}

// A draft keeps the pairs current too, and the mailboxes' voices are learned from what they kept; only an account with mailboxes loads that code.
let voicing = false;
function refreshPairs(deps: OfferDeps, log: (line: string) => void, instance: string): void {
	if (!deps.refreshPairs || voicing) return;
	voicing = true;
	readPairs(deps.refreshPairs, log).then(async () => {
		if (deps.analyze && hasBoxes(dataDir())) await (await import("./box-voice.ts")).refreshVoices(instance, deps.analyze, log);
	}).catch(e => log(`reply draft: mailbox voices not refreshed: ${(e as Error).message}`)).finally(() => void (voicing = false));
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
function mayDraft(m: OfferMail, instance: string, deps: OfferDeps): boolean {
	try {
		const settings = loadSettings();
		if (isDrafted(m.messageId ? `${m.key}#${m.messageId}` : m.key)) return false;
		const ctx = boxCtx(instance, m, deps);
		if (noAutoDraft(ctx.box)) return false;
		// A mailbox can draft with the app switch off: its mode is auto, or a judge may move the mail into such a box.
		const viaBox = rulesAllowed(settings) && (ctx.box?.mode === "auto" || (m.needs !== false && ctx.judges.length > 0));
		if (!(appOn(settings, "mail") || (rulesAllowed(settings) && anyRuleOn()) || viaBox)) return false;
		return !precheck({ kind: "mail", from: m.from ?? "", self: addressesOf(m.to), subject: m.subject, text: "" }, settings.senders, { addressLater: true });
	} catch {
		return false;
	}
}

// A 자동 초안 규칙 is its own opt-in: it drafts its mails while the app's 자동 초안 switch is off, but not on an install whose owner turned the
// whole feature off (onboard.ts off).
const rulesAllowed = (s: ReturnType<typeof loadSettings>) => !(s.decided && !s.enabled);

type OfferResult = "offered" | "skipped" | "off" | "failed";
type Reads = { body: Promise<string | undefined>; history: Promise<string[]>; replyTo: Promise<RawReplyTo | undefined> };
type Job = { m: OfferMail; deps: OfferDeps; queued: number; instance: string; requested: boolean; thread: string; reads?: Reads; counted?: boolean; done: ((r: OfferResult) => void)[] };

// Offers run one at a time (a burst of new mail never starts many model calls at once), but not in arrival order: each mail app instance is a lane and
// the lanes take turns, so one app's backlog never holds another app's mail, and an owner's request goes before every automatic offer.
const urgent = new FairQueue<Job>(), waiting = new FairQueue<Job>();
const waitingByThread = new Map<string, Job>();
let busy = false;
// The body and history reads (a mail CLI child each) start only for the first few automatic offers in line, while the one before them is in its model
// call: at most this many offers have reads started and not yet begun, whatever the burst size. An owner's request reads at once (one per click).
const READ_AHEAD = 2;
let readingAhead = 0;

const SUBJECT_ONLY = "본문을 읽지 못해 제목만 보고 썼어요";
const OFFER_TRIES = 3;
type Queued = { mail: OfferMail; tries: number };
type QueueFile = Record<string, Queued>;
const logOf = (deps: OfferDeps): ((line: string) => void) => deps.log ?? console.error;
const queueFile = (): string => join(dataDir(), "custom", "reply-drafts", "offer-queue.json");
const lookedOf = (m: OfferMail): string => (m.messageId ? `${m.key}#${m.messageId}` : m.key);

function isQueued(value: unknown): value is Queued {
	if (typeof value !== "object" || value === null) return false;
	const { mail, tries } = value as { mail?: unknown; tries?: unknown };
	if (typeof tries !== "number" || typeof mail !== "object" || mail === null) return false;
	const fields = mail as Record<string, unknown>;
	return ["key", "target", "source", "id", "subject"].every(k => typeof fields[k] === "string");
}

function readQueue(log: (line: string) => void): QueueFile {
	const file = queueFile();
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		const moved = `${file}.corrupt-${Date.now()}`;
		renameSync(file, moved);
		log(`reply draft: offer queue file did not parse (${(e as Error).message}); kept as ${moved}`);
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Queued] => isQueued(entry[1])));
}

function changeQueue(log: (line: string) => void, change: (queue: QueueFile) => void): void {
	try {
		const queue = readQueue(log);
		change(queue);
		writeAtomic(queueFile(), `${JSON.stringify(queue, null, 1)}\n`);
	} catch (e) {
		log(`reply draft: offer queue file not updated: ${(e as Error).message}`);
	}
}

function keepQueued(thread: string, m: OfferMail, deps: OfferDeps): void {
	changeQueue(logOf(deps), queue => {
		const before = queue[thread];
		queue[thread] = { mail: { ...m, ...(m.body ? { body: m.body.slice(0, BODY_MAX) } : {}) }, tries: before && lookedOf(before.mail) === lookedOf(m) ? before.tries : 0 };
	});
}

function markFailed(m: OfferMail, deps: OfferDeps): void {
	try {
		if (m.needs !== true || !deps.suggest || draftHeads().some(d => d.ref === m.key && d.status === "pending")) return;
		deps.suggest(m.key, { kind: "reply-draft", label: "답장 초안", ref: "", state: "waiting" });
	} catch (e) {
		logOf(deps)(`reply draft: mail ${m.key} not marked as failed: ${(e as Error).message}`);
	}
}

function settleQueued(j: Job, result: OfferResult): void {
	changeQueue(logOf(j.deps), queue => {
		const entry = queue[j.thread];
		if (!entry || waitingByThread.has(j.thread)) return;
		if (result === "failed" && entry.tries + 1 < OFFER_TRIES) entry.tries++;
		else delete queue[j.thread];
	});
	if (result === "failed") markFailed(j.m, j.deps);
}

function lookupReplyTo(m: OfferMail, deps: OfferDeps): Promise<RawReplyTo | undefined> {
	if (m.replyTo || m.source !== "zele" || !deps.replyTo || !m.messageId?.startsWith("1|")) return Promise.resolve(undefined);
	const late = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => late.resolve(undefined), HISTORY_WAIT_MS);
	const read = deps.replyTo(m).catch(error => ((deps.log ?? console.error)(`mail ${m.key}: Reply-To not read: ${(error as Error).message}`), undefined));
	return Promise.race([read, late.promise]).finally(() => clearTimeout(timer));
}

function startReads(j: Job): Reads {
	if (j.reads) return j.reads;
	try {
		const may = j.requested || mayDraft(j.m, j.instance, j.deps);
		return (j.reads = { body: may ? fullBody(j.m, j.deps) : Promise.resolve(j.m.body), history: may ? startHistory(j.m, j.deps) : Promise.resolve([]), replyTo: may ? lookupReplyTo(j.m, j.deps) : Promise.resolve(undefined) });
	} catch (e) {
		(j.deps.log ?? console.error)(`reply draft: mail ${j.m.key} reads not started: ${(e as Error).message}`);
		return (j.reads = { body: Promise.resolve(j.m.body), history: Promise.resolve([]), replyTo: Promise.resolve(undefined) });
	}
}

function pump(): void {
	if (!busy) {
		const j = urgent.shift() ?? waiting.shift();
		if (j) {
			busy = true;
			if (waitingByThread.get(j.thread) === j) waitingByThread.delete(j.thread);
			if (j.counted) readingAhead--;
			offerOne(j.m, j.deps, startReads(j), j.queued, j.instance, j.requested).catch(() => "failed" as const).then(r => {
				busy = false;
				if (!j.requested) settleQueued(j, r);
				for (const done of j.done) done(r);
				pump();
			});
		}
	}
	for (const j of waiting.first(READ_AHEAD)) {
		if (readingAhead >= READ_AHEAD) break;
		if (j.reads) continue;
		startReads(j);
		j.counted = true;
		readingAhead++;
	}
}

// The lane of a mail: its app instance; a mail no instance claims (the plain mail app) falls back to its account, else its source.
async function enqueue(m: OfferMail, deps: OfferDeps, requested: boolean): Promise<OfferResult> {
	const queued = Date.now();
	const instance = await mailInstanceOf(m.key);
	const thread = `${m.source}\0${accountOf(m) ?? ""}\0${threadIdOf(m.source, m.id)}`;
	return new Promise<OfferResult>(done => {
		const older = requested ? undefined : waitingByThread.get(thread);
		if (older) {
			older.m = m;
			older.deps = deps;
			older.done.push(done);
			if (older.counted) readingAhead--;
			older.reads = undefined;
			older.counted = false;
			keepQueued(thread, m, deps);
			pump();
			return;
		}
		const job: Job = { m, deps, queued, instance, requested, thread, done: [done] };
		if (!requested) {
			waitingByThread.set(thread, job);
			keepQueued(thread, m, deps);
		}
		(requested ? urgent : waiting).push(instance !== "mail" ? instance : accountOf(m) || m.source, job);
		if (requested) startReads(job);
		pump();
	});
}

/** 초안 작성 on a mail (POST /api/mail/<key>/draft): the owner asked for a draft himself, so the auto-draft switch, the one-look-per-message mark and
 *  the sender filter do not apply, and the model must draft (ReplyItem.requested). The draft arrives like an offered one: the send-approval card
 *  in the mail's conversation and the 답장 초안 chip on its row. */
export const requestMailDraft = (m: OfferMail, deps: OfferDeps): Promise<OfferResult> => enqueue(m, deps, true);
export const offerMailDraft = (m: OfferMail, deps: OfferDeps): Promise<OfferResult> => (readOnArrival(deps), enqueue(m, deps, false));

/** At start: puts back the automatic offers the file `custom/reply-drafts/offer-queue.json` still holds, and nothing else. */
export const resumeOffers = (deps: OfferDeps): Promise<OfferResult[]> => Promise.all(Object.values(readQueue(logOf(deps))).map(entry => enqueue(entry.mail, deps, false)));

async function offerOne(m: OfferMail, deps: OfferDeps, { body, history, replyTo }: Reads, queued: number, instance: string, requested: boolean): Promise<OfferResult> {
	const log = deps.log ?? ((line: string) => console.error(line));
	const started = Date.now();
	let trace: DraftTrace | undefined;
	try {
		const settings = loadSettings();
		// The mailbox the mail is in (none = the base box with nothing set: today's path). Its mode: auto drafts with the app switch off, ask / notify / quiet draft only on request.
		const ctx = boxCtx(instance, m, deps);
		let box = ctx.box;
		const allowed = rulesAllowed(settings), autoOf = (b: typeof box) => appOn(settings, "mail") || (allowed && b?.mode === "auto");
		let auto = autoOf(box);
		// One look per message: a newer message of the same thread (messageId) is looked at again, a repeat of the same one is not.
		const looked = m.messageId ? `${m.key}#${m.messageId}` : m.key;
		if (!requested && noAutoDraft(box)) return isDrafted(looked) ? "skipped" : (markDrafted(looked), "off");
		// The rules of the mail's own app instance (the mailbox's own, when it has some); a mail of an instance without a rule switched on costs nothing more.
		const own = allowed ? await rulesOf(instance) : undefined;
		const rules = (allowed ? boxRules(box) ?? (box?.alone ? [] : own?.rules ?? []) : []).filter(r => r.on);
		// The judge of the other mailboxes rides on the rule match: only a mail still in the base box, that needs a reply, and nobody asked a draft for.
		const judges = !requested && m.needs !== false && allowed ? ctx.judges : [];
		if (!requested && !auto && !rules.length && !judges.length) return "off";
		if (!requested && m.needs === false && !rules.length) return "off";
		if (!requested && isDrafted(looked)) return "skipped";
		const item: ReplyItem = { kind: "mail", from: m.from ?? "", self: deps.own?.(m.source) ?? addressesOf(m.to), to: addressesOf(m.to), ...(m.cc ? { cc: addressesOf(m.cc) } : {}), subject: m.subject, text: "", ...(requested ? { requested: true } : {}), ...(m.needs === true ? { expected: true } : {}), ...(requested && m.instruction?.trim() ? { instruction: m.instruction.trim().slice(0, 500) } : {}) };
		// Learning stays on the shared mail profile; only the writing, the revising and the send check read the instance's own profile.
		if (hasOwnTone(instance)) item.profile = instance;
		if (!requested && precheck(item, settings.senders, { addressLater: true })) {
			markDrafted(looked);
			return "skipped";
		}
		// A thread read: the newest message of the sender is the text, the earlier ones the context. Any other text is the text. A read with no text of its own
		// (a mail of html or images only) leaves what the poster gave.
		const thread = threadText((await body) ?? m.summary ?? "", ownAddresses(item.self));
		const subjectOnly = !(thread.text.trim() || m.body?.trim() || m.summary?.trim());
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
		const found = await replyTo;
		const named = m.replyTo ?? (found?.from && addressesOf(found.from)[0] === addressesOf(item.from)[0] ? found.replyTo : undefined);
		if (usableReplyTo(named, item.self)) item.replyTo = named;
		// One budget for every model call of this draft: the rule match, the draft call and the file tie-break.
		trace = draftTrace();
		// A short wait for an iCloud file to come back (the offer queue waits on this draft); what is still away is retried in the background (wantFiles).
		const flow = { call: deps.call, judge: deps.judge, pick: deps.pick, trace, stage: { tries: 5, ...deps.stage } };
		let hit: MailMatch = {};
		if (rules.length || judges.length) {
			try {
				hit = await matchMail({ from: item.from, subject: item.subject, text: item.text }, rules, judges.map(b => b.judge.text), callOf(flow, item, m.key, "rule"));
			} catch (e) {
				log(`reply draft: rules for mail ${m.key} not matched: ${(e as Error).message}`);
				if (!requested && !auto) return "failed";
			}
		}
		const rule = hit.rule;
		if (hit.judge !== undefined) {
			// The mail moves to the box the judge chose, and that box's mode applies; no second call.
			box = judges[hit.judge]!;
			try {
				moveByJudge(deps, m.key, box);
			} catch (e) {
				log(`reply draft: mail ${m.key} not moved to its mailbox: ${(e as Error).message}`);
			}
			auto = autoOf(box);
			if (noAutoDraft(box)) {
				markDrafted(looked);
				return "off";
			}
		}
		if (!requested && !auto && !rule) {
			markDrafted(looked);
			return "skipped";
		}
		const configured = ruleInstruction(box?.alone ? "" : own?.base ?? "", rule, boxLines(box, item.from));
		if (configured) item.configured = configured;
		const read = Date.now();
		if (allowed) refreshPairs(deps, log, instance);
		if (allowed && deps.analyze && deps.sentTexts) await learnMailIdentity(deps.analyze, deps.sentTexts, log);
		const learned = Date.now();
		// The files are picked BEFORE the words are written, so the draft is told which files ride on it (and that none fits) and its text agrees
		// with the attachments. A rule that names its files stages those instead.
		// Files the poster already chose (reply_files) ride on the reply as they are: the model is told so, and no 첨부 파일 폴더 pick runs.
		const given = m.replyFiles?.map(f => f.path) ?? [];
		if (given.length) item.files = given.map(p => stagedName(basename(p)));
		const ruleFiles = !!rule?.files.length;
		// The model chooses among candidates (the rule's files first, then the library matches); no model call picks them.
		const asked = mailAsksFile(item);
		const cands = !given.length && (ruleFiles || asked) ? await candidatesFor(item, { source: m.source, ref: m.key }, rule, boxFolders(box), box?.alone).catch(e => (log(`reply draft: files for mail ${m.key} not matched: ${(e as Error).message}`), undefined)) : undefined;
		if (cands?.files.length) item.candidates = cands.files.map(f => f.rel);
		else if (cands && asked) item.files = [];
		// A long 고친 점 is folded before its prompt is built (compact.ts), on the reply model of the mail's app.
		await compactForPrompt(styleKey({ ...item, ...(box ? { box: box.id, instance } : {}) }, item), { learnCall: app => deps.call ?? replyCall(app) }).catch(e => log(`reply draft: corrections for mail ${m.key} not compacted: ${(e as Error).message}`));
		const built = await buildDraft(item, { ...(box ? { box: box.id, instance } : {}), source: m.source, mailId: m.id, ref: m.key, ...(m.account ? { account: m.account } : {}), ...(m.attachments?.length ? { origAttachments: m.attachments.length } : {}) }, flow);
		if (built.action !== "draft") {
			log(`reply draft: mail ${m.key} skipped: ${built.reason}`);
			markDrafted(looked);
			return "skipped";
		}
		built.rec.brief = deps.brief?.(m.key) ?? { ...(m.from ? { from: m.from } : {}), ...(m.summary ? { summary: m.summary } : {}) };
		// A mail draft starts as 답장 (the sender alone); the card's 전체 답장 switch reads the original's 받는 사람·참조 from the mail record.
		built.rec.mode = "reply";
		ensureSwitch();
		if (rule) built.rec.rule = { id: rule.id, name: rule.name };
		const warnings = [...built.warnings, ...banWarnings(box, built.rec), ...(subjectOnly ? [SUBJECT_ONLY] : [])];
		const chosen = chosenFrom(cands, built.files);
		const notStaged = (e: Error): string[] => (log(`reply draft: files for mail ${m.key} not staged: ${e.message}`), []);
		if (given.length) {
			const want: Want[] = [];
			warnings.push(...(await stageFiles(built.rec.id, given, want, flow.stage)));
			if (want.length) built.rec.wantFiles = want;
		} else if (chosen) {
			// Exactly what the model chose; with no `files` in its answer (chosen undefined) the matching below is today's.
			warnings.push(...(await stageForReply(built.rec, flow, Promise.resolve(chosen)).catch(notStaged)));
			if (cands?.missing.length) warnings.push(ruleFileMissing(cands.missing));
		} else if (rule && ruleFiles) {
			built.rec.asksFile = mailAsksFile(item) || undefined;
			const later = { want: [] as Want[], why: [] as string[] };
			const missing = await stageRuleFiles(built.rec.id, rule, await attachFolder(m.key), flow.stage, later);
			if (later.want.length) built.rec.wantFiles = later.want;
			warnings.push(...later.why);
			if (missing.length) warnings.push(ruleFileMissing(missing));
		} else warnings.push(...(await stageForReply(built.rec, flow).catch(notStaged)));
		await settleDraft(built.rec, deps.run);
		addDraft(built.rec);
		markDrafted(looked);
		if (built.rec.wantFiles?.length) retryWanted(built.rec.id, flow.stage);
		deps.suggest?.(m.key, { kind: "reply-draft", label: "답장 초안", ref: built.rec.id, ...(rule ? { rule: rule.name } : {}) });
		try {
			await deps.send(m.thread ? `th:${m.thread}` : m.target, askText(built.rec, warnings, m.headline));
		} catch (e) {
			log(`reply draft: card of draft ${built.rec.id} (mail ${m.key}) not posted, the draft waits in the queue: ${(e as Error).message}`);
		}
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
