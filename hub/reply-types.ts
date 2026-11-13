// The shared types of the one reply flow (docs: the reply unification design, sections 1.5, 1.7 and 1.9): kinds, the send state, the
// adapter every channel implements and the item every surface reads. Types only, no runtime code: every reply module imports from here,
// and this file imports only types (so it adds no edge to the import graph).
import type { SendJob } from "./approval-send.ts";

/** Why a send or an action did not go through. Every code has a class, a Korean and an English text and an auto policy in hub/reply-reasons.ts. */
export type ReasonCode =
	// surely not sent
	| "login_expired" | "offline" | "rate_limited" | "quota" | "rejected" | "recipient_invalid" | "recipient_not_on_mail" | "recipient_self" | "recipient_missing"
	| "subject_re" | "placeholder" | "forbidden_word" | "too_long" | "empty" | "attach_mismatch" | "attach_missing" | "attach_upload" | "file_pending" | "cannot_attach"
	| "account_needed" | "webmail_recipients" | "manual_only" | "mail_gone" | "stale" | "gone" | "original_gone" | "app_off" | "lease_held" | "lease_unknown"
	| "app_not_ready" | "input_busy" | "room_unknown" | "not_approved" | "tool_before_send" | "config"
	// may have gone out
	| "net_cut" | "timeout" | "interrupted" | "server_error" | "press_unconfirmed" | "readback_mismatch" | "state_write" | "unknown"
	// not a send failure: an action was refused, or a revise failed
	| "already_sending" | "already_sent" | "not_pending" | "needs_resolve" | "revising" | "not_supported" | "owner_only" | "revise_failed" | "revise_limit";

/** `text` is plain Korean; raw tool output never leaves hub.log. */
export type Reason = { code: ReasonCode; text: string };
export type SentHow = "owner" | "retry" | "auto" | "confirmed" | "proved";
/** `failed` always means surely not sent; `unsure` always means it may have gone out. There is no third bucket. */
export type SendState =
	| { state: "undo"; at: number; until: number }
	| { state: "queued"; at: number; attempt: number }
	| { state: "sending"; at: number; attempt: number }
	| { state: "sent"; at: number; how: SentHow }
	| { state: "failed"; at: number; reason: Reason; safeToAuto: boolean; attempts: number; auto?: { attempt: number; max: number; nextAt: number } }
	| { state: "unsure"; at: number; reason: Reason; attempts: number };

export type ReplyKind = "mail" | "webmail" | "comment" | "kakao" | "card";
export type Part = "reply" | "mail";
export type Lesson = { key: { app: string; room?: string }; line: string };
export type Done = { ok: true } | { ok: false; reason: Reason };

/** The buttons the server gives a send that needs the owner (hub/reply-reasons.ts policyOf), so no surface holds per-channel failure logic. */
export type OwnerAction = "retry" | "resolve_sent" | "resolve_retry" | "open_channel" | "relogin" | "fix_recipient" | "pick_file" | "pick_account" | "redraft" | "drop";

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
	can: { send: boolean; revise: boolean; edit: boolean; drop: boolean; restore: boolean };
	draft: {
		state: "pending" | "dropped" | "stale" | "sent" | "closed";
		toLabel: string;
		to: string;
		cc?: string[];
		subject?: string;
		text: string;
		parts?: string[];
		sentParts?: number;
		mail?: { ref: string; to: string; subject?: string; text: string };
		attachments?: { name: string; size?: string }[];
		notes?: string[];
		decide?: string[];
		model?: string;
		rule?: string;
		replaces?: { ref: string; text: string };
		edited?: true;
		revising?: true;
	};
	original?: { who: string; text: string; at?: number; subject?: string; post?: string; cut?: true };
	/** Absent: it waits for the owner. */
	send?: SendState & { actions: OwnerAction[] };
	/** One plain line for the tag: a failure reason, or why a rule did not send it. */
	why?: string;
};
/** What an adapter knows of a draft: the item without the send, which the ledger adds. */
export type DraftView = Omit<ReplyItem, "send">;

/** How one send ended, said by the place that knows (an in-process runner, or a CLI's `DOTZ_SEND` line). */
export type SendOutcome =
	| { sent: "yes" }
	| { sent: "no"; code: ReasonCode; vars?: Record<string, string | number> }
	| { sent: "maybe"; code: ReasonCode }
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
	/** The owner's text, saved as it is under the same ref. Refuses when the owner-text lint fails. */
	edit(ref: string, text: string, part?: Part): Promise<{ ok: true } | { ok: false; reason: Reason; lint?: string[] }>;
	drop(ref: string): Promise<Done>;
	restore(ref: string): Promise<Done>;
	/** The owner says it went out: closed as sent, nothing is sent. */
	markSent(ref: string): Promise<Done>;
	/** Proof read back from the channel for an unsure send. It can say "sent", never "not sent". */
	prove?(ref: string): Promise<"sent" | "unknown">;
	/** Code repair before an auto retry (a background re-login). */
	repair?(ref: string, code: ReasonCode): Promise<"fixed" | "needs_owner" | "failed">;
	/** After `sent`: what an edited draft teaches (before and after), or undefined. */
	learned?(ref: string): Promise<Lesson | undefined>;
	/** The card text for a conversation or Discord, built from the store, never by patching an old card. */
	ask(ref: string, headline?: string): Promise<string | undefined>;
	/** "<question> (<ref>)": what a pick is recorded under. */
	question(ref: string): string;
};
