// The shared types of the one reply flow (docs: the reply unification design, sections 1.5, 1.7 and 1.9): kinds, the send state, the
// adapter every channel implements and the item every surface reads. Types only, no runtime code: every reply module imports from here,
// and this file imports only types (so it adds no edge to the import graph).
import type { SendJob } from "./approval-send.ts";

/** Why a send or an action did not go through. Every code has a class, a Korean and an English text and an auto policy in hub/reply-reasons.ts. */
export type ReasonCode =
	// surely not sent
	| "login_expired" | "offline" | "rate_limited" | "quota" | "rejected" | "recipient_invalid" | "recipient_not_on_mail" | "recipient_self" | "recipient_missing"
	| "subject_re" | "placeholder" | "forbidden_word" | "wording_rule" | "too_long" | "empty" | "attach_mismatch" | "attach_missing" | "attach_upload" | "file_pending" | "cannot_attach"
	| "account_needed" | "webmail_recipients" | "manual_only" | "mail_gone" | "mail_claim_unsent" | "stale" | "gone" | "original_gone" | "app_off" | "lease_held" | "lease_unknown"
	| "app_not_ready" | "input_busy" | "room_unknown" | "not_approved" | "changed" | "tool_before_send" | "config"
	// may have gone out
	| "net_cut" | "timeout" | "interrupted" | "server_error" | "press_unconfirmed" | "readback_mismatch" | "state_write" | "unknown"
	// not a send failure: an action was refused, or a revise failed
	| "already_sending" | "already_sent" | "not_pending" | "needs_resolve" | "revising" | "not_supported" | "owner_only" | "revise_failed" | "revise_limit";

/** `text` is plain Korean; raw tool output never leaves hub.log. */
export type Reason = { code: ReasonCode; text: string };
export type SentHow = "owner" | "rule" | "retry" | "auto" | "confirmed" | "proved";
/** `failed` always means surely not sent; `unsure` always means it may have gone out. There is no third bucket. */
export type SendState =
	| { state: "undo"; at: number; until: number }
	| { state: "queued"; at: number; attempt: number }
	| { state: "sending"; at: number; attempt: number }
	| { state: "sent"; at: number; how: SentHow; today?: boolean }
	| { state: "failed"; at: number; reason: Reason; safeToAuto: boolean; attempts: number; auto?: { attempt: number; max: number; nextAt: number } }
	| { state: "unsure"; at: number; reason: Reason; attempts: number };

export type ReplyKind = "mail" | "webmail" | "comment" | "kakao" | "card";
export type Part = "reply" | "mail";
/** What a revise teaches a tone profile: `line` the lasting preference ("" = none), `forbid` the wordings the owner banned, `evidence` the previous draft and the owner's change (the only texts a proposed wording pattern may quote, never the model-written line); `key.app` is `install` when it holds everywhere. */
export type Lesson = { key: { app: string; room?: string }; line: string; forbid?: string[]; evidence?: { draft: string; change: string } };
export type Done = { ok: true } | { ok: false; reason: Reason };

/** The buttons the server gives a send that needs the owner (hub/reply-reasons.ts policyOf), so no surface holds per-channel failure logic. */
/** A file a draft carries: `digest` is the content fingerprint of a file the store holds locally (staged files), so a same-named swap is a new version. */
export type FileShown = { name: string; size?: string; digest?: string };

export type OwnerAction = "retry" | "resolve_sent" | "resolve_retry" | "open_channel" | "relogin" | "fix_recipient" | "pick_file" | "pick_account" | "redraft" | "drop" | "send_as_is" | "send";

/** What every surface shows of one reply (GET /api/reply/queue, the `reply` event). */
export type ReplyItem = {
	item: string;
	ref: string;
	kind: ReplyKind;
	/** The app instance, for the head chip and the filter. */
	app: string;
	label: string;
	conv: string;
	notice?: string;
	at: number;
	/** sends: the ways 보내기 can go when a mail rides along (POST /api/reply/act send with part "reply" / "mail"); absent: one 보내기. */
	can: { send: boolean; revise: boolean; edit: boolean; drop: boolean; restore: boolean; sends?: ("send" | "send-main" | "send-mail")[] };
	draft: {
		state: "pending" | "dropped" | "stale" | "sent" | "closed";
		toLabel: string;
		to: string;
		cc?: string[];
		account?: string;
		accountHeld?: true;
		subject?: string;
		text: string;
		parts?: string[];
		sentParts?: number;
		mail?: { ref: string; to: string; account?: string; accountHeld?: true; subject?: string; text: string; attachments?: FileShown[] };
		attachments?: FileShown[];
		notes?: string[];
		decide?: string[];
		model?: string;
		rule?: string;
		replaces?: { ref: string; text: string };
		edited?: true;
		revising?: true;
		/** The approvalHash of this version (hub/approval-send.ts): a send act carries it back, and a different one is refused `changed`. */
		hash?: string;
	};
	original?: { who: string; text: string; at?: number; subject?: string; post?: string; cut?: true };
	/** Absent: it waits for the owner. */
	send?: SendState & { actions: OwnerAction[] };
	back?: { at: number; cause: "restart" };
	/** CM-13: the same person was already answered the other way (a comment reply posted to a mail's sender, or a mail reply sent to a commenter), and when, if known. Shown only; no part of the approvalHash. */
	answeredElsewhere?: { via: "comment" | "mail"; at?: number };
	/** One plain line for the tag: a failure reason, or why a rule did not send it. */
	why?: string;
};
/** What an adapter knows of a draft: the item without the send, which the ledger adds. `sent`: when and how it went out, read from the store
 * (the ledger's record is in memory only); it shows as the item's send when the ledger has none, and is no part of its approvalHash. */
export type DraftView = Omit<ReplyItem, "send" | "back"> & {
	sent?: { at: number; how: SentHow };
	mailLeft?: true;
};

/** How one send ended, said by the place that knows (an in-process runner, or a CLI's `DOTZ_SEND` line). `detail`: the place's own answer (masked,
 * bounded), for hub.log and the send queue's record only. */
export type SendOutcome =
	| { sent: "yes" }
	| { sent: "no"; code: ReasonCode; vars?: Record<string, string | number>; detail?: string }
	| { sent: "maybe"; code: ReasonCode; detail?: string }
	| { sent: "partial"; done: number; total: number; code: ReasonCode; rest: "no" | "maybe" };

export type ReplyAdapter = {
	kind: ReplyKind;
	/** The current view of `ref`, or undefined when this store does not know it. */
	get(ref: string): Promise<DraftView | undefined>;
	/** Every pending draft, plus the ones sent since local midnight. */
	list(): Promise<DraftView[]>;
	/** Where a send of it queues (one lane sends one at a time). */
	target(ref: string, part?: Part): { kind: "mail" | "comment" | "kakao"; lane: string } | undefined;
	/** In-process sender. Absent: the queue spawns the kind's CLI (hub/approval-send.ts sendArgv). */
	run?(job: SendJob): Promise<SendOutcome>;
	/** Model rewrite: stores the new draft with `replaces`, marks the old one stale. Records no learning itself. */
	revise(ref: string, change: string, part?: Part): Promise<{ ok: true; ref: string; replaces: string; lesson?: Lesson } | { ok: false; reason: Reason }>;
	/** The owner's text (and a mail's subject), saved as it is under the same ref. Refuses when the owner-text lint fails. */
	edit(ref: string, text: string, part?: Part, subject?: string): Promise<{ ok: true } | { ok: false; reason: Reason; lint?: string[] }>;
	drop(ref: string): Promise<Done>;
	restore(ref: string): Promise<Done>;
	/** The owner says it went out: closed as sent, nothing is sent. */
	markSent(ref: string): Promise<Done>;
	/** Proof read back from the channel for an unsure send. It can say "sent", never "not sent". */
	prove?(ref: string): Promise<"sent" | "unknown">;
	/** Code repair before an auto retry (a background re-login). */
	repair?(ref: string, code: ReasonCode): Promise<"fixed" | "needs_owner" | "failed">;
	/** The card text for a conversation or Discord, built from the store, never by patching an old card. */
	ask(ref: string, headline?: string): Promise<string | undefined>;
	/** "<question> (<ref>)": what a pick is recorded under. */
	question(ref: string): string;
};
