// The draft life cycle shared by the gateway offer (offer.ts) and the CLI (bin/draft.ts): build -> ask -> revise | send | drop.
// Nothing here sends without the user's 1) 보내기 pick for exactly that draft id, read from the inbox log.
import { existsSync, statSync } from "node:fs";
import type { DraftRule } from "../../../hub/app-settings.ts";
import { linkedComment } from "../../../hub/comments/linked.ts";
import { claimHolder, claimSend } from "../../../hub/draft-claim.ts";
import { attachIssues, ownWords, withoutKindWords } from "../../../hub/attach-check.ts";
import { withFileWords } from "../../../hub/auto-attach.ts";
import { ATTACH_AS_IS_HINT, ATTACH_REFUSED, LINT_REFUSED, asksForFile, briefLines, claimsAttachment, draftApprovalBlock, draftVerdict, type DraftVerdict } from "../../../hub/draft-approval.ts";
import type { ReplyCall } from "../../../hub/reply-model.ts";
import { addressesOf, editLesson, generateChatReply, lintReply, lessonOf, NO_RECIPIENT, ownerLint, RECIPIENT_FAILURE, reviseReply, SENT_CLAIM_FAILURE, withSenderAddress, type ModelCall, type Recipient, type ReplyItem, type ReplyKind, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { listLibrary, matchLibrary, MIN_SCORE, rankLibrary, type LibraryFile } from "./library.ts";
import { basename } from "node:path";
import { ruleFilePath } from "./rules.ts";
import { canAttach, sendsThroughZele, sendWith, settleAccount, webmailSite, zeleAccountOf, type Sent, type SendOutcome } from "./senders.ts";
import { carryStagedFiles, removeStagedFile, stagedFiles, stagedName, stageFiles, type StageOpts, type Want } from "./staged.ts";
import { dataDir, loadSettings, loadStyle, paths, recordCorrection, toneFile, validApp, type ToneKey } from "./settings.ts";
import { banWarnings, boxById } from "./box.ts";
import { maybeRefine } from "./persona.ts";
import { addPair, styleFrom, styleWithExamples } from "./pairs.ts";
import { addDraft, claimFile, getDraft, listDrafts, newId, patchDraft, setStatus, type DraftRec } from "./store.ts";
import { realRunner, type Runner } from "./tone.ts";

export { realRunner };
// What hub/reply-mail.ts (the hub's single door into this feature) needs beside the flow itself.
export { recordCorrection, webmailSite };

// `analyze` = the model call of the identity sweep and its refinement (persona.ts); absent, no identity is analysed or refined.
export type FlowDeps = { /** Chooses among tied library files by name (stageForReply); the default is one short model call. */ pick?: (names: string[]) => Promise<string[]>; call?: ModelCall; /** The model calls of one draft and its overall budget (draftTrace); buildDraft makes one when absent. */ trace?: DraftTrace; analyze?: ModelCall; run?: Runner; now?: () => Date; send?: (rec: DraftRec) => Promise<SendOutcome>; /** How library files are copied onto a draft (tests). */ stage?: StageOpts; /** Told where an approved send left the mail, right after the transport answered and before any bookkeeping write (bin/draft.ts prints its DOTZ_SEND line). */ onOutcome?: (o: Outcome) => void };
/** Where a send left the mail and why (design 1.5, 2.2): what sendDraft tells `onOutcome` and carries on a Step that did not send. */
export type Outcome = { sent: Sent; code?: string; vars?: Record<string, string | number> };

/** The deps of a real send or revise outside a test: the identity model of the reply-drafts settings and the real tool runner. */
export const realFlowDeps = (): FlowDeps => ({ analyze: defaultCall(loadSettings().model), run: realRunner });

// After a recorded correction: every few corrections fold into the profile's identity. A failed refinement keeps the old identity.
export async function refineAfterCorrection(key: ToneKey, deps: FlowDeps): Promise<void> {
	if (!deps.analyze) return;
	await maybeRefine(key, deps.analyze).catch(e => console.error(`reply draft: identity of ${key.app} not refined: ${(e as Error).message}`));
}

/** The one "record, then refine" (design 3.4): a lesson line enters the tone profile, and every few fold into its identity. */
export async function recordLesson(key: ToneKey, line: string, deps: FlowDeps): Promise<void> {
	recordCorrection(key, line, nowOf(deps));
	await refineAfterCorrection(key, deps);
}

// The tone profile an item or draft belongs to: its room when it has one, else its own profile (a mail app instance's), else its app (mail unless the item says otherwise).
// A draft made in a mailbox (box + instance) uses tone/<instance>/<box>.md when that file exists, falling back to the instance's profile (else the mail one), then the install.
export const toneKey = (x: { app?: string; room?: string; profile?: string; box?: string; instance?: string }): ToneKey => {
	const key: ToneKey = { app: x.profile ?? x.app ?? "mail", ...(x.room !== undefined ? { room: x.room } : {}) };
	if (!x.box || !x.instance || x.room !== undefined || !validApp(x.instance)) return key;
	const boxKey: ToneKey = { app: x.instance, room: x.box, ...(x.profile ? {} : { base: key.app }) };
	return existsSync(toneFile(boxKey)) ? boxKey : key;
};
export type Meta = { /** The mailbox the mail is in and its mail app instance (box.ts boxCtx): set only for a mail in a box with settings. */ box?: string; instance?: string; source: string; mailId: string; ref: string; origAttachments?: number; /** The zele account the mail belongs to (its record's `account`); every zele call of the draft passes it. */ account?: string };
// "ask" (chat only): the message needs a decision only the user can make; `choices` are 2-4 short answers.
export type Built = { action: "skip"; reason: string } | { action: "draft"; rec: DraftRec; warnings: string[]; /** The candidates the model chose (ReplyResult.files); absent = it gave no choice. */ files?: string[] } | { action: "ask"; question: string; choices: string[] };

// The subscription-only model call of the gateway (hub/outlang.ts callModel), loaded on first use so nothing else pulls in the gateway config.
export function defaultCall(model?: string): ModelCall {
	return async (system, user) => {
		const { callModel } = await import("../../../hub/outlang.ts");
		return (await callModel(system, user, { model, timeoutMs: 120_000 })).text;
	};
}

// The same call for a reply draft, with the model of the app's 답장 모델 setting (hub/reply-model.ts). `conv` (a mail's key) picks the app instance; `call` is injected by tests.
export function replyCall(app: string, conv?: string, call?: ReplyCall): ModelCall {
	return async (system, user) => {
		const { callReplyModel } = await import("../../../hub/reply-model.ts");
		return (await callReplyModel(app, conv, system, user, call)).text;
	};
}

// One draft's model calls share one overall budget: each call gets the per-call limit or what is left of the budget, whichever is shorter, and
// a call with too little left is not started. Every call is recorded (what, ms, tokens when the real model reports them) for the draft's log line.
export const DRAFT_BUDGET_MS = 60_000;
const MIN_CALL_MS = 5_000;
export type CallStat = { what: string; ms: number; tokens?: { in: number; out: number }; error?: string };
export type DraftTrace = { deadline: number; calls: CallStat[] };
export const draftTrace = (budgetMs = DRAFT_BUDGET_MS): DraftTrace => ({ deadline: Date.now() + budgetMs, calls: [] });
/** "model calls 2: draft 9490ms 4866/863 tok, pick 820ms" - the one line that says what a draft spent on the model. */
export const traceLine = (t: DraftTrace): string => `model calls ${t.calls.length}${t.calls.length ? `: ${t.calls.map(c => `${c.what} ${c.ms}ms${c.tokens ? ` ${c.tokens.in}/${c.tokens.out} tok` : ""}${c.error ? ` (${c.error})` : ""}`).join(", ")}` : ""}`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`model call timed out after ${Math.round(ms / 1000)}s`)), ms)));
	return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function tracedCall(deps: FlowDeps, item: ReplyItem, conv: string | undefined, trace: DraftTrace, what: string): ModelCall {
	return async (system, user) => {
		const left = trace.deadline - Date.now();
		if (left < MIN_CALL_MS) throw new Error(`the draft's ${DRAFT_BUDGET_MS / 1000}s budget is spent`);
		const stat: CallStat = { what, ms: 0 };
		trace.calls.push(stat);
		const t0 = Date.now();
		try {
			const { callReplyModel, DRAFT_TIMEOUT_MS } = await import("../../../hub/reply-model.ts");
			if (deps.call) return await withTimeout(deps.call(system, user), Math.min(left, DRAFT_TIMEOUT_MS));
			const r = await callReplyModel(item.app ?? "mail", conv, system, user, undefined, { timeoutMs: left });
			stat.tokens = { in: r.inputTokens, out: r.outputTokens };
			return r.text;
		} catch (e) {
			stat.error = (e as Error).message;
			throw e;
		} finally {
			stat.ms = Date.now() - t0;
		}
	};
}

export const callOf = (deps: FlowDeps, item: ReplyItem, conv?: string, what = "draft"): ModelCall => (deps.trace ? tracedCall(deps, item, conv, deps.trace, what) : deps.call ?? replyCall(item.app ?? "mail", conv));
const nowOf = (deps: FlowDeps) => (deps.now ?? (() => new Date()))();
/** The style of a mail written outside a draft (examples of the same sender first), or undefined when the mail profile has no samples and no identity yet.
 *  Every mail app instance shares the `mail` profile and its pairs, as offered drafts do. */
export function mailStyleOf(text: string, from: string): ReplyStyle | undefined {
	const s = loadStyle({ app: "mail" });
	return s.samples.length || s.identity?.length ? styleWithExamples(s, "mail", text, from) : undefined;
}
// A mail draft's style carries the user's closest real past replies of ITS source as examples (a site's own sent folder for its mails, zele's for zele's); chat
// and comments keep theirs. A zele pair does not say which account it came from, so a zele draft with a profile of its own gets none: another account's replies
// must not ride in its prompt.
export const pairSource = (source: string): string => webmailSite(source) ?? source;
// A mail in a mailbox with enough of the owner's own replies sees only those (lib/box-voice.ts, loaded on use: only a mail in a box pays for it).
async function styleOf(item: ReplyItem, key: ToneKey, source: string, at: { box?: string; instance?: string }) {
	if (item.kind !== "mail") return loadStyle(key);
	const own = at.box && at.instance ? (await import("./box-voice.ts")).boxExamples(at.instance, at.box) : undefined;
	if (own) return styleFrom(loadStyle(key), own, item.text, item.from);
	return item.profile && pairSource(source) === "zele" ? loadStyle(key) : styleWithExamples(loadStyle(key), "mail", item.text, item.from, pairSource(source));
}

function toRec(item: ReplyItem, meta: Meta, r: { draft: { to: string; subject?: string; body: string }; questions: string[]; recipient?: Recipient }, changes: string[], deps: FlowDeps): DraftRec {
	// The candidates were for this one model call; a later revision builds its own.
	const { candidates: _candidates, ...kept } = item;
	const account = item.kind === "mail" ? meta.account || zeleAccountOf({ ...meta, app: item.app ?? "mail" }) : undefined;
	return { id: newId(), ...(r.recipient ? { recipient: r.recipient } : {}), kind: item.kind, app: item.app ?? "mail", ...(item.room !== undefined ? { room: item.room } : {}), ...(item.profile ? { profile: item.profile } : {}), ...meta, ...(account ? { account } : {}), to: r.draft.to, ...(r.draft.subject ? { subject: r.draft.subject } : {}), body: r.draft.body, status: "pending", created: nowOf(deps).toISOString(), changes, questions: r.questions, item: kept };
}

// The owner is asked once, with a complete draft (owner 2026-10-26): the one draft call already settles every open point it can from what it
// sees (hub/reply-draft.ts SYSTEM); what it still lists is what only the owner knows, asked inside the same approval card. A question a rule
// settles (the recipient's address: the sender's own, recovered from the text, or filled by the source's reply screen) is dropped, never sent
// back to the model.
export async function buildDraft(item: ReplyItem, meta: Meta, deps: FlowDeps): Promise<Built> {
	const trace = deps.trace ?? draftTrace();
	const style = await styleOf(item, toneKey({ ...item, box: meta.box, instance: meta.instance }), meta.source, meta), call = callOf({ ...deps, trace }, item, meta.ref);
	const r = await generateChatReply(item, style, call);
	if (r.action !== "draft") return r;
	const questions = item.kind === "mail" ? r.questions.filter(q => !ADDRESS_ASK.test(q)) : r.questions;
	return { action: "draft", rec: toRec(item, meta, { ...r, questions }, [], deps), warnings: r.warnings, ...(r.files ? { files: r.files } : {}) };
}


// A mail draft whose recipient is a name only (made before the sender's address was recovered, or from a source that shows names): the
// address the original's own text names, else the draft as it is.
export function withRecipient(rec: DraftRec): DraftRec {
	if (rec.kind !== "mail" || addressesOf(rec.to).length) return rec;
	const from = withSenderAddress(rec.item.from, rec.item.text, rec.item.self);
	if (!addressesOf(from).length) return rec;
	// The open point "what is the address" is settled now: it leaves the card's question.
	const questions = (rec.questions ?? []).filter(q => !ADDRESS_ASK.test(q));
	return { ...rec, to: from, item: { ...rec.item, from }, questions };
}
const ADDRESS_ASK = /e-?mail address|recipient|address|주소|받는\s*(?:사람|분|이)|수신자/i;

// A question the model wrote because it could not see any file to attach ("첨부 폴더를 볼 수 없어 파일을 붙이지 못했습니다"). Once files are on the draft it is false and only confuses the card.
const FILE_WORD = "파일|첨부|attach|file";
const fileWord = withFileWords(({ document }) => new RegExp(`${FILE_WORD}${document}`, "i"));
const CANNOT = /못|없|불가|can'?not|can'?t|unable|not able|no access|don'?t have|do not have/i;
export const claimsNoFile = (q: string): boolean => fileWord().test(q) && CANNOT.test(q);
// The owner's change is about the files of the draft (not its wording): the model then chooses the files again.
const fileChange = withFileWords(({ document, audio }) => new RegExp(`${FILE_WORD}|음원|자료|사진${document}${audio}`, "i"));
type Revision = { /** Library files offered besides those on the draft. */ lib: LibraryFile[]; /** Names the model may choose from: the files on the draft, then the library matches. */ names: string[] };

// Candidates for a revision whose change is about files: the files on the draft plus the library matches for the change.
async function revisionCandidates(old: DraftRec, change: string): Promise<Revision | undefined> {
	if (old.kind !== "mail" || !canAttach(old.source) || !fileChange().test(change)) return undefined;
	const folder = await attachFolder(old.ref);
	if (!folder) return undefined;
	const held = stagedFiles(old.id).map(f => f.name);
	const lib = rankLibrary(listLibrary(folder), { subject: change, text: change }).filter(r => r.score >= MIN_SCORE && !held.includes(stagedName(basename(r.file.path)))).map(r => r.file).slice(0, Math.max(0, CANDIDATE_MAX - held.length));
	const names = [...held, ...lib.map(f => f.rel)];
	return names.length ? { lib, names } : undefined;
}
const withoutNoFileClaims = (rec: DraftRec): string[] => {
	const all = rec.questions ?? [];
	return stagedFiles(rec.id).length ? all.filter(q => !claimsNoFile(q)) : all;
};

// The lint's findings as the owner reads them on the card (the model gets them in English, hub/reply-draft.ts lintReply).
export function ownerWarning(w: string): string {
	if (w === NO_RECIPIENT) return "받는 사람의 메일 주소를 찾지 못했어요. 보내기 전에 주소를 알려 주세요";
	const m = (re: RegExp) => re.exec(w);
	let x: RegExpExecArray | null;
	if ((x = m(/^'(.+)' is the user's own address$/))) return `${x[1]}은(는) 내 주소예요`;
	if ((x = m(/^'(.+)' is not the sender, reply-to or a cc of the original$/))) return `${x[1]}은(는) 원래 메일의 보낸 사람·회신 주소·참조가 아니에요`;
	if (w === "the subject must start with 'Re:'") return "제목이 Re:로 시작하지 않아요";
	if (w === "the body is empty") return "본문이 비어 있어요";
	if ((x = m(/^the body is (\d+) characters; the limit is (\d+)$/))) return `본문이 ${x[1]}자예요 (최대 ${x[2]}자)`;
	if (w === RECIPIENT_FAILURE) return "보낸 사람이 누구인지 판단한 근거가 메일에 없어요. 호칭과 내용이 이 사람에게 맞는지 봐 주세요";
	if (w === SENT_CLAIM_FAILURE) return "이미 보냈다고 썼는데 보낸 근거가 없어요";
	if (w === "the text contains a placeholder") return "채워 넣지 않은 자리표시가 있어요";
	if ((x = m(/^it uses the forbidden expression '(.+)'$/))) return `쓰지 않기로 한 표현 '${x[1]}'이(가) 있어요`;
	return w;
}

// What a mail draft's words and its files disagree on, as the owner reads it on the card and in the refused send (hub/attach-check.ts), plus the files
// chosen for it that are not on it yet. Mail only; a source that cannot carry files has nothing to check.
export function draftAttachIssues(rec: DraftRec): string[] {
	if (rec.kind !== "mail" || !canAttach(rec.source)) return [];
	const files = stagedFiles(rec.id).map(f => f.name);
	const found = attachIssues({ subject: rec.subject, body: rec.body, files, request: rec.compose ? undefined : rec.item.text }).map(i => i.text);
	const want = notYetStaged(rec);
	return want.length ? [...found, `아직 못 붙인 파일: ${want.join(", ")}`] : found;
}
// The files chosen for a draft that are not on it yet (an iCloud file still downloading).
const notYetStaged = (rec: DraftRec): string[] => {
	const files = stagedFiles(rec.id).map(f => f.name);
	return (rec.wantFiles ?? []).map(f => f.name).filter(n => !files.includes(stagedName(n)));
};

// The send-time lint of a draft, in the lint's own words. A text the owner wrote himself (editedFrom) gets the owner-text lint: his length is not the style's.
const draftLint = (d: DraftRec): string[] => (d.editedFrom !== undefined ? ownerLint : lintReply)({ to: d.to, subject: d.subject, body: d.body }, d.item, loadStyle(toneKey(d)), { anyRecipient: d.ownerRecipients === true });
// The same as the owner reads it. The comment engine runs it before a combined card's reply is posted (hub/comments/engine.ts), so a hit never leaves a posted reply beside an unsent mail.
export const draftLintFailures = (d: DraftRec): string[] => draftLint(d).map(ownerWarning);

// The reason code of a lint finding (design 2.2), with the value its text names.
function lintCode(raw: string): { code: string; vars?: Record<string, string | number> } {
	let x: RegExpExecArray | null;
	if (raw === NO_RECIPIENT) return { code: "recipient_missing" };
	if ((x = /^'(.+)' is the user's own address$/.exec(raw))) return { code: "recipient_self", vars: { address: x[1]! } };
	if ((x = /^'(.+)' is not the sender, reply-to or a cc of the original$/.exec(raw))) return { code: "recipient_not_on_mail", vars: { address: x[1]! } };
	if ((x = /^the body is (\d+) characters; the limit is (\d+)$/.exec(raw))) return { code: "too_long", vars: { n: Number(x[1]), max: Number(x[2]) } };
	if ((x = /^it uses the forbidden expression '(.+)'$/.exec(raw))) return { code: "forbidden_word", vars: { word: x[1]! } };
	if (raw === "the subject must start with 'Re:'") return { code: "subject_re" };
	if (raw === "the body is empty") return { code: "empty" };
	return { code: "placeholder" };
}

// 직접 수정 (design 3.3): the owner's text is saved as it is under the same id; only line ends are normalized and the ends trimmed. No model call.
// The owner-text lint refuses it and nothing is stored; a file mismatch is only noted. `editedFrom` keeps the model's text from before his first edit.
export function editDraft(id: string, text: string): Step & { lint?: string[] } {
	const d = getDraft(id);
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요`, code: "gone" };
	if (d.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태라 고칠 수 없어요`, code: "not_pending" };
	const body = text.replace(/\r\n?/g, "\n").trim();
	const found = ownerLint({ to: d.to, subject: d.subject, body }, d.item, loadStyle(toneKey(d)), { anyRecipient: d.ownerRecipients === true });
	if (found.length) {
		const lint = found.map(ownerWarning);
		return { ok: false, text: `${LINT_REFUSED} ${lint.join(" · ")}`, ...lintCode(found[0]!), lint };
	}
	if (body !== d.body) patchDraft(id, { body, ...(d.editedFrom === undefined ? { editedFrom: d.body } : {}) });
	const issues = draftAttachIssues({ ...d, body });
	return { ok: true, text: `초안 ${id}을(를) 고친 글 그대로 저장했어요${issues.length ? `. 확인: ${issues.join(" · ")}` : ""}` };
}


// The account of a new draft that goes out through zele (senders.ts sendsThroughZele), settled before its card is shown: the owner hears here, not after he pressed 보내기, that it cannot go out as it is.
// sendWith settles again and refuses without touching the mail, so a run that fails here (logged) loses nothing. No `run`: left to the send.
export async function settleDraft(rec: DraftRec, run: Runner | undefined): Promise<void> {
	if (!run || rec.kind !== "mail" || rec.account) return;
	try {
		if (!(await sendsThroughZele(rec.source))) return;
		const settled = await settleAccount(rec, run);
		if (settled.account) rec.account = settled.account;
		if (settled.several) rec.accounts = settled.several;
	} catch (e) {
		console.error(`reply draft: account of draft ${rec.id} not settled: ${(e as Error).message}`);
	}
}

export const ACCOUNT_HELD = "보낼 메일 계정을 메일 앱 설정에서 정하기 전에는 보내지 않아요";
/** Why this draft cannot go out yet: several accounts were logged in when it was made and none has been set since. */
export const accountHold = (rec: DraftRec): string | undefined => (rec.accounts && !zeleAccountOf(rec) ? `메일 계정이 ${rec.accounts.join(", ")} 여러 개인데 이 메일이 어느 계정 것인지 알 수 없어요. ${ACCOUNT_HELD}` : undefined);

// The [ask] message of one draft; the notes line carries lint warnings, the card's question what only the user can decide.
export function askText(draft: DraftRec, warnings: string[], headline = draft.compose ? "새 메일 초안을 만들었어요" : "답장 초안을 만들었어요"): string {
	const rec = withRecipient(draft);
	if (rec !== draft) warnings = warnings.filter(w => w !== NO_RECIPIENT);
	// An account set in the meantime answers it: the send finds that one.
	const hold = accountHold(rec);
	if (hold) warnings = [...warnings, hold];
	const notes = warnings.map(w => `확인: ${ownerWarning(w)}`.replace(/\s+/g, " ")).join(" / ");
	const staged = stagedFiles(rec.id).map(f => ({ name: f.name, size: f.size }));
	// A webmail site sends text only (senders.ts canAttach): its files are listed as the ones that stay behind, and a send that holds them is refused.
	const noFiles = rec.kind === "mail" && !!webmailSite(rec.source);
	const attachments = noFiles ? [] : staged;
	const issues = draftAttachIssues(rec);
	const keptBack = noFiles && staged.length ? { sendResult: "파일이 붙어 있어 보내지 않아요. 파일을 빼면 본문만 보내요" } : {};
	const block = draftApprovalBlock({ to: rec.to, toLabel: "받는이", ...(rec.cc?.length ? { cc: rec.cc } : {}), ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, ref: rec.id, question: rec.compose ? "이 메일 보낼까요?" : "이 답장 보낼까요?", decide: withoutNoFileClaims(rec), ...(rec.compose ? { sendResult: `${rec.to}에게 이 메일을 보내요` } : {}), ...keptBack, ...(hold ? { sendResult: ACCOUNT_HELD } : {}), ...(noFiles ? { cannotAttach: staged.map(f => f.name) } : {}), ...(rec.origin ? { origin: { text: rec.origin.text, ...(rec.origin.link ? { link: rec.origin.link } : {}) } } : {}), ...(attachments.length ? { attachments } : {}), ...((rec.origAttachments ?? 0) > 0 ? { attachmentsNone: true } : {}), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}), ...(rec.rule ? { rule: rec.rule.name } : {}), ...(issues.length ? { attachIssues: issues } : {}) });
	return [`[ask] ${headline}`, ...briefLines(rec.brief), ...(notes ? [`-# ${notes}`] : []), block].join("\n");
}

// The 첨부 파일 폴더 of the mail app instance that owns the mail `ref` (app setting attach_folder), or undefined.
export async function attachFolder(ref: string): Promise<string | undefined> {
	try {
		const { instanceOf } = await import("../../../hub/reply-model.ts");
		const { appEntries } = await import("../../../hub/integrations.ts");
		return loadSettings().attachFolders?.[instanceOf(appEntries(dataDir()), "mail", `mail:${ref}`)];
	} catch {
		return undefined;
	}
}

const PICK_TEXT_MAX = 600;
function pickByModel(item: ReplyItem, ref: string, deps: FlowDeps): (names: string[]) => Promise<string[]> {
	return async names => {
		const text = await callOf(deps, item, ref, "pick")("파일 이름만 보고 메일에 보낼 파일을 고릅니다. 고른 파일 이름을 한 줄에 하나씩, 최대 3개만 적습니다. 다른 말은 쓰지 않습니다.", `메일 제목: ${item.subject ?? ""}\n\n메일 내용(앞부분):\n${item.text.trim().slice(0, PICK_TEXT_MAX)}\n\n파일 이름:\n${names.map(n => `- ${n}`).join("\n")}`);
		return text.split("\n").map(l => l.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
	};
}

// The 첨부 파일 폴더 files for a mail, matched by name in plain code; undefined when the source cannot send files or has no folder. It needs only the
// mail (subject, text, names), so offer.ts starts it beside the draft call: a tie is broken by the model only for a mail that asks for a file, and
// then concurrently with the draft, never after it. Any other tie takes the best-ranked files without a model call.
export async function libraryFor(item: ReplyItem, meta: { source: string; ref: string }, deps: FlowDeps): Promise<LibraryFile[] | undefined> {
	if (item.kind !== "mail" || !canAttach(meta.source)) return undefined;
	const folder = await attachFolder(meta.ref);
	if (!folder) return undefined;
	const pick = asksForFile(item.text) ? deps.pick ?? pickByModel(item, meta.ref, deps) : undefined;
	return matchLibrary(folder, { subject: item.subject ?? "", text: item.text }, pick);
}

export const CANDIDATE_MAX = 12;
export type Candidates = { files: LibraryFile[]; /** Rule entries that name no file. */ missing: string[] };

// The files the model may choose from for a mail, before the draft is written: the matched rule's files (resolved) first, then the library files that
// share a word with the mail, CANDIDATE_MAX in all. Plain code, no model call; the model sees their names. undefined: this mail has no folder to choose from.
// `folders`: the mailbox's own folders, in front of the app's 첨부 파일 폴더 (box.ts boxFolders), or instead of it for an `alone` box; empty = the single folder as before.
export async function candidatesFor(item: ReplyItem, meta: { source: string; ref: string }, rule?: DraftRule, folders: string[] = [], alone = false): Promise<Candidates | undefined> {
	if (item.kind !== "mail" || !canAttach(meta.source)) return undefined;
	const app = alone ? "" : await attachFolder(meta.ref), roots = [...new Set([...folders, ...(app ? [app] : [])])];
	if (!roots.length) return undefined;
	const library = folders.length ? roots.flatMap(listLibrary).filter((f, i, all) => all.findIndex(x => x.rel === f.rel) === i) : listLibrary(roots[0]!);
	const files: LibraryFile[] = [], missing: string[] = [];
	const add = (f: LibraryFile) => void (files.length < CANDIDATE_MAX && !files.some(x => x.path === f.path) && files.push(f));
	for (const entry of rule?.files ?? []) {
		const path = roots.map(r => ruleFilePath(entry, r)).find(Boolean);
		if (!path) missing.push(entry);
		else add(library.find(f => f.path === path) ?? { rel: basename(path), path, size: statSync(path).size });
	}
	// The words that name the work first: "음원" alone would fill the list with every song's audio and leave the asked song's score off it.
	const q = { subject: item.subject ?? "", text: item.text };
	const work = { subject: withoutKindWords(q.subject), text: withoutKindWords(q.text) };
	// A mail that quotes the earlier mail: the works its sender names himself go first, or the works of the quote fill the list and the asked one's files fall off it.
	const own = ownWords(item.text);
	const asked = own === item.text ? [] : rankLibrary(library, { subject: "", text: withoutKindWords(own) });
	for (const r of [...asked, ...rankLibrary(library, work), ...rankLibrary(library, q)]) if (r.score > 0) add(r.file);
	return { files, missing };
}

// What the model chose among the candidates (ReplyResult.files); undefined = it made no choice, so the caller keeps today's matching.
export const chosenFrom = (c: Candidates | undefined, names: string[] | undefined): LibraryFile[] | undefined => (c ? (c.files.length ? (names ? c.files.filter(f => names.includes(f.rel)) : undefined) : []) : undefined);

// Whether the mail asks for a file: the ask is often in its subject alone ("문서 요청드립니다", then "1탄, 2탄 다 받을 수 있을까요?").
export const mailAsksFile = (item: Pick<ReplyItem, "subject" | "text">): boolean => asksForFile(`${item.subject ?? ""}\n${item.text}`);

// A reply that promises a file or answers a mail that asks for one: the best matches of the 첨부 파일 폴더 are staged for the owner to confirm
// (they go out only with the owner's 보내기). Nothing fits -> the approval carries the warning and says so. A source that cannot send files gets neither.
// `files`: the files already chosen (the model's choice among candidatesFor, or libraryFor's match); only those are staged. A file that cannot be copied
// (an iCloud file still away) is kept in rec.wantFiles, never lost. Returns why a chosen file is not on the draft (one line each), for the card;
// one file that cannot be copied never keeps the others off.
export async function stageForReply(rec: DraftRec, deps: FlowDeps, files?: Promise<LibraryFile[] | undefined>): Promise<string[]> {
	if (rec.kind !== "mail") return [];
	rec.asksFile = mailAsksFile(rec.item) || undefined;
	const wants = !!rec.asksFile || claimsAttachment(`${rec.subject ?? ""}\n${rec.body}`);
	const found = files ? await files : wants ? await libraryFor(rec.item, rec, deps) : undefined;
	if (!found || (!found.length && !wants)) return [];
	if (!found.length) rec.libraryMiss = true;
	// Together, not one by one: each evicted iCloud file may wait for its download, and the offer queue waits on this draft.
	const want = rec.wantFiles ?? [];
	const failed = await stageFiles(rec.id, found.map(f => f.path), want, deps.stage);
	if (want.length) rec.wantFiles = want;
	// Files are on the draft now: a model question that says no file can be attached is false.
	if (stagedFiles(rec.id).length) rec.questions = withoutNoFileClaims(rec);
	return failed;
}

// A revised draft looks for files again with the same library pick (the first one ran before the words existed): when the owner's change names a file,
// those matches are added; else when the draft asks for a file or promises one and none is staged, the mail's own pick runs. Files already on the draft
// (the owner's own, or an earlier pick) stay. Returns why a matched file is not on the draft.
async function restageForRevision(rec: DraftRec, change: string, deps: FlowDeps, choice?: { rev: Revision; chosen: string[] }): Promise<string[]> {
	if (rec.kind !== "mail" || !canAttach(rec.source)) return [];
	// The change is about files and the model chose among the draft's files and the library matches: the staged set becomes exactly that choice.
	if (choice) {
		const have = stagedFiles(rec.id);
		for (let i = have.length - 1; i >= 0; i--) if (!choice.chosen.includes(have[i]!.name)) removeStagedFile(rec.id, i);
		const add = choice.rev.lib.filter(f => choice.chosen.includes(f.rel) && !have.some(h => h.name === stagedName(basename(f.path))));
		delete rec.wantFiles;
		const want: Want[] = [];
		const failed = await stageFiles(rec.id, add.map(f => f.path), want, deps.stage);
		if (want.length) rec.wantFiles = want;
		if (stagedFiles(rec.id).length) {
			delete rec.libraryMiss;
			rec.questions = withoutNoFileClaims(rec);
		}
		return failed;
	}
	const folder = await attachFolder(rec.ref);
	if (!folder) return [];
	const have = () => new Set(stagedFiles(rec.id).map(f => f.name));
	const named = await matchLibrary(folder, { subject: change, text: change });
	let found = named.filter(f => !have().has(stagedName(basename(f.path))));
	const wants = asksForFile(rec.item.text) || claimsAttachment(`${rec.subject ?? ""}\n${rec.body}`);
	let missed = false;
	if (!named.length && !have().size && wants) {
		found = (await libraryFor(rec.item, rec, deps)) ?? [];
		missed = !found.length;
	}
	const want = rec.wantFiles ?? [];
	const failed = await stageFiles(rec.id, found.map(f => f.path), want, deps.stage);
	if (want.length) rec.wantFiles = want;
	if (stagedFiles(rec.id).length) {
		delete rec.libraryMiss;
		rec.questions = withoutNoFileClaims(rec);
	} else if (missed) rec.libraryMiss = true;
	return failed;
}

export type Step = { ok: boolean; text: string; /** The id of the draft a revision made. */ id?: string; /** The approved send itself failed (not the approval gate): the owner has to hear it. */ sendFailed?: true;
	/** A send that did not go out: whether it surely did not or may have, and the reason code (absent on success, where the mail went out). */ sent?: Exclude<Sent, "yes">; code?: string; vars?: Record<string, string | number>;
	/** A revision: the draft it replaced, and the lesson it recorded (none when the change was only about that draft). */ replaces?: string; lesson?: { key: ToneKey; line: string } };

// The user picked 2) 고치기 (or the CLI is asked to): the draft is regenerated, and once that worked the lasting preference the change shows (the model's `lesson`;
// the change itself when the model left it out; nothing when the change was only about this draft) is recorded in the tone profile of that draft (its room, else its app).
// The change stays verbatim in the draft's own `changes`.
// `learn: false`: the caller records the returned lesson itself (hub/reply-actions.ts, so every kind learns in one place).
export async function reviseDraft(id: string, change: string, deps: FlowDeps, opts: { learn?: false } = {}): Promise<Step> {
	const found = getDraft(id);
	const old = found && withRecipient(found);
	if (!old) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (old.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${old.status} 상태라 고칠 수 없어요` };
	if (!change.trim()) return { ok: false, text: "무엇을 고칠지 적어 주세요 (--change)" };
	// The words are rewritten knowing which files ride on the draft now.
	const held = stagedFiles(old.id).map(f => f.name);
	const rev = await revisionCandidates(old, change);
	const item = rev ? { ...old.item, candidates: rev.names } : held.length ? { ...old.item, files: held } : old.item;
	const r = await reviseReply(item, await styleOf(old.item, toneKey(old), old.source, old), { to: old.to, subject: old.subject, body: old.body }, change, callOf(deps, old.item, old.ref));
	if (r.action === "skip") return { ok: false, text: `고친 초안을 만들지 못했어요: ${r.reason}` };
	const banned = old.box && old.instance ? banWarnings(boxById(old.instance, old.box), r.draft) : [];
	const rec = toRec(old.item, { ...(old.box && old.instance ? { box: old.box, instance: old.instance } : {}), source: old.source, mailId: old.mailId, ref: old.ref, ...(old.account ? { account: old.account } : {}), ...(old.origAttachments ? { origAttachments: old.origAttachments } : {}) }, r, [...old.changes, change], deps);
	// The recipients the owner set on the card stay: a rewrite of the words is not a reason to send it to somebody else.
	rec.to = old.to;
	rec.replaces = old.id;
	if (old.brief) rec.brief = old.brief;
	if (old.cc?.length) rec.cc = old.cc;
	if (old.mode) rec.mode = old.mode;
	if (old.ownerRecipients) rec.ownerRecipients = true;
	if (old.asksFile) rec.asksFile = true;
	if (old.wantFiles?.length) rec.wantFiles = old.wantFiles;
	if (old.libraryMiss) rec.libraryMiss = true;
	if (old.compose) rec.compose = true;
	if (old.accounts) rec.accounts = old.accounts;
	if (old.origin) rec.origin = old.origin;
	if (old.rule) rec.rule = old.rule;
	carryStagedFiles(old.id, rec.id);
	const notStaged = await restageForRevision(rec, change, deps, rev && r.files ? { rev, chosen: r.files } : undefined).catch(e => [(e as Error).message]);
	addDraft(rec);
	// Learned only once the new draft is stored: a revise that failed teaches nothing.
	const lesson = lessonOf(r, change);
	if (lesson && opts.learn !== false) await recordLesson(toneKey(old), lesson, deps);
	return { ok: true, text: askText(rec, [...r.warnings, ...banned, ...notStaged], "답장 초안을 고쳤어요"), id: rec.id, replaces: old.id, ...(lesson ? { lesson: { key: toneKey(old), line: lesson } } : {}) };
}

export function dropDraft(id: string): Step {
	const d = getDraft(id);
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (d.status !== "pending" && d.status !== "held") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태예요` };
	setStatus(id, "dropped");
	return { ok: true, text: `초안 ${id}을(를) 버렸어요` };
}

// 되돌리기 after the owner's 보내지 기: a dropped draft waits for approval again. A sent or replaced (stale) draft stays as it is, and so does one
// whose mail already has a newer draft waiting, so a mail never has two drafts pending.
export function restoreDraft(ref: string): { ok: boolean; text: string } {
	const d = getDraft(ref);
	if (!d) return { ok: false, text: `초안 ${ref}을(를) 찾지 못했어요` };
	if (d.status === "pending") return { ok: true, text: `초안 ${ref}은(는) 이미 기다리는 중이에요` };
	if (d.status !== "dropped") return { ok: false, text: `초안 ${ref}은(는) 이미 ${d.status} 상태라 되돌릴 수 없어요` };
	if (listDrafts().some(x => x.id !== d.id && x.ref === d.ref && x.status === "pending")) return { ok: false, text: `같은 메일에 새 초안이 있어서 초안 ${ref}은(는) 되돌리지 않았어요` };
	setStatus(ref, "pending");
	return { ok: true, text: `초안 ${ref}을(를) 되돌렸어요` };
}

// Refuses unless the user's latest word for this exact draft id, made after the draft was created, is 1) 보내기 or a typed yes in the mail's
// conversation ("보내자", hub/draft-approval.ts textVerdict); lints again first.
// `withReply`: the mail rides on a comment reply (hub/comments/linked.ts) and the caller is that reply's send, which has already passed the
// reply's gate (the owner's pick on the one card, or the owner's own click); a linked mail is refused without it.
// `asIs`: with `withReply`, the owner picked 이대로 보내기 on the card (without it the verdict says so). A mail whose files disagree with its words is refused
// before it goes out unless he did; the draft stays pending so the card can still be answered.
// `retry`: the owner pressed 다시 보내기 on purpose; only then is a claim left by a sender that died (the mail may have gone out) taken over.
export async function sendDraft(id: string, deps: FlowDeps, opts: { withReply?: true; asIs?: true; retry?: true } = {}): Promise<Step> {
	const stored = getDraft(id);
	const d = stored && withRecipient(stored);
	if (stored && d && d !== stored && stored.status === "pending") patchDraft(id, { to: d.to, item: d.item, questions: d.questions });
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요`, sent: "no", code: "gone" };
	if (d.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태라 보내지 않았어요`, sent: "no", code: "gone" };
	const card = opts.withReply ? undefined : linkedComment(id);
	if (card) return { ok: false, text: `이 메일은 댓글 답글(${card})과 한 장으로 승인해요. 답글 쪽 comments.ts send ${card}로 보내 주세요`, sent: "no", code: "not_approved" };
	const v: DraftVerdict = opts.withReply ? { verdict: opts.asIs ? "send-as-is" : "send" } : draftVerdict(paths.inbox(), d.id, Date.parse(d.created), d.kind === "mail" ? { conv: `mail:${d.ref}` } : {});
	if (v.verdict === "drop") {
		setStatus(id, "dropped");
		return { ok: false, text: "보내지 않기로 한 초안이에요", sent: "no", code: "not_approved" };
	}
	if (v.verdict === "edit") return { ok: false, text: `고치기를 골랐어요${v.detail ? ` (${v.detail})` : ""}. revise로 고친 뒤 다시 물어봐 주세요`, sent: "no", code: "not_approved" };
	if (v.verdict !== "send" && v.verdict !== "send-as-is") return { ok: false, text: "아직 보내도 된다는 답을 받지 못했어요", sent: "no", code: "not_approved" };
	const issues = v.verdict === "send" ? draftAttachIssues(d) : [];
	// Only a chosen file still on its way (and nothing else wrong) is `file_pending`, which code may retry; any other mismatch waits for the owner.
	if (issues.length) return { ok: false, text: `${ATTACH_REFUSED} ${issues.join(" · ")}. ${ATTACH_AS_IS_HINT}`, sent: "no", ...(issues.length === 1 && notYetStaged(d).length ? { code: "file_pending" } : { code: "attach_mismatch", vars: { issues: issues.join(" · ") } }) };
	const found = draftLint(d);
	if (found.length) return { ok: false, text: `${LINT_REFUSED} ${found.map(ownerWarning).join(" · ")}`, sent: "no", ...lintCode(found[0]!) };
	// A second send of the same draft (a double tap, a replayed answer, the CLI beside the gateway) waits for no one: it is refused.
	if (!opts.retry && claimHolder(claimFile(id)) === "dead") return { ok: false, text: `초안 ${id}은(는) 지난번에 보내다가 멈춰서 메일이 이미 나갔을 수 있어요. 보낸편지함을 확인하고, 안 나갔을 때만 다시 보내기를 눌러 주세요`, sent: "maybe", code: "interrupted" };
	// Another sender holds the claim and may still send it: no outcome of this run (design 2.3, the queue keeps it `sending`).
	const release = claimSend(claimFile(id), opts.retry === true);
	if (!release) return { ok: false, text: `초안 ${id}은(는) 지금 보내는 중이라 한 번 더 보내지 않았어요` };
	try {
		const now = getDraft(id);
		if (now?.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${now?.status ?? "없는"} 상태라 보내지 않았어요`, sent: "no", code: "gone" };
		let out: SendOutcome;
		try {
			out = await (deps.send ?? (rec => sendWith(rec, deps.run ?? realRunner)))(now);
		} catch (e) {
			console.error(`reply draft: sending ${id} threw: ${(e as Error).stack ?? (e as Error).message}`);
			out = { ok: false, message: `보내지 못했어요: ${(e as Error).message}`, sent: "maybe", code: "unknown" };
		}
		// Told right after the transport answered and before any bookkeeping write: a status write that throws after the mail left cannot turn it into a failure.
		// A sender that does not say where the mail is: out when it says ok, else it may have gone out.
		const where: Outcome = out.ok ? { sent: out.sent ?? "yes" } : { sent: out.sent ?? "maybe", code: out.code ?? "unknown", ...(out.vars ? { vars: out.vars } : {}) };
		deps.onOutcome?.(where);
		if (!out.ok) return { ok: false, text: out.message, sendFailed: true, sent: where.sent === "no" ? "no" : "maybe", code: where.code, ...(where.vars ? { vars: where.vars } : {}) };
		setStatus(id, "sent");
		// A text the owner wrote himself (직접 수정) teaches what he changed, in the profile of that draft, once it went out (design 3.4).
		const taught = now.editedFrom !== undefined ? editLesson(now.editedFrom, now.body) : undefined;
		if (taught) await recordLesson(toneKey(now), taught, deps).catch(e => console.error(`reply draft: what the edit of ${id} teaches was not recorded: ${(e as Error).message}`));
		// A draft the owner changed is his own wording now: it joins his past replies. An unchanged bot draft never does.
		if (now.kind === "mail" && !now.compose && (now.changes.length > 0 || taught !== undefined) && now.item.text.trim()) {
			try {
				const source = pairSource(now.source);
				addPair("mail", { received: now.item.text, reply: now.body, at: nowOf(deps).getTime(), edited: true, ...(addressesOf(now.item.from)[0] ? { from: addressesOf(now.item.from)[0] } : {}), ...(source !== "zele" ? { source } : {}) });
			} catch (e) {
				console.error(`reply draft: sent draft ${id} not kept as a past reply: ${(e as Error).message}`);
			}
		}
		return { ok: true, text: out.message };
	} finally {
		release();
	}
}

export const kindOf = (v: string | undefined): ReplyKind => (v === "comment" || v === "chat" ? v : "mail");
