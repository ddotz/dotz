// Comment replies, shared by every comment source (YouTube, Instagram, later a website): the watch of a source prints one line per new
// comment; with the source switched on (settings.ts apps.<app>) each line becomes a ready approval [ask] with a pending reply
// behind it, so no orchestrator drafting turn is needed. A source plugs in with a CommentAdapter; this file knows no platform.
// Nothing is posted here: the adapter only stages a pending reply, and the source's own approve command checks the user's pick.
import { draftApprovalBlock } from "../../../hub/draft-approval.ts";
import { precheck, reviseReply, type ReplyItem } from "../../../hub/reply-draft.ts";
import { askWith, buildDraft, type FlowDeps, refineAfterCorrection, replyCall, toneKey } from "./flow.ts";
import { learnFirst } from "./persona.ts";
import { appOn, ensureSwitch, loadSettings, loadStyle, recordCorrection } from "./settings.ts";
import { addDraft, getDraft, isDrafted, markDrafted, setStatus } from "./store.ts";

export type CommentInput = { id: string; author: string; text: string; context: string; post?: string };

export type CommentAdapter = {
	app: string; // settings key and tone profile: youtube, instagram, blog, ...
	postLabel?: string; // what a post of this source is called (영상, 게시물); the ask names the post by its title under this word
	label: string; // the source in the owner's words; it is in the ask, which is how 모니터링 files it under its app
	parse: (line: string) => CommentInput | undefined; // a watch line of this source, else undefined (left untouched)
	stage: (c: CommentInput, reply: string) => Promise<string>; // makes the pending reply (never posts it); returns its id
	discard: (id: string) => Promise<void>; // rejects a pending reply
	ownTexts?: () => Promise<string[]>; // the user's own past replies on this source, for the first identity sweep (persona.ts)
};

const keyOf = (a: CommentAdapter, id: string) => `comment:${a.app}:${id}`;
const itemOf = (a: CommentAdapter, c: CommentInput): ReplyItem => ({ kind: "comment", app: a.app, from: c.author, text: c.text, context: c.context });
const one = (s: string) => s.replace(/\s+/g, " ").trim();

export function commentAsk(a: CommentAdapter, c: CommentInput, reply: string, ref: string, notes: string[], headline = `${a.label} 댓글 답글 초안을 만들었어요`, open: string[] = []): string {
	const note = notes.map(one).join(" / ");
	const block = draftApprovalBlock({ to: `${c.author} 댓글`, toLabel: "대상", body: reply, ref, question: askWith("이 답글 올릴까요?", open), sendResult: "이 글을 답글로 올려요" });
	const post = c.post ? [`> ${a.postLabel ?? "글"} ${one(c.post)}`] : [];
	return [`[ask] ${headline}`, ...(note ? [`-# ${note}`] : []), ...post, `> 원댓글 ${one(c.author)}: ${one(c.text)}`, block].join("\n");
}

export type CommentDeps = FlowDeps & { budgetMs?: number };

// The lines of one watch run in, the lines to post out. An app that is off passes every line through unchanged; so does any line this
// run could not handle (parse miss, model failure, time budget), and the orchestrator drafts it as before. A comment id is drafted once.
export async function draftComments(a: CommentAdapter, lines: string[], deps: CommentDeps = {}): Promise<string[]> {
	const settings = loadSettings();
	if (!appOn(settings, a.app)) return lines;
	const started = Date.now();
	if (deps.analyze && a.ownTexts && lines.some(l => a.parse(l)))
		await learnFirst({ app: a.app }, a.ownTexts, `${a.label} 댓글 답글`, deps.analyze).catch(e => console.error(`reply draft: ${a.app} identity not learned: ${(e as Error).message}`));
	const out: string[] = [];
	for (const line of lines) {
		const c = a.parse(line);
		if (!c) {
			out.push(line);
			continue;
		}
		const key = keyOf(a, c.id);
		if (isDrafted(key)) continue;
		if (Date.now() - started > (deps.budgetMs ?? 90_000)) {
			out.push(line);
			continue;
		}
		try {
			const item = itemOf(a, c);
			if (precheck(item, settings.senders)) {
				markDrafted(key);
				continue;
			}
			const built = await buildDraft(item, { source: a.app, mailId: c.id, ref: key }, deps);
			if (built.action !== "draft") {
				markDrafted(key);
				continue;
			}
			const id = await a.stage(c, built.rec.body);
			addDraft({ ...built.rec, id });
			ensureSwitch();
			out.push(commentAsk(a, c, built.rec.body, id, built.warnings.map(w => `확인: ${w}`), undefined, built.rec.questions));
		} catch (e) {
			console.error(`reply draft: ${a.app} comment ${c.id} not drafted: ${(e as Error).message}`);
			out.push(line);
		}
	}
	return out;
}

export type ReviseStep = { ok: boolean; text: string };

// 2) 고치기 of a pending comment reply: the change goes verbatim into that app's tone profile, the reply is rewritten, the new pending
// reply gets its own id and ask, and the old one is discarded.
export async function reviseComment(a: CommentAdapter, id: string, change: string, deps: FlowDeps = {}): Promise<ReviseStep> {
	const old = getDraft(id);
	if (!old || old.app !== a.app || old.kind !== "comment") return { ok: false, text: `답글 초안 ${id}을(를) 찾지 못했어요` };
	if (old.status !== "pending") return { ok: false, text: `답글 초안 ${id}은(는) 이미 ${old.status} 상태라 고칠 수 없어요` };
	if (!change.trim()) return { ok: false, text: "무엇을 고칠지 적어 주세요 (--change)" };
	const now = (deps.now ?? (() => new Date()))();
	recordCorrection(toneKey(old), change, now);
	await refineAfterCorrection(toneKey(old), deps);
	const call = deps.call ?? replyCall(a.app);
	const r = await reviseReply(old.item, loadStyle(toneKey(old)), { to: old.to, body: old.body }, change, call);
	if (r.action === "skip") return { ok: false, text: `고친 답글을 만들지 못했어요: ${r.reason}` };
	const c: CommentInput = { id: old.mailId, author: old.item.from, text: old.item.text, context: old.item.context ?? "" };
	const next = await a.stage(c, r.draft.body);
	setStatus(id, "stale");
	addDraft({ ...old, id: next, to: r.draft.to, body: r.draft.body, status: "pending", created: now.toISOString(), changes: [...old.changes, change], questions: r.questions });
	await a.discard(id);
	return { ok: true, text: commentAsk(a, c, r.draft.body, next, r.warnings.map(w => `확인: ${w}`), `${a.label} 댓글 답글 초안을 고쳤어요`, r.questions) };
}
