// The owner's open requests, kept by the gateway so a compaction summary does not have to carry them (the model re-reads them from
// here, hub/recall-parts.ts renderOpenRequests). One file per session beside its pending.json, rewritten whenever the prompt queue
// saves. It reuses what the queue already knows: pending.json's open prompts (queued, being answered, deferred), the worker links
// (which worker a deferred request waits on) and the queue's own answered set; it adds only what they lose: a deferred request the
// queue stopped tracking after 3 hours, and the time of an interim answer.
//
// Open: the request is in the queue's open list, or it was deferred, left that list and nobody answered it (it stays, marked `lost`).
// Closed: its final answer was delivered (the queue's answered set), it left the queue within 3 hours (the owner cancelled it, or a turn
// took it), or a peer's handoff was handed back. A closed request leaves the file at once.
import { existsSync, readFileSync } from "node:fs";
import { ownerView } from "./gateway-added.ts";
import { sameConv } from "./promptburst.ts";
import { DEFER_MAX_AGE_MS, type OpenRequest, type Pending } from "./prompts-model.ts";
import { loadLedger, type LedgerEntry } from "./recall-parts.ts";

/** Entries kept in full; an older one loses its words (the id and time stay) rather than being dropped. */
export const LEDGER_FULL = 60;
export const LEDGER_MAX = 300;
const WORDS = 400;

type Deps = { isAnswered: (id: string) => boolean; write: (file: string, text: string) => void; log: (line: string) => void; now?: () => number };

export function createLedger(file: string, deps: Deps) {
	let entries: LedgerEntry[] = existsSync(file) ? loadLedger(file) : [];
	let written = existsSync(file) ? readFileSync(file, "utf8") : "";
	const now = deps.now ?? Date.now;
	const flush = () => {
		entries.sort((a, b) => a.at - b.at);
		// Bound: the oldest entries lose their words first; only past LEDGER_MAX does the oldest go, and that is logged.
		entries.forEach((e, i) => { if (i < entries.length - LEDGER_FULL) e.text = ""; });
		for (const e of entries.splice(0, Math.max(0, entries.length - LEDGER_MAX))) deps.log(`open-request ledger full: ${e.id} (${e.target}) dropped, still unanswered`);
		const text = `${JSON.stringify(entries)}\n`;
		if (text === written) return;
		written = text;
		deps.write(file, text);
	};
	/** The queue's open prompts as they are now (called from its persist hook), with the requests waiting on workers. */
	function sync(open: Pending[], waiting: OpenRequest[]): void {
		const live = new Map<string, LedgerEntry>();
		for (const p of open) {
			// A request is an owner message or a peer's handoff; a quiet check, a handed-back answer and a lane report are the gateway's own.
			const id = p.replyTo ?? (p.from ? `from:${p.at ?? 0}` : "");
			if (!id || !p.target || p.quiet || p.handback) continue;
			const before = entries.find(e => e.id === id);
			const workers = waiting.filter(w => w.target === p.target && w.replyTo === p.replyTo).flatMap(w => w.workers.map(x => x.id));
			live.set(id, {
				id, target: p.target, at: before?.at ?? p.at ?? now(),
				text: before?.text || (ownerView(p.text) || p.text).trim().slice(0, WORDS),
				state: p.deferred ? "deferred" : "queued",
				...(workers.length ? { workers } : {}),
				...(before?.interim ? { interim: before.interim } : {}),
			});
		}
		// Not in the queue's list any more: a deferred one nobody answered stays (the queue drops it after 3 h); the rest are closed.
		const kept = entries.filter(e => !live.has(e.id) && e.state === "deferred" && now() - e.at > DEFER_MAX_AGE_MS && !deps.isAnswered(e.id)).map((e): LedgerEntry => ({ ...e, lost: true }));
		entries = [...live.values(), ...kept];
		flush();
	}
	/** A turn wrote an interim note in this conversation (before its request is marked deferred): the requests open there carry the time. */
	function interim(target: string): void {
		for (const e of entries) if (sameConv(e.target, target)) e.interim = now();
		flush();
	}
	return { sync, interim, entries: () => entries.slice() };
}
