// The "백그라운드 작업" rows of every conversation (a deferral receipt: an outbox event with `worker`, outbound.ts systemNote) and the job
// each one names. The event never changes, so a row's state lives here: read from OmO's task store (it outlives the gateway), stamped
// on /api/history as `work` for what a load finds, and pushed over the stream (`{ kind: "work" }`) when a job changes. Only the jobs of
// open rows are read, one record each per sweep (OmO has no event for a worker's end, and a worker that dies writes nothing at all).
import type { BgWork } from "./bgwork.ts";

export type WorkRow = {
	id: string;
	/** gone: the task store no longer holds the job, so how it ended is unknown. */
	status: BgWork["status"] | "gone";
	cancelled?: boolean;
	/** When the record was created: a row older than this was written for a job that held the id before (the web says 중단됨). */
	created_at?: number;
	ended_at?: number;
	files?: BgWork["files"];
	result_at?: string;
	result_conv?: string;
	/** The gateway's clock when this was read: of two answers the page keeps the newer. */
	at: number;
};
export type FoundWork = { work: BgWork; raw: string; created: number };
type Deps = {
	/** The job's record; undefined when its id is in no store, null when no store can be read here (nothing can be said then). */
	find: (id: string) => FoundWork | undefined | null;
	answer: (w: { target?: string; reply_to?: string; ended_at?: number }) => { at: string; conv: string; exact: boolean } | undefined;
	replyOf: (id: string) => string | undefined;
	push: (items: WorkRow[], at: number) => void;
	now?: () => number;
};

// OmO's words for a worker that was stopped or cut off rather than failing by itself.
const STOPPED = new Set(["cancelled", "canceled", "interrupted", "aborted", "killed"]);
const ENDED_KEEP = 500;
// A finished job's result message is usually posted right after it; past this the row stays without a link.
const LINK_WAIT_MS = 10 * 60_000;
export const WORK_SWEEP_MS = 5_000;

const ended = (r: WorkRow) => r.status === "done" || r.status === "failed" || r.status === "gone";

export function createWorkRows(deps: Deps) {
	const now = deps.now ?? Date.now;
	// The rows still to follow, and the settled answers (an ended job does not change, and a page load asks for all of its rows).
	const open = new Map<string, { target?: string; replyTo?: string; last?: string }>();
	const settled = new Map<string, WorkRow>();
	const stoppedHere = new Set<string>();

	function settle(r: WorkRow): void {
		settled.set(r.id, r);
		if (settled.size > ENDED_KEEP) settled.delete(settled.keys().next().value!);
	}
	function row(id: string, target?: string, replyTo?: string): WorkRow | undefined {
		const t = now(), kept = settled.get(id);
		if (kept) return { ...kept, at: t };
		const found = deps.find(id);
		if (found === null) return undefined;
		if (!found) {
			const gone: WorkRow = { id, status: "gone", at: t };
			settle(gone);
			return gone;
		}
		const w = found.work, stopped = w.status !== "done" && (stoppedHere.has(id) || STOPPED.has(found.raw) || w.cancelled === true);
		const r: WorkRow = { id, status: stopped ? "failed" : w.status, created_at: found.created, at: t, ...(stopped ? { cancelled: true, ended_at: w.ended_at ?? t } : w.ended_at ? { ended_at: w.ended_at } : {}), ...(w.files?.length ? { files: w.files } : {}) };
		if (!ended(r)) return r;
		const link = stopped ? undefined : deps.answer({ target, reply_to: replyTo ?? deps.replyOf(id), ended_at: r.ended_at });
		if (link) Object.assign(r, { result_at: link.at, result_conv: link.conv });
		if (stopped || link?.exact || t - (r.ended_at ?? 0) > LINK_WAIT_MS) settle(r);
		return r;
	}
	const key = (r: WorkRow) => `${r.status}|${r.cancelled ? 1 : 0}|${r.result_at ?? ""}`;

	/** A row was written: follow its job (a job that takes over a used id starts over). */
	function seen(e: { system?: unknown; worker?: unknown; target?: unknown; reply_to?: unknown }): void {
		if (!e.system || typeof e.worker !== "string") return;
		settled.delete(e.worker);
		open.set(e.worker, { ...(typeof e.target === "string" ? { target: e.target } : {}), ...(typeof e.reply_to === "string" ? { replyTo: e.reply_to } : {}) });
	}
	/** The events of a load with each row's state on it. Reconciles what ended while the gateway was down; a job still going is followed. */
	function stamp<T extends { worker?: unknown; system?: unknown; target?: unknown; reply_to?: unknown }>(events: T[]): (T & { work?: WorkRow })[] {
		return events.map(e => {
			if (!e.system || typeof e.worker !== "string") return e;
			const work = row(e.worker, typeof e.target === "string" ? e.target : undefined, typeof e.reply_to === "string" ? e.reply_to : undefined);
			if (work && !settled.has(e.worker) && !open.has(e.worker)) seen(e);
			return work ? { ...e, work } : e;
		});
	}
	function sweep(): void {
		const changed: WorkRow[] = [];
		for (const [id, o] of open) {
			const r = row(id, o.target, o.replyTo);
			if (!r) continue;
			if (key(r) !== o.last) {
				o.last = key(r);
				changed.push(r);
			}
			if (settled.has(id)) open.delete(id);
		}
		if (changed.length) deps.push(changed, now());
	}
	/** The owner stopped it (중단): OmO's record may say running for a while yet. */
	function stopped(id: string): void {
		stoppedHere.add(id);
		settled.delete(id);
		if (stoppedHere.size > ENDED_KEEP) stoppedHere.delete(stoppedHere.values().next().value!);
		open.set(id, open.get(id) ?? {});
		sweep();
	}
	return { seen, stamp, sweep, stopped, row };
}
