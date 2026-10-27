// The draft life cycle shared by the gateway offer (offer.ts) and the CLI (bin/draft.ts): build -> ask -> revise | send | drop.
// Nothing here sends without the user's 1) 보내기 pick for exactly that draft id, read from the inbox log.
import { dirname, join } from "node:path";
import { linkedComment } from "../../../hub/comments/linked.ts";
import { claimSend } from "../../../hub/draft-claim.ts";
import { asksForFile, claimsAttachment, draftApprovalBlock, draftVerdict, type DraftVerdict } from "../../../hub/draft-approval.ts";
import type { ReplyCall } from "../../../hub/reply-model.ts";
import { addressesOf, generateChatReply, lintReply, NO_RECIPIENT, reviseReply, withSenderAddress, type ModelCall, type ReplyItem, type ReplyKind } from "../../../hub/reply-draft.ts";
import { matchLibrary } from "./library.ts";
import { canAttach, sendWith, webmailSite, type SendOutcome } from "./senders.ts";
import { addStagedFile, carryStagedFiles, stagedFiles } from "./staged.ts";
import { dataDir, loadSettings, loadStyle, paths, recordCorrection, type ToneKey } from "./settings.ts";
import { maybeRefine } from "./persona.ts";
import { addDraft, getDraft, newId, patchDraft, setStatus, type DraftRec } from "./store.ts";
import { realRunner, type Runner } from "./tone.ts";

// `analyze` = the model call of the identity sweep and its refinement (persona.ts); absent, no identity is analysed or refined.
export type FlowDeps = { /** Chooses among tied library files by name (stageForReply); the default is one short model call. */ pick?: (names: string[]) => Promise<string[]>; call?: ModelCall; analyze?: ModelCall; run?: Runner; now?: () => Date; send?: (rec: DraftRec) => Promise<SendOutcome> };

// After a recorded correction: every few corrections fold into the profile's identity. A failed refinement keeps the old identity.
export async function refineAfterCorrection(key: ToneKey, deps: FlowDeps): Promise<void> {
	if (!deps.analyze) return;
	await maybeRefine(key, deps.analyze).catch(e => console.error(`reply draft: identity of ${key.app} not refined: ${(e as Error).message}`));
}

// The tone profile an item or draft belongs to: its room when it has one, else its app (mail unless the item says otherwise).
export const toneKey = (x: { app?: string; room?: string }): ToneKey => ({ app: x.app ?? "mail", ...(x.room !== undefined ? { room: x.room } : {}) });
export type Meta = { source: string; mailId: string; ref: string; origAttachments?: number };
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

const callOf = (deps: FlowDeps, item: ReplyItem, conv?: string): ModelCall => deps.call ?? replyCall(item.app ?? "mail", conv);
const nowOf = (deps: FlowDeps) => (deps.now ?? (() => new Date()))();

function toRec(item: ReplyItem, meta: Meta, r: { draft: { to: string; subject?: string; body: string }; questions: string[] }, changes: string[], deps: FlowDeps): DraftRec {
	return { id: newId(), kind: item.kind, app: item.app ?? "mail", ...(item.room !== undefined ? { room: item.room } : {}), ...meta, to: r.draft.to, ...(r.draft.subject ? { subject: r.draft.subject } : {}), body: r.draft.body, status: "pending", created: nowOf(deps).toISOString(), changes, questions: r.questions, item };
}

// The owner is asked once, with a complete draft (owner 2026-10-26): a draft that came back with open points is sent back to the model once to
// settle them from what it can see; what it still cannot settle is what only the owner knows, asked inside the same approval card.
const RESOLVE = (questions: string[]) => `Settle these open points yourself from the message, its context and the user's samples, rules and corrections, and make the reply complete without them (still promise nothing you cannot see). In "questions" keep only a fact the reply cannot go out without and that nothing above settles:\n${questions.map(q => `- ${q}`).join("\n")}`;

export async function buildDraft(item: ReplyItem, meta: Meta, deps: FlowDeps): Promise<Built> {
	const style = loadStyle(toneKey(item)), call = callOf(deps, item, meta.ref);
	let r = await generateChatReply(item, style, call);
	if (r.action === "draft" && r.questions.length && item.kind !== "chat") {
		const settled = await reviseReply(item, style, r.draft, RESOLVE(r.questions), call);
		if (settled.action === "draft") r = settled;
	}
	return r.action !== "draft" ? r : { action: "draft", rec: toRec(item, meta, r, [], deps), warnings: r.warnings };
}

// The approval question with what only the owner can decide in it, so one card asks everything: "이 답장 보낼까요? 정할 것: 회의 날짜".
export const askWith = (question: string, open: string[]): string => (open.length ? `${question} 정할 것: ${open.map(q => q.replace(/[()]/g, " ").replace(/\s+/g, " ").trim()).join(", ")}` : question);

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
	if (w === "the text contains a placeholder") return "채워 넣지 않은 자리표시가 있어요";
	if ((x = m(/^it uses the forbidden expression '(.+)'$/))) return `쓰지 않기로 한 표현 '${x[1]}'이(가) 있어요`;
	return w;
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
	const keptBack = noFiles && staged.length ? { sendResult: "파일이 붙어 있어 보내지 않아요. 파일을 빼면 본문만 보내요" } : {};
	const block = draftApprovalBlock({ to: rec.to, toLabel: "받는이", ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, ref: rec.id, question: askWith(rec.compose ? "이 메일 보낼까요?" : "이 답장 보낼까요?", rec.questions ?? []), ...(rec.compose ? { sendResult: `${rec.to}에게 이 메일을 보내요` } : {}), ...keptBack, ...(noFiles ? { cannotAttach: staged.map(f => f.name) } : {}), ...(rec.origin ? { origin: { text: rec.origin.text, ...(rec.origin.link ? { link: rec.origin.link } : {}) } } : {}), ...(attachments.length ? { attachments } : {}), ...((rec.origAttachments ?? 0) > 0 ? { attachmentsNone: true } : {}), ...(rec.asksFile ? { asksFile: true } : {}), ...(rec.libraryMiss ? { libraryMiss: true } : {}) });
	return [`[ask] ${headline}`, ...(notes ? [`-# ${notes}`] : []), block].join("\n");
}

// The 첨부 파일 폴더 of the mail app instance that owns the mail `ref` (app setting attach_folder), or undefined.
export async function attachFolder(ref: string): Promise<string | undefined> {
	try {
		const { instanceOf } = await import("../../../hub/reply-model.ts");
		const { appEntries } = await import("../../../hub/integrations.ts");
		return loadSettings().attachFolders?.[instanceOf(appEntries(dataDir()), "mail", ref)];
	} catch {
		return undefined;
	}
}

function pickByModel(rec: DraftRec, deps: FlowDeps): (names: string[]) => Promise<string[]> {
	return async names => {
		const text = await callOf(deps, rec.item, rec.ref)("파일 이름만 보고 메일에 보낼 파일을 고릅니다. 고른 파일 이름을 한 줄에 하나씩, 최대 3개만 적습니다. 다른 말은 쓰지 않습니다.", `메일 제목: ${rec.item.subject ?? ""}\n\n파일 이름:\n${names.map(n => `- ${n}`).join("\n")}`);
		return text.split("\n").map(l => l.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
	};
}

// A reply that promises a file or answers a mail that asks for one: the best matches of the 첨부 파일 폴더 are staged for the owner to confirm
// (they go out only with the owner's 보내기). Nothing fits -> the approval carries the warning and says so. A source that cannot send files gets neither.
export async function stageForReply(rec: DraftRec, deps: FlowDeps): Promise<void> {
	if (rec.kind !== "mail") return;
	rec.asksFile = asksForFile(rec.item.text) || undefined;
	if (!rec.asksFile && !claimsAttachment(`${rec.subject ?? ""}\n${rec.body}`)) return;
	if (!canAttach(rec.source)) return;
	const folder = await attachFolder(rec.ref);
	if (!folder) return;
	const found = await matchLibrary(folder, { subject: rec.item.subject ?? "", text: rec.item.text }, deps.pick ?? pickByModel(rec, deps));
	for (const f of found) addStagedFile(rec.id, f.path);
	if (!found.length) rec.libraryMiss = true;
}

export type Step = { ok: boolean; text: string; /** The id of the draft a revision made. */ id?: string };

// The user picked 2) 고치기 (or the CLI is asked to): the change is recorded verbatim in the tone profile of that draft (its room, else its app), then the draft is regenerated.
export async function reviseDraft(id: string, change: string, deps: FlowDeps): Promise<Step> {
	const found = getDraft(id);
	const old = found && withRecipient(found);
	if (!old) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (old.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${old.status} 상태라 고칠 수 없어요` };
	if (!change.trim()) return { ok: false, text: "무엇을 고칠지 적어 주세요 (--change)" };
	recordCorrection(toneKey(old), change, nowOf(deps));
	await refineAfterCorrection(toneKey(old), deps);
	const r = await reviseReply(old.item, loadStyle(toneKey(old)), { to: old.to, subject: old.subject, body: old.body }, change, callOf(deps, old.item, old.ref));
	if (r.action === "skip") return { ok: false, text: `고친 초안을 만들지 못했어요: ${r.reason}` };
	const rec = toRec(old.item, { source: old.source, mailId: old.mailId, ref: old.ref, ...(old.origAttachments ? { origAttachments: old.origAttachments } : {}) }, r, [...old.changes, change], deps);
	if (old.asksFile) rec.asksFile = true;
	if (old.libraryMiss) rec.libraryMiss = true;
	if (old.compose) rec.compose = true;
	if (old.origin) rec.origin = old.origin;
	carryStagedFiles(old.id, rec.id);
	addDraft(rec);
	return { ok: true, text: askText(rec, r.warnings, "답장 초안을 고쳤어요"), id: rec.id };
}

export function dropDraft(id: string): Step {
	const d = getDraft(id);
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (d.status !== "pending" && d.status !== "held") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태예요` };
	setStatus(id, "dropped");
	return { ok: true, text: `초안 ${id}을(를) 버렸어요` };
}

// Refuses unless the user's latest pick for this exact draft id, made after the draft was created, is 1) 보내기; lints again first.
// `withReply`: the mail rides on a comment reply (hub/comments/linked.ts) and the caller is that reply's send, which has already passed the
// reply's gate (the owner's pick on the one card, or the owner's own click); a linked mail is refused without it.
export async function sendDraft(id: string, deps: FlowDeps, opts: { withReply?: true } = {}): Promise<Step> {
	const stored = getDraft(id);
	const d = stored && withRecipient(stored);
	if (stored && d && d !== stored && stored.status === "pending") patchDraft(id, { to: d.to, item: d.item, questions: d.questions });
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (d.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태라 보내지 않았어요` };
	const card = opts.withReply ? undefined : linkedComment(id);
	if (card) return { ok: false, text: `이 메일은 댓글 답글(${card})과 한 장으로 승인해요. 답글 쪽 comments.ts send ${card}로 보내 주세요` };
	const v: DraftVerdict = opts.withReply ? { verdict: "send" } : draftVerdict(paths.inbox(), d.id, Date.parse(d.created));
	if (v.verdict === "drop") {
		setStatus(id, "dropped");
		return { ok: false, text: "보내지 않기로 한 초안이에요" };
	}
	if (v.verdict === "edit") return { ok: false, text: `고치기를 골랐어요${v.detail ? ` (${v.detail})` : ""}. revise로 고친 뒤 다시 물어봐 주세요` };
	if (v.verdict !== "send") return { ok: false, text: "아직 보내도 된다는 답을 받지 못했어요" };
	const failures = lintReply({ to: d.to, subject: d.subject, body: d.body }, d.item, loadStyle(toneKey(d)));
	if (failures.length) return { ok: false, text: `보내기 직전 검사에서 걸려서 보내지 않았어요: ${failures.map(ownerWarning).join(" · ")}` };
	// A second send of the same draft (a double tap, a replayed answer, the CLI beside the gateway) waits for no one: it is refused.
	const release = claimSend(join(dirname(paths.drafts()), "sending", id));
	if (!release) return { ok: false, text: `초안 ${id}은(는) 지금 보내는 중이라 한 번 더 보내지 않았어요` };
	try {
		const now = getDraft(id);
		if (now?.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${now?.status ?? "없는"} 상태라 보내지 않았어요` };
		const out = await (deps.send ?? (rec => sendWith(rec, deps.run ?? realRunner)))(now);
		if (!out.ok) return { ok: false, text: out.message };
		setStatus(id, "sent");
		return { ok: true, text: out.message };
	} finally {
		release();
	}
}

export const kindOf = (v: string | undefined): ReplyKind => (v === "comment" || v === "chat" ? v : "mail");
