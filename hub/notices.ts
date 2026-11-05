// The web notification store (facade): the importers keep `./notices.ts`; the code lives in the notices-*.ts files, and the three import-time hooks
// below stay in this order (listen for broadcasts, listen for events, then reconcile what was stored) after every module is loaded.
import { onBroadcast, onEmit } from "./events.ts";
import { feed, reconcileStored } from "./notices-store.ts";
import { DRAFT_CHANGED, settleSoon } from "./notices-drafts.ts";
export type { NoticeKind, NoticeTone, Notice, DecisionOpt, Decision } from "./notices-types.ts";
export { setLaneTitleResolver, setWatchLabelResolver, setAppResolver, setAppBlocker, setWatchSummarizer, setOrchestratorAvailable, onNoticeUnread, setConvNameResolver, onDecision, onDecisionClosed, setDraftHandled, setAppLabelResolver } from "./notices-wiring.ts";
export type { ClosedCard } from "./notices-wiring.ts";
export { NOTICE_CAP, WATCH_KEEP, WATCH_DAYS, keepWatchNewest, needsAnswer, ANSWER_WINDOW_MS, ALERT_ANSWER_WINDOW_MS, BACKFILL_DAYS } from "./notices-rules.ts";
export type { Waits } from "./notices-rules.ts";
export { laneNameKo, conversationTitle } from "./notices-lanes.ts";
export { summary } from "./notices-read.ts";
export { isViewing } from "./notices-viewing.ts";
export { decisionsOf } from "./notices-decisions.ts";
export { unreadCount, answerReply, orchestratorTurnStarted, backfillNotices, readConversationNotices, markNoticesRead, resetNoticesForTest } from "./notices-store.ts";
export { refreshNoticeDrafts, tagStoredApps } from "./notices-stored.ts";
export { refreshDraftFiles, syncDraftFiles, markDraftPosted, openDraftRefs, openDraftCards, markDraftSend, rewriteOpenDraft, settleHandledDrafts, draftCardCounts, refreshStoredDrafts, confirmNoun, confirmGroup, reopenDraftNotices, updateDraftRecipients } from "./notices-drafts.ts";
export { settleExpiredQuestions, settleOpenDecision, answerDecision, authRequested, authSettled, orchestratorAnswered, resolveNotices, ignoreNotice, unignoreNotice, reopenNotices } from "./notices-answers.ts";
export type { DecisionSend } from "./notices-answers.ts";
export { laneVerified, UPDATE_NOTICE_KEY, updateAvailable, accountUsedChanged, updateResolved } from "./notices-signals.ts";
export { laneHasOpenCard, setViewing, dropLaneNotices, dropChannelNotices, countChannelNotices, listNotices, allNotices, dismissedAlertAts, dismissNotice, handledNotice, undismissNotice } from "./notices-bell.ts";

onBroadcast(e => {
	if (DRAFT_CHANGED.has(String(e.kind))) settleSoon();
});

onEmit(feed);

reconcileStored();
