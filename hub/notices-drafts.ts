// Send-approval cards: staged files, recipients, Discord post, the settle pass. A part of the notice store split out of hub/notices.ts, code unchanged.
import { log, now } from "./config.ts";
import { parseDecisions } from "./choices.ts";
import { ATTACH_REFUSED, blockDraftRef, type DraftApproval, type DraftFileIn, parseDraftApproval, refreshDraft, rewriteDraftTo, withAttachIssues, withStagedFiles } from "./draft-approval.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import type { Decision, DecisionOpt, Notice } from "./notices-types.ts";
import { appLabelOf, appOf, draftHandled } from "./notices-wiring.ts";
import { TEXT_MAX, isOpenDecision } from "./notices-rules.ts";
import { items, save, settleDecision } from "./notices-store.ts";
import { refreshNoticeDrafts, retitleDraftCard } from "./notices-stored.ts";
import { announce, reopenNotices } from "./notices-answers.ts";

// An open send-approval card shows the files staged for its draft now, not the ones staged when it was posted: a file attached later
// (첨부 API, draft.ts revise, a rule or the 첨부 파일 폴더) rewrites its `> 첨부:` rows and the "no file" warning goes, without asking again
// (owner 2026-11-02). `filesOf(id)`: the files staged for a pending draft, undefined when dotz does not stage that draft's files.
// The reply part is its card ref, the 함께 보낼 메일 part its own id. Returns the cards that changed.
// `issuesOf(id)`: where that draft's words and files disagree (flow.ts draftAttachIssues), undefined when it is not a draft of dotz: the card's
// `첨부 확인` line and its 4th option follow it the same way (an open card may be answered 이대로 보내기 only while it carries them).
function optionsOf(old: DecisionOpt[], text: string): DecisionOpt[] {
	const blocks = parseDecisions(text).blocks;
	return blocks.length === 1 ? blocks[0]!.options.map(o => ({ ...old.find(x => x.label === o.label), ...o })) : old;
}
export function refreshDraftFiles(list: Notice[], filesOf: (id: string) => DraftFileIn[] | undefined, issuesOf?: (id: string) => string[] | undefined): Notice[] {
	const hit: Notice[] = [];
	for (const it of list) {
		const d = it.decision?.draft;
		if (!d?.ref || !isOpenDecision(it)) continue;
		const main = filesOf(d.ref);
		let text = main ? withStagedFiles(it.text, main) : it.text;
		const mail = d.mail?.ref ? filesOf(d.mail.ref) : undefined;
		if (mail) text = withStagedFiles(text, mail, "mail");
		const found = [issuesOf?.(d.ref), d.mail?.ref ? issuesOf?.(d.mail.ref) : undefined];
		const before = text;
		if (found.some(x => x !== undefined)) text = withAttachIssues(text, found.flatMap(x => x ?? []));
		if (text === it.text) continue;
		if (text !== before) it.decision!.options = optionsOf(it.decision!.options, text);
		it.text = text;
		it.decision!.draft = refreshDraft(d, text);
		hit.push(it);
	}
	return hit;
}
// A card whose words changed this way is out on Discord as it was: outbound.ts edits it there, buttons included.
const refreshedHooks: ((n: Notice) => void)[] = [];
export const onDraftCardRefreshed = (fn: (n: Notice) => void): void => void refreshedHooks.push(fn);
export function syncDraftFiles(filesOf: (id: string) => DraftFileIn[] | undefined, issuesOf?: (id: string) => string[] | undefined): number {
	const hit = refreshDraftFiles(items, filesOf, issuesOf);
	if (hit.length) announce(hit, now());
	for (const n of hit) for (const fn of refreshedHooks) fn(n);
	return hit.length;
}
/** The newest open card of draft `ref` in `to` went to Discord as these messages. */
export function markDraftPosted(to: string, ref: string, target: string, ids: string[]): void {
	const n = items.findLast(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref);
	if (!n || !ids.length) return;
	n.decision!.card = { target, ids };
	save();
}
export const openDraftRefs = (to: string): string[] => items.flatMap(i => (isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref ? [i.decision!.draft.ref] : []));
/** The open send-approval cards (of one conversation, or all): notice id, conversation, draft ref, question and draft (hub/approval-wire.ts). */
export const openDraftCards = (to?: string): { id: string; to: string; ref: string; title: string; draft: DraftApproval; at: string; text: string }[] =>
	items.flatMap(i => (isOpenDecision(i) && (to === undefined || i.decision!.to === to) && i.decision!.draft?.ref ? [{ id: i.id, to: i.decision!.to, ref: i.decision!.draft.ref, title: i.title, draft: i.decision!.draft, at: i.at ?? i.ts, text: i.text }] : []));
/** The newest card of draft `ref` in `to` shows how the gateway's send of it went. */
export function markDraftSend(to: string, ref: string, state: NonNullable<Decision["send"]>["state"], text = "", until?: number): void {
	const n = items.findLast(i => i.decision?.to === to && openDraftRef(i) === ref);
	if (!n) return;
	const at = now();
	const prev = n.decision!.send;
	const attempts = state === "queued" && prev?.state === "failed" ? (prev.attempts ?? 1) + 1 : prev?.attempts;
	n.decision!.send = { state, ...(text ? { text: text.slice(0, 300) } : {}), at, ...(attempts ? { attempts } : {}), ...(until ? { until } : {}) };
	// A send refused for its files leaves the draft pending: its card opens again with the reason, so it can be answered (이대로 보내기) or the files fixed.
	// A send taken back (cancelled in its window, or the gateway restarted in it) leaves the draft pending: the card opens again with the reason, once, on the card.
	if (((state === "failed" && text.startsWith(ATTACH_REFUSED)) || state === "back") && n.decision!.state !== "open") reopenNotices([n.id]);
	else announce([n], at);
}
// The bot posted the open card of draft `ref` again with changes (or the queue changed its "남은 N건" line): the open card shows the new text in place.
export const openDraftText = (to: string, ref: string): string | undefined => items.find(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref)?.text;
export function rewriteOpenDraft(to: string, ref: string, text: string): number {
	const hit = items.filter(i => isOpenDecision(i) && i.decision!.to === to && i.decision!.draft?.ref === ref);
	if (!hit.length) return 0;
	const body = parseTone(stripHandoff(text)).text.trim();
	const draft = parseDraftApproval(body);
	const at = now();
	for (const n of hit) {
		n.text = body.slice(0, TEXT_MAX);
		if (draft) n.decision!.draft = draft;
		retitleDraftCard(n);
		n.updated = at;
	}
	announce(hit, at);
	return hit.length;
}

const openDraftRef = (i: Notice): string | undefined => i.decision!.draft?.ref ?? blockDraftRef(i.title, i.decision!.options.map(o => o.label));
export async function settleHandledDrafts(at = now()): Promise<number> {
	const open = items.flatMap(i => {
		const ref = isOpenDecision(i) && !i.decision!.to.startsWith("auth:") ? openDraftRef(i) : undefined;
		return ref ? [{ i, ref }] : [];
	});
	const hit: Notice[] = [];
	for (const { i, ref } of open)
		if (await (async () => draftHandled(i.decision!, i, ref))().catch(() => false)) hit.push(i);
	for (const i of hit) if (isOpenDecision(i)) settleDecision(i, "", at, true);
	return hit.length;
}
// The one-time card audit (hub/migrations.ts): the send-approval cards of this install, open or closed, and those still open.
const isDraftCard = (i: Notice) => !!i.decision && !i.decision.to.startsWith("auth:") && !!openDraftRef(i);
export const draftCardCounts = (): { all: number; open: number } => {
	const all = items.filter(isDraftCard);
	return { all: all.length, open: all.filter(isOpenDecision).length };
};
/** The re-read of the load, on the live cards: an open card's title follows its draft's ref, so its 보내기 passes the send gate. */
export function refreshStoredDrafts(at = now()): number {
	const n = refreshNoticeDrafts(items);
	if (n) announce(items.filter(i => isOpenDecision(i) && i.decision!.draft), at);
	return n;
}

// A draft sent or dropped from 모니터링 closes its card in the conversation at once, not at the next 30 s sweep: the apps announce every change
// of a draft or a send, so a burst of them runs one pass and at most one more after it.
export const DRAFT_CHANGED = new Set(["comment_send", "comment_draft", "kakao_send", "kakao_draft", "mail_unreplied"]);
let settling = false, settleAgain = false;
export function settleSoon(): void {
	if (settling) return void (settleAgain = true);
	settling = true;
	void settleHandledDrafts()
		.catch(e => log(`handled-draft settle failed: ${(e as Error).message}`))
		.finally(() => {
			settling = false;
			if (settleAgain) {
				settleAgain = false;
				settleSoon();
			}
		});
}
export const confirmNoun = (key: string) => (["mail", "kakao"].includes(key.split("-")[0]!) ? "답장 확인" : "댓글 답글");
export function confirmGroup(n: Notice): { key: string; label: string; count: number } | undefined {
	if (!isOpenDecision(n) || !n.decision!.draft) return undefined;
	const key = appOf(n);
	if (!key) return undefined;
	const count = items.filter(i => isOpenDecision(i) && i.decision!.draft && appOf(i) === key).length;
	return { key, label: `${appLabelOf(key)} ${confirmNoun(key)}`, count };
}

// The send approvals of drafts that wait again (답장 필요로 되돌리기 restored a held draft): a card that was settled as resolved (never answered
// by the owner) opens again in 확인 대기.
export function reopenDraftNotices(draftIds: string[]): { reopened: string[]; unread: number } {
	const want = new Set(draftIds);
	return reopenNotices(items.filter(i => i.decision?.draft?.ref && want.has(i.decision.draft.ref) && i.decision.state === "answered" && i.decision.resolved).map(i => i.id));
}

// The 받는 사람·참조 of a waiting mail draft changed (hub/draft-recipients.ts): every open card of that draft shows the new lines at once, on
// every page, and its stored text is rewritten so a restart reads the same card. Returns how many cards changed.
export function updateDraftRecipients(ref: string, r: { to: string; cc: string[]; mode?: "reply" | "all" }): number {
	const hit = items.filter(i => i.decision?.state === "open" && i.decision.draft?.ref === ref);
	if (!hit.length) return 0;
	const at = now();
	for (const n of hit) {
		const d = n.decision!;
		const next: DraftApproval = { ...d.draft!, to: r.to, ...(r.cc.length ? { cc: r.cc } : {}), ...(r.mode ? { mode: r.mode } : {}) };
		if (!r.cc.length) delete next.cc;
		d.draft = next;
		n.text = rewriteDraftTo(n.text, r.to, r.cc);
		n.updated = at;
	}
	announce(hit, at);
	return hit.length;
}
