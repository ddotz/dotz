// The draft life cycle shared by the gateway offer (offer.ts) and the CLI (bin/draft.ts): build -> ask -> revise | send | drop.
// Nothing here sends without the user's 1) 보내기 pick for exactly that draft id, read from the inbox log.
import { dirname, join } from "node:path";
import { linkedComment } from "../../../hub/comments/linked.ts";
import { claimSend } from "../../../hub/draft-claim.ts";
import { attachIssues } from "../../../hub/attach-check.ts";
import { ATTACH_AS_IS_HINT, ATTACH_REFUSED, asksForFile, claimsAttachment, draftApprovalBlock, draftVerdict, type DraftVerdict } from "../../../hub/draft-approval.ts";
import type { ReplyCall } from "../../../hub/reply-model.ts";
import { addressesOf, generateChatReply, lintReply, lessonOf, NO_RECIPIENT, RECIPIENT_FAILURE, reviseReply, SENT_CLAIM_FAILURE, withSenderAddress, type ModelCall, type Recipient, type ReplyItem, type ReplyKind, type ReplyStyle } from "../../../hub/reply-draft.ts";
import { matchLibrary, type LibraryFile } from "./library.ts";
import { basename } from "node:path";
import { canAttach, sendWith, webmailSite, type SendOutcome } from "./senders.ts";
import { carryStagedFiles, stagedFiles, stagedName, stageLibraryFile, type StageOpts } from "./staged.ts";
import { dataDir, loadSettings, loadStyle, paths, recordCorrection, type ToneKey } from "./settings.ts";
import { maybeRefine } from "./persona.ts";
import { addPair, styleWithExamples } from "./pairs.ts";
import { addDraft, getDraft, listDrafts, newId, patchDraft, setStatus, type DraftRec } from "./store.ts";
import { realRunner, type Runner } from "./tone.ts";

// `analyze` = the model call of the identity sweep and its refinement (persona.ts); absent, no identity is analysed or refined.
export type FlowDeps = { /** Chooses among tied library files by name (stageForReply); the default is one short model call. */ pick?: (names: string[]) => Promise<string[]>; call?: ModelCall; /** The model calls of one draft and its overall budget (draftTrace); buildDraft makes one when absent. */ trace?: DraftTrace; analyze?: ModelCall; run?: Runner; now?: () => Date; send?: (rec: DraftRec) => Promise<SendOutcome>; /** How library files are copied onto a draft (tests). */ stage?: StageOpts };

// After a recorded correction: every few corrections fold into the profile's identity. A failed refinement keeps the old identity.
export async function refineAfterCorrection(key: ToneKey, deps: FlowDeps): Promise<void> {
	if (!deps.analyze) return;
	await maybeRefine(key, deps.analyze).catch(e => console.error(`reply draft: identity of ${key.app} not refined: ${(e as Error).message}`));
}

// The tone profile an item or draft belongs to: its room when it has one, else its app (mail unless the item says otherwise).
export const toneKey = (x: { app?: string; room?: string }): ToneKey => ({ app: x.app ?? "mail", ...(x.room !== undefined ? { room: x.room } : {}) });
export type Meta = { source: string; mailId: string; ref: string; origAttachments?: number; /** The zele account the mail belongs to (its record's `account`); every zele call of the draft passes it. */ account?: string };
// "ask" (chat only): the message needs a decision only the user can make; `choices` are 2-4 short answers.
export type Built = { action: "skip"; reason: string } | { action: "draft"; rec: DraftRec; warnings: string[] } | { action: "ask"; question: string; choices: string[] };

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
// A mail draft's style carries the user's closest real past replies as examples; chat and comments keep theirs.
const styleOf = (item: ReplyItem, key: ToneKey) => (item.kind === "mail" ? styleWithExamples(loadStyle(key), "mail", item.text, item.from) : loadStyle(key));

function toRec(item: ReplyItem, meta: Meta, r: { draft: { to: string; subject?: string; body: string }; questions: string[]; recipient?: Recipient }, changes: string[], deps: FlowDeps): DraftRec {
	return { id: newId(), ...(r.recipient ? { recipient: r.recipient } : {}), kind: item.kind, app: item.app ?? "mail", ...(item.room !== undefined ? { room: item.room } : {}), ...meta, to: r.draft.to, ...(r.draft.subject ? { subject: r.draft.subject } : {}), body: r.draft.body, status: "pending", created: nowOf(deps).toISOString(), changes, questions: r.questions, item };
}

// The owner is asked once, with a complete draft (owner 2026-10-26): the one draft call already settles every open point it can from what it
// sees (hub/reply-draft.ts SYSTEM); what it still lists is what only the owner knows, asked inside the same approval card. A question a rule
// settles (the recipient's address: the sender's own, recovered from the text, or filled by the source's reply screen) is dropped, never sent
// back to the model.
export async function buildDraft(item: ReplyItem, meta: Meta, deps: FlowDeps): Promise<Built> {
	const trace = deps.trace ?? draftTrace();
	const style = styleOf(item, toneKey(item)), call = callOf({ ...deps, trace }, item, meta.ref);
	const r = await generateChatReply(item, style, call);
	if (r.action !== "draft") return r;
	const questions = item.kind === "mail" ? r.questions.filter(q => !ADDRESS_ASK.test(q)) : r.questions;
	return { action: "draft", rec: toRec(item, meta, { ...r, questions }, [], deps), warnings: r.warnings };
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
const FILE_WORD = /파일|첨부|악보|attach|file/i;
const CANNOT = /못|없|불가|can'?not|can'?t|unable|not able|no access|don'?t have|do not have/i;
export const claimsNoFile = (q: string): boolean => FILE_WORD.test(q) && CANNOT.test(q);
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
	const want = (rec.wantFiles ?? []).map(f => f.name);
	return want.length ? [...found, `아직 못 붙인 파일: ${want.join(", ")}`] : found;
}

// The [ask] message of one draft; the notes line carries lint warnings, the card's question what only the user can decide.
export function askText(draft: DraftRec, warnings: string[], headline = draft.compose ? "새 메일 초안을 만들었어요" : "답장 초안을 만들었어요"): string {
	const rec = withRecipient(draft);
	if (rec !== draft) warnings = warnings.filter(w => w !== NO_RECIPIENT);
	const notes = warnings.map(w => `확인: ${ownerWarning(w)}`.replace(/\s+/g, " ")).join(" / ");
	const staged = stagedFiles(rec.id).map(f => ({ name: f.name, size: f.size }));
	// A webmail site sends text only (senders.ts canAttach): its files are listed as the ones that stay behind, and a send that holds them is refused.
	const noFiles = rec.kind === "mail" && !!webmailSite(rec.source);
	const attachments = noFiles ? [] : staged;
	const issues = draftAttachIssues(rec);
	const keptBack = noFiles && staged.length ? { sendResult: "파일이 붙어 있어 보내지 않아요. 파일을 빼면 본문만 보내요" } : {};
	const block = draftApprovalBlock({ to: rec.to, toLabel: "받는이", ...(rec.cc?.length ? { cc: rec.cc } : {}), ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, ref: rec.id, question: rec.compose ? "이 메일 보낼까요?" : "이 답장 보낼까요?", decide: withoutNoFileClaims(rec), ...(rec.compose ? { sendResult: `${rec.to}에게 이 메일을 보내요` } : {}), ...keptBack, ...(noFiles ? { cannotAttach: staged.map(f => f.name) } : {}), ...(rec.origin ? { origin: { text: rec.origin.text, ...(rec.origin.link ? { link: rec.origin.link } : {}) } } : {}), ...(attachments.length ? { attachments } : {}), ...((rec.origAttachments ?? 0) > 0 ? { attachmentsNone: true } : {}), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}), ...(rec.rule ? { rule: rec.rule.name } : {}), ...(issues.length ? { attachIssues: issues } : {}) });
	return [`[ask] ${headline}`, ...(notes ? [`-# ${notes}`] : []), block].join("\n");
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

function pickByModel(item: ReplyItem, ref: string, deps: FlowDeps): (names: string[]) => Promise<string[]> {
	return async names => {
		const text = await callOf(deps, item, ref, "pick")("파일 이름만 보고 메일에 보낼 파일을 고릅니다. 고른 파일 이름을 한 줄에 하나씩, 최대 3개만 적습니다. 다른 말은 쓰지 않습니다.", `메일 제목: ${item.subject ?? ""}\n\n파일 이름:\n${names.map(n => `- ${n}`).join("\n")}`);
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

// A reply that promises a file or answers a mail that asks for one: the best matches of the 첨부 파일 폴더 are staged for the owner to confirm
// (they go out only with the owner's 보내기). Nothing fits -> the approval carries the warning and says so. A source that cannot send files gets neither.
// `files`: the match libraryFor started beside the draft call. Returns why a matched file is not on the draft (one line each), for the card;
// one file that cannot be copied never keeps the others off.
export async function stageForReply(rec: DraftRec, deps: FlowDeps, files?: Promise<LibraryFile[] | undefined>): Promise<string[]> {
	if (rec.kind !== "mail") return [];
	rec.asksFile = asksForFile(rec.item.text) || undefined;
	if (!rec.asksFile && !claimsAttachment(`${rec.subject ?? ""}\n${rec.body}`)) return [];
	const found = await (files ?? libraryFor(rec.item, rec, deps));
	if (!found) return [];
	if (!found.length) rec.libraryMiss = true;
	const failed: string[] = [];
	// Together, not one by one: each evicted iCloud file may wait up to 30 s for its download, and the offer queue waits on this draft.
	await Promise.all(found.map(f => stageLibraryFile(rec.id, f.path, deps.stage).catch(e => void failed.push((e as Error).message))));
	// Files are on the draft now: a model question that says no file can be attached is false.
	if (stagedFiles(rec.id).length) rec.questions = withoutNoFileClaims(rec);
	return failed;
}

// A revised draft looks for files again with the same library pick (the first one ran before the words existed): when the owner's change names a file,
// those matches are added; else when the draft asks for a file or promises one and none is staged, the mail's own pick runs. Files already on the draft
// (the owner's own, or an earlier pick) stay. Returns why a matched file is not on the draft.
async function restageForRevision(rec: DraftRec, change: string, deps: FlowDeps): Promise<string[]> {
	if (rec.kind !== "mail" || !canAttach(rec.source)) return [];
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
	const failed: string[] = [];
	for (const f of found) await stageLibraryFile(rec.id, f.path, deps.stage).catch(e => failed.push((e as Error).message));
	if (stagedFiles(rec.id).length) {
		delete rec.libraryMiss;
		rec.questions = withoutNoFileClaims(rec);
	} else if (missed) rec.libraryMiss = true;
	return failed;
}

export type Step = { ok: boolean; text: string; /** The id of the draft a revision made. */ id?: string; /** The approved send itself failed (not the approval gate): the owner has to hear it. */ sendFailed?: true };

// The user picked 2) 고치기 (or the CLI is asked to): the draft is regenerated, and once that worked the lasting preference the change shows (the model's `lesson`;
// the change itself when the model left it out; nothing when the change was only about this draft) is recorded in the tone profile of that draft (its room, else its app).
// The change stays verbatim in the draft's own `changes`.
export async function reviseDraft(id: string, change: string, deps: FlowDeps): Promise<Step> {
	const found = getDraft(id);
	const old = found && withRecipient(found);
	if (!old) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (old.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${old.status} 상태라 고칠 수 없어요` };
	if (!change.trim()) return { ok: false, text: "무엇을 고칠지 적어 주세요 (--change)" };
	// The words are rewritten knowing which files ride on the draft now.
	const held = stagedFiles(old.id).map(f => f.name);
	const item = held.length ? { ...old.item, files: held } : old.item;
	const r = await reviseReply(item, styleOf(old.item, toneKey(old)), { to: old.to, subject: old.subject, body: old.body }, change, callOf(deps, old.item, old.ref));
	if (r.action === "skip") return { ok: false, text: `고친 초안을 만들지 못했어요: ${r.reason}` };
	const lesson = lessonOf(r, change);
	if (lesson) {
		recordCorrection(toneKey(old), lesson, nowOf(deps));
		await refineAfterCorrection(toneKey(old), deps);
	}
	const rec = toRec(old.item, { source: old.source, mailId: old.mailId, ref: old.ref, ...(old.account ? { account: old.account } : {}), ...(old.origAttachments ? { origAttachments: old.origAttachments } : {}) }, r, [...old.changes, change], deps);
	// The recipients the owner set on the card stay: a rewrite of the words is not a reason to send it to somebody else.
	rec.to = old.to;
	if (old.cc?.length) rec.cc = old.cc;
	if (old.mode) rec.mode = old.mode;
	if (old.ownerRecipients) rec.ownerRecipients = true;
	if (old.asksFile) rec.asksFile = true;
	if (old.libraryMiss) rec.libraryMiss = true;
	if (old.compose) rec.compose = true;
	if (old.origin) rec.origin = old.origin;
	if (old.rule) rec.rule = old.rule;
	carryStagedFiles(old.id, rec.id);
	const notStaged = await restageForRevision(rec, change, deps).catch(e => [(e as Error).message]);
	addDraft(rec);
	return { ok: true, text: askText(rec, [...r.warnings, ...notStaged], "답장 초안을 고쳤어요"), id: rec.id };
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
export async function sendDraft(id: string, deps: FlowDeps, opts: { withReply?: true; asIs?: true } = {}): Promise<Step> {
	const stored = getDraft(id);
	const d = stored && withRecipient(stored);
	if (stored && d && d !== stored && stored.status === "pending") patchDraft(id, { to: d.to, item: d.item, questions: d.questions });
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (d.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태라 보내지 않았어요` };
	const card = opts.withReply ? undefined : linkedComment(id);
	if (card) return { ok: false, text: `이 메일은 댓글 답글(${card})과 한 장으로 승인해요. 답글 쪽 comments.ts send ${card}로 보내 주세요` };
	const v: DraftVerdict = opts.withReply ? { verdict: opts.asIs ? "send-as-is" : "send" } : draftVerdict(paths.inbox(), d.id, Date.parse(d.created), d.kind === "mail" ? { conv: `mail:${d.ref}` } : {});
	if (v.verdict === "drop") {
		setStatus(id, "dropped");
		return { ok: false, text: "보내지 않기로 한 초안이에요" };
	}
	if (v.verdict === "edit") return { ok: false, text: `고치기를 골랐어요${v.detail ? ` (${v.detail})` : ""}. revise로 고친 뒤 다시 물어봐 주세요` };
	if (v.verdict !== "send" && v.verdict !== "send-as-is") return { ok: false, text: "아직 보내도 된다는 답을 받지 못했어요" };
	const issues = v.verdict === "send" ? draftAttachIssues(d) : [];
	if (issues.length) return { ok: false, text: `${ATTACH_REFUSED} ${issues.join(" · ")}. ${ATTACH_AS_IS_HINT}` };
	const failures = lintReply({ to: d.to, subject: d.subject, body: d.body }, d.item, loadStyle(toneKey(d)), { anyRecipient: d.ownerRecipients === true });
	if (failures.length) return { ok: false, text: `보내기 직전 검사에서 걸려서 보내지 않았어요: ${failures.map(ownerWarning).join(" · ")}` };
	// A second send of the same draft (a double tap, a replayed answer, the CLI beside the gateway) waits for no one: it is refused.
	const release = claimSend(join(dirname(paths.drafts()), "sending", id));
	if (!release) return { ok: false, text: `초안 ${id}은(는) 지금 보내는 중이라 한 번 더 보내지 않았어요` };
	try {
		const now = getDraft(id);
		if (now?.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${now?.status ?? "없는"} 상태라 보내지 않았어요` };
		const out = await (deps.send ?? (rec => sendWith(rec, deps.run ?? realRunner)))(now);
		if (!out.ok) return { ok: false, text: out.message, sendFailed: true };
		setStatus(id, "sent");
		// A draft the owner changed is his own wording now: it joins his past replies. An unchanged bot draft never does.
		if (now.kind === "mail" && !now.compose && now.changes.length > 0 && now.item.text.trim()) {
			try {
				addPair("mail", { received: now.item.text, reply: now.body, at: nowOf(deps).getTime(), ...(addressesOf(now.item.from)[0] ? { from: addressesOf(now.item.from)[0] } : {}) });
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
