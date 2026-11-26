// The shapes of a stored notice and its decision. A part of the notice store split out of hub/notices.ts, code unchanged.
import type { DecisionOption } from "./choices.ts";
import type { DraftApproval } from "./draft-approval.ts";
import type { WatchItem } from "./watchitem.ts";
import type { ResultFile, ResultLink } from "./result-refs.ts";
import type { NoticeKindName } from "./notice-kinds.ts";
import { say } from "./notices-read.ts";

// The web notification store: every worklog / alert / session result / watch / schedule post, kept in notices.json so the
// bell survives a restart. Fed by what the hub already emits (onEmit), so main.ts only wires the API and the resolver.
export type NoticeKind = "result" | "alert" | "worklog" | "watch" | "decision" | "message";
export type NoticeTone = "done" | "run" | "wait" | "ask" | "fail" | "";
export type Notice = {
	id: string;
	ts: string;
	updated: string;
	kind: NoticeKind;
	tone: NoticeTone;
	title: string;
	text: string;
	// The conversation to open on tap: "main", "lane:<name>" or "ch:<id>".
	open: string;
	// The source message: the conversation it lives in ("main", "lane:<name>", "ch:<id>") and its event ts, which the web finds
	// on the rendered message (data-ts). Older items have neither: the web falls back to open + updated.
	src?: string;
	at?: string;
	// The conversation holding the `at` message when it is not `src`: a session's line posted to 작업내역 belongs to the session (src) but lives there.
	msg?: string;
	key?: string;
	// kind "worklog": what the post is and its state (hub/worklog-kind.ts); the web draws its row from them.
	wk?: string;
	wst?: string;
	// Who raised it: "orchestrator", "lane:<name>" or "gateway" (older items have none: originOf falls back to the decision target / lane key).
	by?: string;
	// The owner message (or earlier post) the asking post replied to: what lets a later [done] to that same request tell it is about the same matter.
	ref?: string;
	/** A gateway card that proposes an edit, answered by the owner with its change option: when that answer came (its event ts) and the edit the card showed then. The orchestrator's first card in the card's conversation after `at` is its confirm card (hub/card-answer.ts). Kept on the notice, so a re-ask of the card leaves it. */
	confirm_ask?: { at: string; edit?: CardEdit };
	/** The orchestrator's confirm card of the gateway card `id` (see `confirm_ask`), with the edit that card showed when it was answered: Apply here is checked against that line. */
	confirms?: { id: string; edit?: CardEdit };
	// kind "watch": the key of the app integration (hub/integrations.ts) the report belongs to. It stays in that app's view and out of 감시 소식.
	app?: string;
	// kind "watch": the watch's own name, so a report of a watch an app owns (a login keeper, a sync) is stamped with that app whatever its words say.
	watch?: string;
	// kind "watch": the app item the check pointed at (a `DOTZ_ITEM <app>:<id>` line) with the card to draw for it. A report that names an item stays in 감시 소식 whatever its words say.
	item?: WatchItem;
	read: boolean;
	// The results its report names (hub/result-refs.ts): files, commits and links the row shows as chips.
	files?: ResultFile[];
	links?: ResultLink[];
	// Swiped away / x in the bell: kept (so a session's next progress line does not bring it back) but never listed or counted.
	dismissed?: boolean;
	/** The owner's x on a question (ignoreNotice): off the badge and 답변 필요 but kept in the history, marked as ignored; undoable. Its asker hears it with its next prompt, no turn of its own. The value is when it was ignored. */
	ignored?: string;
	// A failure or lost login waits on the owner until this is a time (✕ on it, a rerun that passed, the login back); null = waiting. Absent on a notice stored before it:
	// unread = waiting, read = a past notice (reading an unread one sets null). Never migrated in the file.
	handled?: string | null;
	// Earlier occurrences folded into this row, newest first: a repeated alert it overwrote, a monitor's earlier report within a day (REPEATS_MAX, REPEAT_TEXT).
	repeats?: { at: string; text: string }[];
	// kind "decision": a question that waits on the owner (title = the decision line, text = the whole asking message).
	decision?: Decision;
	nk?: NoticeKindName;
};

// `say` is the text sent when the button is chosen (default "<n>) <label>"); `action` marks a login request's button (approve / cancel /
// form = the page's own input form, never answered through the hub).
export type DecisionOpt = DecisionOption & { say?: string; action?: string; keep?: true };
/** The exact edit of one line a gateway card proposes (the doctor's `Finding.change`): the absolute file, its line number, the line as it was and what it becomes ("" deletes it). */
export type CardEdit = { file: string; line: number; from: string; to: string };
/** A held answer: the label given, when it goes out (`until`, gateway clock), the time left when the item was read, the option number and text typed with
 * it; `failed` once its delivery after the window failed, with the reason the delivery gave (the card is open again). */
export type HeldAnswer = { label: string; until: number; left: number; n?: number; note?: string } & ({ state: "held" } | { state: "failed"; code: string; error: string });
/** What a card is (hub/notices-decisions.ts cardKindOf): a plain choice, a send approval, a card asking for values, a login request, a schedule run's card, the gateway's own alert. */
export type CardKind = "choice" | "send" | "values" | "auth" | "run" | "alert";
export type Decision = {
	options: DecisionOpt[];
	/** Set once as the card opens; absent on a card stored before the field (cardKind then reads it from the card). */
	kind?: CardKind;
	/** The card's own evidence lines (the lines between its `결정:` head and its first option, hub/choices.ts parseDecisions), absent when it has none. The notice's text then starts with them, followed by the message's lead; the sheet shows them under the title. */
	evidence?: string[];
	/** The id a gateway post gave this card (its event's `card_ids`, hub/notices-decisions.ts decisionsOf): the card is then found by that id alone, never by its title. Absent on every other card. */
	card_id?: string;
	/** The edit this gateway card proposes, kept with the card for as long as it can be answered (its event's `card_meta`); absent on every other card. */
	edit?: CardEdit;
	// Where the answer goes: "main", "lane:<name>", "ch:<id>" (a project chat) or "auth:<request id>".
	to: string;
	// The asking message (its event ts): the answer is sent as a reply to it.
	reply_to?: string;
	// How many decisions the asking message held; with more than one the answer names its decision.
	group: number;
	/** The card's place among the decisions of its asking message, from 0 in the order the message lists them (hub/notices-decisions.ts decisionsOf). Absent on a card stored before the field. */
	place?: number;
	/** An answer the gateway holds for its undo window (hub/notices-answers.ts holdDecision), never saved to disk: see HeldAnswer. */
	hold?: HeldAnswer;
	asked?: { n: number; first: string };
	// "ignored": the owner waved it off with the x (Notice.ignored); the matter was not answered.
	state: "open" | "answered" | "ignored";
	// True when no answer came but the matter was resolved by other means (resolveAsks): the bot finished it, the owner acted outside the app.
	resolved?: boolean;
	// When the question stops waiting on the owner (ANSWER_WINDOW_MS / ALERT_ANSWER_WINDOW_MS): set when it opens or re-opens. Absent on a
	// send-approval card and a login request, whose own state closes them.
	expires_at?: string;
	// The question's time was up (settleExpiredQuestions): closed as resolved, with no answer. The web shows it as 기한 지남.
	expired?: true;
	answer?: string;
	answered_at?: string;
	// A draft waiting for send approval (hub/draft-approval.ts): the sheet shows it above the options.
	draft?: DraftApproval;
	// The options are the gateway's defaults for a question without a choice block (ask-options.ts): buttons for the owner, but the matter still
	// ends like a plain question (the resolving signals may close it).
	assumed?: true;
	// An approved draft the gateway sends itself (hub/approval-send.ts): how that send went, shown on the answered card.
	send?: { state: "undo" | "queued" | "sending" | "sent" | "failed" | "unsure" | "back"; text?: string; at: string; /** `undo`: when the cancel window ends (ms). */ until?: number; /** Which try this is, set when a failed send was queued again (absent = the first). */ attempts?: number };
	// Where the card went on Discord (outbound.ts markDraftPosted, markCardsPosted): kept so the message is closed when the card is, also after a restart.
	// `shows`: the digest of the card text that message was last posted or edited with (notices-drafts.ts markCardShown); a pick there counts only while it is this card's.
	card?: { target: string; ids: string[]; shows?: string };
	// The approvalHash (hub/approval-send.ts) of the draft version this card shows, set whenever it is drawn: a pick from the card carries it, so a
	// card drawn before a change is refused `changed` instead of sending a version it never showed. Absent: not known, so a send pick from it is refused too.
	hash?: string;
	/** The owner asked for more detail (POST /api/notices/<id>/more): the card stays open; reset when the card is asked again. */
	more_at?: string;
	/** The owner chose 나중에 (POST /api/notices/<id>/later): off the open lists, read, and not pushed until this time; then it reopens once with one push. */
	later_until?: string;
	/** How a card closed when no button answered it: `words` (the owner's message, `words`, judged its answer), `expired`, `gone` (its session ended), `done` (its work ended). */
	closed_how?: "words" | "expired" | "gone" | "done";
	/** With `closed_how: "words"`: the owner's message that answered it, trimmed to 80 characters. */
	words?: string;
	/** An owner message (its event ts, text up to 80 characters) went to the model with this card listed as an open question; cleared by `closed_how: "words"` or `kept_open`. */
	judging?: { at: string; text: string };
	/** The model judged that owner message (`at`, the `judging` ts) not to be this card's answer, or its turn ended without saying. */
	kept_open?: { at: string };
	/** The half-time reminder of `expires_at` was pushed (once). */
	half_told?: true;
	/** The one line the asking session or the orchestrator still has to hear about this card, sent with its next prompt (hub/notices-later.ts takeAskerNotes); never shown. */
	tell?: string;
};
/** How settleDecision closes a card no button answered (Decision.closed_how); `words` carries the owner's message. */
export type Closing = { how: "words"; words: string } | { how: "expired" | "gone" | "done" };
/** An owner message as the gateway knows it: its event ts and text. */
export type OwnerSaid = { ts: string; text: string };
