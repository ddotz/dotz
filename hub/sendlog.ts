// Outgoing Discord messages that must not be lost (answers, lane reports, alerts). Each one is written to disk before
// the first attempt and removed only after Discord accepted every part, so a network outage retries with backoff and a
// restart sends what was left. Parts already accepted are skipped on retry, and every part carries a nonce Discord
// enforces, so a part whose response was lost is not posted twice. An answer counts as answered (onDelivered) only after
// the send succeeded.
import { existsSync, readFileSync } from "node:fs";

export type SendItem = { id: string; target: string; text: string; replyRef?: string; answers?: string; parts: number; at: number };
export type SendOpts = { nonce: string; skip: number; onPart: (index: number) => void };
export type SendResult = { delivered: boolean; reason?: string };

export type SendLedgerDeps = {
	file: string;
	send: (target: string, text: string, replyRef: string | undefined, opts: SendOpts) => Promise<SendResult>;
	/** True for errors worth retrying (network failures, 5xx); a 4xx is final. */
	retryable: (error: unknown) => boolean;
	/** Discord accepted every part; `answers` is the owner message this answered, if any. */
	onDelivered: (item: SendItem) => void;
	/** The item was dropped unsent (final error or too old). */
	onGiveUp: (item: SendItem, reason: string) => void;
	persist: (items: SendItem[]) => void;
	log: (line: string) => void;
	wait?: (ms: number) => Promise<void>;
	maxAgeMs?: number;
};

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const MAX_AGE_MS = 6 * 3600_000;

export function createSendLedger(deps: SendLedgerDeps) {
	const wait = deps.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
	const maxAge = deps.maxAgeMs ?? MAX_AGE_MS;
	const items: SendItem[] = [];
	// One chain per target keeps messages in order while an earlier one is retried.
	const chains = new Map<string, Promise<unknown>>();
	let seq = 0;

	const save = () => deps.persist(items.slice());
	const drop = (item: SendItem) => {
		const i = items.indexOf(item);
		if (i >= 0) items.splice(i, 1);
		save();
	};

	async function attempt(item: SendItem): Promise<SendResult> {
		for (let delay = FIRST_DELAY_MS; ; delay = Math.min(delay * 2, MAX_DELAY_MS)) {
			try {
				const r = await deps.send(item.target, item.text, item.replyRef, {
					nonce: item.id,
					skip: item.parts,
					onPart: index => {
						item.parts = index + 1;
						save();
					},
				});
				drop(item);
				if (r.delivered) deps.onDelivered(item);
				else deps.onGiveUp(item, r.reason ?? "not delivered");
				return r;
			} catch (error) {
				const old = Date.now() - item.at > maxAge;
				if (!deps.retryable(error) || old) {
					drop(item);
					const reason = old ? `still failing after ${Math.round(maxAge / 60_000)} min: ${error}` : String(error);
					deps.onGiveUp(item, reason);
					return { delivered: false, reason };
				}
				deps.log(`send to ${item.target} failed (${error}); retrying in ${delay / 1000}s`);
				await wait(delay);
			}
		}
	}

	function run(item: SendItem): Promise<SendResult> {
		const prev = chains.get(item.target) ?? Promise.resolve();
		const next = prev.then(() => attempt(item));
		const tail = next.catch(() => undefined);
		chains.set(item.target, tail);
		void tail.then(() => {
			if (chains.get(item.target) === tail) chains.delete(item.target);
		});
		return next;
	}

	/** Sends `text` to `target`, retrying until Discord accepts it; resolves once delivered or given up. */
	function submit(target: string, text: string, replyRef?: string, answers?: string): Promise<SendResult> {
		// Discord nonces are at most 25 chars; the part index is appended to this id.
		const id = `${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 8)}`;
		const item: SendItem = { id, target, text, parts: 0, at: Date.now(), ...(replyRef ? { replyRef } : {}), ...(answers ? { answers } : {}) };
		items.push(item);
		save();
		return run(item);
	}

	/** Sends what a previous process left unsent (read from the ledger file); returns how many. */
	function resume(): number {
		let left: SendItem[] = [];
		try {
			if (existsSync(deps.file)) left = JSON.parse(readFileSync(deps.file, "utf8"));
		} catch (error) {
			deps.log(`unsent ledger unreadable: ${error}`);
		}
		const fresh = left.filter(i => i && typeof i.id === "string" && !items.some(x => x.id === i.id));
		if (!fresh.length) return 0;
		items.push(...fresh);
		save();
		deps.log(`sending ${fresh.length} message(s) left unsent before the restart`);
		for (const item of fresh) void run(item);
		return fresh.length;
	}

	/** An answer to `replyTo` is still on its way (counts as answered for redelivery decisions). */
	const pending = (replyTo?: string) => !!replyTo && items.some(i => i.answers === replyTo);

	return { submit, resume, pending, items: () => items.slice() };
}
