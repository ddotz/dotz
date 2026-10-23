// The draft life cycle shared by the gateway offer (offer.ts) and the CLI (bin/draft.ts): build -> ask -> revise | send | drop.
// Nothing here sends without the user's 1) 보내기 pick for exactly that draft id, read from the inbox log.
import { draftApprovalBlock, draftVerdict } from "../../../hub/draft-approval.ts";
import { generateReply, lintReply, reviseReply, type ModelCall, type ReplyItem, type ReplyKind } from "../../../hub/reply-draft.ts";
import { sendWith, type SendOutcome } from "./senders.ts";
import { loadSettings, loadStyle, paths, recordCorrection, type ToneKey } from "./settings.ts";
import { addDraft, getDraft, newId, setStatus, type DraftRec } from "./store.ts";
import { realRunner, type Runner } from "./tone.ts";

export type FlowDeps = { call?: ModelCall; run?: Runner; now?: () => Date; send?: (rec: DraftRec) => Promise<SendOutcome> };

// The tone profile an item or draft belongs to: its room when it has one, else its app (mail unless the item says otherwise).
export const toneKey = (x: { app?: string; room?: string }): ToneKey => ({ app: x.app ?? "mail", ...(x.room !== undefined ? { room: x.room } : {}) });
export type Meta = { source: string; mailId: string; ref: string };
export type Built = { action: "skip"; reason: string } | { action: "draft"; rec: DraftRec; warnings: string[] };

// The subscription-only model call of the gateway (hub/outlang.ts callModel), loaded on first use so nothing else pulls in the gateway config.
export function defaultCall(model?: string): ModelCall {
	return async (system, user) => {
		const { callModel } = await import("../../../hub/outlang.ts");
		return (await callModel(system, user, { model, timeoutMs: 120_000 })).text;
	};
}

const callOf = (deps: FlowDeps): ModelCall => deps.call ?? defaultCall(loadSettings().model);
const nowOf = (deps: FlowDeps) => (deps.now ?? (() => new Date()))();

function toRec(item: ReplyItem, meta: Meta, r: { draft: { to: string; subject?: string; body: string }; questions: string[] }, changes: string[], deps: FlowDeps): DraftRec {
	return { id: newId(), kind: item.kind, app: item.app ?? "mail", ...(item.room !== undefined ? { room: item.room } : {}), ...meta, to: r.draft.to, ...(r.draft.subject ? { subject: r.draft.subject } : {}), body: r.draft.body, status: "pending", created: nowOf(deps).toISOString(), changes, questions: r.questions, item };
}

export async function buildDraft(item: ReplyItem, meta: Meta, deps: FlowDeps): Promise<Built> {
	const r = await generateReply(item, loadStyle(toneKey(item)), callOf(deps));
	return r.action === "skip" ? r : { action: "draft", rec: toRec(item, meta, r, [], deps), warnings: r.warnings };
}

// The [ask] message of one draft; the notes line carries lint warnings and what only the user can decide.
export function askText(rec: DraftRec, warnings: string[], headline = "답장 초안을 만들었어요"): string {
	const notes = [...warnings.map(w => `확인: ${w}`), ...rec.questions.map(q => `정해 주세요: ${q}`)].map(n => n.replace(/\s+/g, " ")).join(" / ");
	const block = draftApprovalBlock({ to: rec.to, toLabel: "받는이", ...(rec.subject ? { subject: rec.subject } : {}), body: rec.body, ref: rec.id, question: "이 답장 보낼까요?" });
	return [`[ask] ${headline}`, ...(notes ? [`-# ${notes}`] : []), block].join("\n");
}

export type Step = { ok: boolean; text: string };

// The user picked 2) 고치기 (or the CLI is asked to): the change is recorded verbatim in the tone profile of that draft (its room, else its app), then the draft is regenerated.
export async function reviseDraft(id: string, change: string, deps: FlowDeps): Promise<Step> {
	const old = getDraft(id);
	if (!old) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (old.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${old.status} 상태라 고칠 수 없어요` };
	if (!change.trim()) return { ok: false, text: "무엇을 고칠지 적어 주세요 (--change)" };
	recordCorrection(toneKey(old), change, nowOf(deps));
	const r = await reviseReply(old.item, loadStyle(toneKey(old)), { to: old.to, subject: old.subject, body: old.body }, change, callOf(deps));
	if (r.action === "skip") return { ok: false, text: `고친 초안을 만들지 못했어요: ${r.reason}` };
	const rec = toRec(old.item, { source: old.source, mailId: old.mailId, ref: old.ref }, r, [...old.changes, change], deps);
	addDraft(rec);
	return { ok: true, text: askText(rec, r.warnings, "답장 초안을 고쳤어요") };
}

export function dropDraft(id: string): Step {
	const d = getDraft(id);
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (d.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태예요` };
	setStatus(id, "dropped");
	return { ok: true, text: `초안 ${id}을(를) 버렸어요` };
}

// Refuses unless the user's latest pick for this exact draft id, made after the draft was created, is 1) 보내기; lints again first.
export async function sendDraft(id: string, deps: FlowDeps): Promise<Step> {
	const d = getDraft(id);
	if (!d) return { ok: false, text: `초안 ${id}을(를) 찾지 못했어요` };
	if (d.status !== "pending") return { ok: false, text: `초안 ${id}은(는) 이미 ${d.status} 상태라 보내지 않았어요` };
	const v = draftVerdict(paths.inbox(), d.id, Date.parse(d.created));
	if (v.verdict === "drop") {
		setStatus(id, "dropped");
		return { ok: false, text: "보내지 않기로 한 초안이에요" };
	}
	if (v.verdict === "edit") return { ok: false, text: `고치기를 골랐어요${v.detail ? ` (${v.detail})` : ""}. revise로 고친 뒤 다시 물어봐 주세요` };
	if (v.verdict !== "send") return { ok: false, text: "아직 보내도 된다는 답을 받지 못했어요" };
	const failures = lintReply({ to: d.to, subject: d.subject, body: d.body }, d.item, loadStyle(toneKey(d)));
	if (failures.length) return { ok: false, text: `보내기 직전 검사에서 걸려서 보내지 않았어요: ${failures.join("; ")}` };
	const out = await (deps.send ?? (rec => sendWith(rec, deps.run ?? realRunner)))(d);
	if (!out.ok) return { ok: false, text: out.message };
	setStatus(id, "sent");
	return { ok: true, text: out.message };
}

export const kindOf = (v: string | undefined): ReplyKind => (v === "comment" || v === "chat" ? v : "mail");
