// 할일 (owner 2026-11-04): what was received but has not started, oldest first. Read from the gateway's own state, never through a model:
// workers OmO holds, sessions held by the machine limits (lane.waiting) and work deferred to the usage-limit reset (hub/limitwait.ts).
// /api/state carries the list, and the stream's `{ kind: "waitlist" }` says when it changed.
import type { BgWork } from "./bgwork.ts";
import type { limitWaits } from "./limitwait.ts";

export type WaitItem = { id: string; kind: "worker" | "session" | "limit"; title: string; since?: number; reason?: string; target?: string; next?: string; resume_at?: string };
type LaneLike = { name: string; title?: string; waiting?: string; live?: boolean; startedAt?: string };
type Sources = { deferred: ReturnType<typeof limitWaits>; lanes: LaneLike[]; work: BgWork[] };

const stamp = (s: string | undefined) => (s ? Date.parse(s) || undefined : undefined);

// A deferred item outlives its start when the session started by a path that did not clear it: a session running, or one that started
// after the deferral and ended since, has left this list, so finished work never reads as waiting.
const started = (lane: LaneLike | undefined, since: number | undefined) => !!lane && !lane.waiting && (!!lane.live || (since !== undefined && (stamp(lane.startedAt) ?? 0) > since));

export function buildWaitlist({ deferred, lanes, work }: Sources): WaitItem[] {
	const laneOf = (name: string | undefined) => lanes.find(l => l.name === name);
	const limit = deferred.flatMap((d): WaitItem[] => {
		const lane = laneOf(d.lane ?? d.id), since = stamp(d.since);
		if (started(lane, since)) return [];
		const item: WaitItem = { id: `limit:${d.id}`, kind: "limit", title: d.what, ...(since ? { since } : {}), ...(d.next ? { next: d.next } : {}), ...(d.resume_at ? { resume_at: d.resume_at } : {}) };
		return [lane ? { ...item, target: `lane:${lane.name}` } : item];
	});
	const named = new Set(limit.map(i => i.target));
	const sessions = lanes.filter(l => l.waiting && !named.has(`lane:${l.name}`)).map((l): WaitItem => {
		const since = stamp(l.startedAt);
		return { id: `lane:${l.name}`, kind: "session", title: l.title || l.name, ...(since ? { since } : {}), reason: l.waiting, target: `lane:${l.name}` };
	});
	const workers = work.filter(w => w.queued).map((w): WaitItem => ({ id: `work:${w.id}`, kind: "worker", title: w.description, since: w.started_at, ...(w.target ? { target: w.target } : {}) }));
	return [...limit, ...sessions, ...workers].sort((a, b) => (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER));
}

// Calls push with the list only when it changed.
export function waitlistSweep(read: () => WaitItem[], push: (items: WaitItem[]) => void): () => void {
	let last = "";
	return () => {
		const items = read(), sig = JSON.stringify(items);
		if (sig === last) return;
		last = sig;
		push(items);
	};
}
