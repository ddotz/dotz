// What main.ts plugs into the store (resolvers, switches, hooks) and the app stamp that reads them. A part of the notice store split out of hub/notices.ts, code unchanged.
import type { Decision, Notice, NoticeKind } from "./notices-types.ts";

// The Korean title of a session (never its code name); main.ts passes lanes.get(name)?.title.
export let laneTitleOf: (name: string) => string | undefined = () => undefined;
export const setLaneTitleResolver = (fn: (name: string) => string | undefined) => void (laneTitleOf = fn);

// Watch names are keys ([a-z0-9-]); the owner reads the label. And a watch event routed to the orchestrator makes no notice while the
// orchestrator can take it (the orchestrator reports in that channel itself); main.ts wires both.
export let watchLabelOf: (name: string) => string = name => name;
export let orchestratorUp: () => boolean = () => true;
export const setWatchLabelResolver = (fn: (name: string) => string) => void (watchLabelOf = fn);
export let appOf: (n: Notice) => string | undefined = () => undefined;
export const setAppResolver = (fn: (n: Notice) => string | undefined) => void (appOf = fn);
// A notice of an app the owner switched off on this install (hub/app-off.ts): not kept when new, not listed and not counted when old.
export let appBlocked: (n: { kind?: NoticeKind; app?: string; watch?: string; src?: string; open?: string }) => boolean = () => false;
export const setAppBlocker = (fn: typeof appBlocked) => void (appBlocked = fn);
export function stampApp(n: Notice): boolean {
	const app = n.item ? undefined : appOf(n);
	if (app === n.app) return false;
	if (app) n.app = app;
	else delete n.app;
	return true;
}
// One small-model sentence for a change the rules could not put in words (hub/watchsummary.ts); unset = rules only. The notice shows the rules' text
// (the raw output folded) at once and the sentence replaces it when it arrives.
export let summarizeWatch: ((output: string) => Promise<string | undefined>) | undefined;
export const setWatchSummarizer = (fn: typeof summarizeWatch) => void (summarizeWatch = fn);
export const setOrchestratorAvailable = (fn: () => boolean) => void (orchestratorUp = fn);
// A notice that just became unread (new, or a read one reopened): the phone notification for it (hub/push.ts noticePush). Decisions have onDecision.
export const unreadHooks: Array<(n: Notice) => void> = [];
export const onNoticeUnread = (fn: (n: Notice) => void): void => void unreadHooks.push(fn);

export let convNameOf: (conv: string) => string | undefined = () => undefined;
export const setConvNameResolver = (fn: (conv: string) => string | undefined) => void (convNameOf = fn);
export const decisionHooks: Array<(n: Notice) => void> = [];
// Called once for every new (or re-asked) open decision, never while the old history is replayed.
export const onDecision = (fn: (n: Notice) => void): void => void decisionHooks.push(fn);

// The send-approval queue of a conversation (hub/approval-queue.ts) reads which draft cards are open there and hears when a decision closes
// (answered, resolved, ignored), so it can show the next held card.
// `card`: of a send-approval card, what closes its Discord message (text, how it ended, and where it was posted when known).
export type ClosedCard = { text: string; how: "answered" | "resolved" | "ignored"; label: string; target?: string; ids?: string[] };
export const closedHooks: Array<(to: string, ref: string | undefined, card?: ClosedCard) => void> = [];
export const onDecisionClosed = (fn: (to: string, ref: string | undefined, card?: ClosedCard) => void): void => void closedHooks.push(fn);
// Signal 5: the item behind a send approval was handled without the notice hearing of it. An open draft decision is the owner's to pick, yet the draft
// itself can be over: sent from the app or by the owner's own client, dropped, replaced by a revision, marked 답장 안 함, answered on the platform,
// deleted at the source, or handled on another computer. The apps know it (hub/draft-handled.ts); this settles the notice as resolved.
// A message asking about several drafts at once has one notice per draft without `draft`: its block title still names the ref (blockDraftRef).
export let draftHandled: (d: Decision, n: Notice, ref: string) => Promise<boolean> | boolean = () => false;
export const setDraftHandled = (fn: typeof draftHandled) => void (draftHandled = fn);
// The send approvals of one monitoring app instance are shown, and pushed, as one group ("메일 답장 확인 3건"): the app instance key, its name and the open count.
export let appLabelOf: (key: string) => string = key => key;
export const setAppLabelResolver = (fn: typeof appLabelOf) => void (appLabelOf = fn);
