// Mail reconcile: a mail that still waits (답장 필요 / 초안 있음, or a reply draft still pending) is checked against its real thread, read-only
// through zele, and becomes 답장함 when the owner answered it from somewhere dotz does not watch (Gmail, another script, his phone). hub/mail.ts
// syncMailStates learns that only from dotz's own zele watch; an install whose mail arrives from another watcher never would.
//
// Idempotent and one-way: only mails that wait are read, a replied mail is never touched again (never un-reply), and the second run finds nothing
// new. The zele account is the mail's own (`MailRecord.account`); with no account recorded the install's single zele account is used, and with
// several accounts the mail is skipped and counted as not checked, never guessed. Everything outside (zele, the stores) is injected.
import type { MailRecord } from "./mail.ts";
import { isOwnAddress } from "./mail-state.ts";
import { parseThread, type ThreadMessage } from "./zele.ts";

export type ReconcileResult = { checked: number; replied: number; notChecked: number };
export type ReconcileMail = Pick<MailRecord, "key" | "source" | "id" | "at"> & Partial<Pick<MailRecord, "account" | "dir" | "reply">>;
export type ReconcileDeps = {
	mails: () => readonly ReconcileMail[];
	/** The mail keys that have a reply draft waiting (pending or held). */
	draftRefs: () => ReadonlySet<string>;
	/** The accounts zele holds (`zele whoami`). */
	accounts: () => Promise<string[]>;
	/** `zele mail read <thread> --account <account>`: the text of the thread. Read-only. */
	read: (threadId: string, account: string) => Promise<string>;
	/** The owner's addresses, given the zele accounts (hub/mail-state.ts ownAddresses). */
	own: (accounts: readonly string[]) => ReadonlySet<string>;
	/** The mail is 답장함 (hub/mail.ts setMailReply "sent"); true when the mail is known. */
	markReplied: (key: string, at: string) => boolean;
	/** Closes the mail's waiting reply drafts as answered (reply-drafts store answerDrafts); returns their ids. */
	answerDrafts: (key: string) => string[];
	now?: () => number;
};

// When each mail was last looked at (this process): the oldest-looked-at goes first, so a limit per round still reaches every waiting mail.
const lastLooked = new Map<string, number>();
export const resetReconcile = (): void => lastLooked.clear();

// The record's `at` can be later than the message it stands for (it is when dotz saw it), so a message a few minutes after `at` still counts as the incoming one.
const SLACK_MS = 5 * 60_000;
const waits = (r: ReconcileMail, drafts: ReadonlySet<string>) => r.reply === "needs" || r.reply === "draft" || drafts.has(r.key);

/**
 * The owner's answer in a thread, if any: the incoming message is the newest message that is not the owner's (and not newer than the record), and
 * an owner's message after it is the answer. Returns when it was sent (ISO) or "" when the date cannot be read; undefined = not answered.
 */
export function answerIn(messages: readonly ThreadMessage[], own: ReadonlySet<string>, at: string): string | undefined {
	const limit = Date.parse(at) + SLACK_MS;
	let incoming = -1;
	messages.forEach((m, i) => {
		const t = Date.parse(m.date);
		if (!isOwnAddress(m.from, own) && (Number.isNaN(t) || Number.isNaN(limit) || t <= limit)) incoming = i;
	});
	if (incoming < 0) return undefined;
	const reply = messages.slice(incoming + 1).find(m => isOwnAddress(m.from, own));
	if (!reply) return undefined;
	const t = Date.parse(reply.date);
	return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

/** One round: reads at most `limit` waiting mails (oldest looked-at first) and closes the ones the owner answered. */
export async function reconcileMails(deps: ReconcileDeps, opts: { limit: number }): Promise<ReconcileResult> {
	const now = deps.now ?? Date.now;
	const result: ReconcileResult = { checked: 0, replied: 0, notChecked: 0 };
	const drafts = deps.draftRefs();
	const all = deps.mails().filter(r => r.dir !== "out" && r.source === "zele");
	// A mail already 답장함 whose reply draft still waits (it was answered some other way): the draft is closed, no thread to read.
	for (const r of all) if (r.reply === "replied" && drafts.has(r.key)) deps.answerDrafts(r.key);
	const candidates = all
		.filter(r => r.reply !== "replied" && waits(r, drafts))
		.sort((a, b) => (lastLooked.get(a.key) ?? 0) - (lastLooked.get(b.key) ?? 0) || a.at.localeCompare(b.at))
		.slice(0, Math.max(0, opts.limit));
	if (!candidates.length) return result;

	const accounts = await deps.accounts().catch(() => [] as string[]);
	const own = deps.own(accounts);
	for (const r of candidates) {
		lastLooked.set(r.key, now());
		// The mail's own account; the install's only account when the record has none; several accounts and no record of which = not guessed.
		const account = r.account?.trim() || (accounts.length === 1 ? accounts[0] : undefined);
		if (!account || !own.size) {
			result.notChecked++;
			continue;
		}
		let messages: ThreadMessage[];
		try {
			messages = parseThread(await deps.read(r.id, account));
		} catch {
			result.notChecked++;
			continue;
		}
		result.checked++;
		const at = answerIn(messages, own, r.at);
		if (at === undefined) continue;
		if (deps.markReplied(r.key, at || new Date(now()).toISOString())) result.replied++;
		deps.answerDrafts(r.key);
	}
	return result;
}

/** The round on a timer and on demand: `tick` runs at most once per `everyMs` with `perRun` mails; `run` is the owner's own request. One round at a time. */
export function createReconciler(deps: ReconcileDeps, opts: { perRun: number; everyMs: number }) {
	let last = 0;
	let busy: Promise<ReconcileResult> | undefined;
	const run = (limit: number): Promise<ReconcileResult> => (busy ??= reconcileMails(deps, { limit }).finally(() => void (busy = undefined)));
	return {
		run,
		/** Undefined when it is not due yet or a round is running. */
		async tick(at: number = (deps.now ?? Date.now)()): Promise<ReconcileResult | undefined> {
			if (busy || at - last < opts.everyMs) return undefined;
			last = at;
			return run(opts.perRun);
		},
	};
}
