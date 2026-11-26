// What follows a mail draft that went out, in one place: the draft's status, the mailbox's 답장함 mark, the sent mail's record (text and files), the app's
// 이어서 할 일, and the mail leaving 답장 필요 on every screen. Two paths end here and either may come first, or both:
// the reply CLI's report right after a send it saw succeed (POST /api/followup), and the send queue's `sent` hook, which also fires for a send that ended
// 확인 필요 and was found sent later (the owner's 나갔어요, a boot's look, a proof). Every step leaves its mark (the draft's status, the mail's reply state,
// the draft's `after` list, the follow-up's fired list), so a second call does nothing twice. What the owner's edit teaches is learned by the same queue's
// `learn` hook right after (hub/approval-send.ts learnFrom, marked by the draft's `editLearned`), or by the CLI itself when no gateway ran it.
import { stagedFiles } from "../features/reply-drafts/lib/staged.ts";
import { log } from "./config.ts";
import { broadcast } from "./events.ts";
import { mailInstance, triggerFollowup, type FollowupResult } from "./followup.ts";
import { mailKey, mailTarget, recordSentByDotz, setMailReply } from "./mail.ts";
import { claimAfter, getDraft, setStatus } from "./reply-mail.ts";
import type { DraftRec } from "../features/reply-drafts/lib/store.ts";

const running = new Set<Promise<unknown>>();
/** Settles once every afterSent this process started has finished its steps. */
export const afterSentSettled = async (): Promise<void> => void (await Promise.all([...running]));

/** Mail draft `draft` went out. Never throws: a step that fails is logged and the next one still runs. Resolves with what the follow-up did (`none`: no rule or a new mail; `duplicate`: an earlier call did it). */
export function afterSent(draft: DraftRec): Promise<FollowupResult> {
	const done = steps(draft);
	const tracked = done.finally(() => void running.delete(tracked));
	running.add(tracked);
	return done;
}

async function steps(draft: DraftRec): Promise<FollowupResult> {
	const { id } = draft, rec = getDraft(id) ?? draft;
	let followup: FollowupResult = "duplicate";
	const step = async (what: string, run: () => unknown): Promise<void> => {
		try {
			await run();
		} catch (e) {
			log(`sent draft ${id}: ${what} failed: ${(e as Error).message}`);
		}
	};
	if (rec.status === "pending") await step("status", () => setStatus(id, "sent"));
	// A new mail he wrote answers none: its row is already the sent mail's row.
	if (!rec.compose) await step("reply mark", () => void setMailReply(rec.ref, "sent"));
	if (claimAfter(id, "recorded")) await step("sent mail record", () => recordSentByDotz({ id, source: rec.source, to: rec.to, cc: rec.cc, subject: rec.subject, body: rec.body, files: stagedFiles(id) }, rec.compose ? { compose: mailKey(rec.source, `compose-${id.toLowerCase()}`) } : { answers: rec.ref }));
	// A draft a follow-up made never starts another one.
	if (rec.compose) followup = "none";
	else if (claimAfter(id, "followup")) await step("follow-up", () => void (followup = triggerFollowup({ app: mailInstance(rec.ref), kind: "mail", key: id, ids: { draft: id, mail: rec.ref } })));
	if (!rec.compose && claimAfter(id, "closed")) broadcast({ kind: "mail_unreplied", target: mailTarget(rec.ref) });
	return followup;
}
