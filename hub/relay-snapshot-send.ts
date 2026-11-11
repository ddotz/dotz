import { readFileSync } from "node:fs";
import { writeAtomic } from "./config.ts";
import type { SelfChatConfig } from "./jandi-selfchat.ts";
import { selfChatReady } from "./jandi-selfchat.ts";
import type { Monitor } from "./monitors.ts";
import type { Notice } from "./notices-types.ts";
import { encodeSnapshot, normalizeSnapshot, type Snapshot, snapshotChanged } from "./relay-snapshot.ts";

// The sending side of hub/relay-snapshot.ts: a computer reached only through the JANDI self chat (hub/jandi-peers.ts) posts a short summary of itself into
// that room when it changed (at most every 30 minutes, and once in 6 hours even when it did not), so the computer that reads the room can show it.
// Off unless the owner switched `share_status` on. buildSnapshot is pure; the sender takes everything else (config, clock, post, store) as arguments.

export const MIN_GAP_MS = 30 * 60_000;
export const HEARTBEAT_MS = 6 * 60 * 60_000;
export const TICK_MS = 2 * 60_000;
export const FIRST_TICK_MS = 30_000;

/** What the builder reads, already collected (the caller owns where it comes from). Only the fields named in buildSnapshot are ever copied. */
export type SnapshotSources = {
	projects: Array<{ key: string; name: string; note?: string; live?: number }>;
	/** laneSummary() rows (hub/laneviews.ts) with `lastReportAt` added. */
	sessions: Array<Record<string, unknown>>;
	monitors: Monitor[];
	todos: { open: number; items: string[] };
	notices: Array<Pick<Notice, "tone" | "title" | "updated"> & { at?: string }>;
};

// A link can carry a signed query, so a shown line keeps no address (cleanText already drops tokens, home paths and mail addresses).
const plain = (s: unknown): string | undefined => (typeof s === "string" ? s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "…") : undefined);
const text = (s: unknown): string | undefined => (typeof s === "string" && s ? s : undefined);

/** The raw snapshot of these sources; encodeSnapshot / normalizeSnapshot clean and cut it. No path, address, id of a channel or token field is copied. */
export function buildSnapshot(src: SnapshotSources, now: number): Snapshot {
	const live = (s: Record<string, unknown>) => s.live === true;
	const sessions = [...src.sessions].sort((a, b) => Number(live(b)) - Number(live(a)));
	return {
		v: 1,
		at: now,
		projects: src.projects.map(p => ({ key: p.key, name: p.name, ...(p.note ? { note: plain(p.note) } : {}), ...(p.live ? { live: p.live } : {}) })),
		sessions: sessions.map(s => ({
			name: String(s.name ?? ""),
			...(text(s.title) ? { title: plain(s.title) } : {}),
			status: String(s.status ?? ""),
			live: live(s),
			...(s.waiting ? { waiting: true } : {}),
			...(text(s.lastReportAt) ?? text(s.startedAt) ? { at: text(s.lastReportAt) ?? text(s.startedAt) } : {}),
		})),
		monitors: src.monitors.map(m => ({
			name: plain(m.name) ?? "",
			kind: m.kind,
			...(m.last_result ? { result: m.last_result } : {}),
			...(m.paused ? { paused: true } : {}),
			...(m.connection ? { conn: m.connection } : {}),
			...(m.last_run ? { last: m.last_run } : {}),
			...(m.next_run ? { next: m.next_run } : {}),
			...(m.last_summary ? { summary: plain(m.last_summary) } : {}),
		})),
		todos: { open: src.todos.open, items: src.todos.items.map(t => plain(t) ?? "") },
		notices: src.notices.map(n => ({ at: n.at ?? n.updated ?? "", tone: n.tone ?? "", title: plain(n.title) ?? "" })),
	};
}

type Sent = { sentAt: number; snap: Snapshot };
export type SnapshotStore = { load(): Sent | undefined; save(v: Sent): void };

/** The last sent snapshot and when, in one small file, so a restart does not post an unchanged one again. */
export function snapshotFileStore(file: string): SnapshotStore {
	return {
		load() {
			try {
				const v = JSON.parse(readFileSync(file, "utf8")) as { sentAt?: unknown; snap?: unknown };
				const snap = normalizeSnapshot(v.snap);
				return typeof v.sentAt === "number" && snap ? { sentAt: v.sentAt, snap } : undefined;
			} catch {
				return undefined;
			}
		},
		save: v => writeAtomic(file, `${JSON.stringify(v)}\n`, 0o600),
	};
}

export type SnapshotSenderDeps = {
	config: () => SelfChatConfig | undefined;
	/** The raw snapshot now, or undefined while there is nothing to read from yet. */
	build: () => Snapshot | undefined | Promise<Snapshot | undefined>;
	post: (text: string) => Promise<void>;
	now: () => number;
	store: SnapshotStore;
	log?: (msg: string) => void;
};

export function createSnapshotSender(deps: SnapshotSenderDeps) {
	const log = deps.log ?? (() => {});
	let busy = false;
	let first: ReturnType<typeof setTimeout> | undefined;
	let every: ReturnType<typeof setInterval> | undefined;

	/** Posts when the switch is on and a snapshot changed (30 minutes after the last post at the earliest) or 6 hours passed. Never throws. */
	async function tick(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const c = deps.config();
			if (!selfChatReady(c) || !c.share_status || !c.reply_prefix) return;
			const raw = await deps.build();
			// The cleaned, cut-to-limits form is what is compared and kept: a change past a list's limit is not a change the reader sees.
			const snap = raw && normalizeSnapshot(raw);
			if (!snap) return;
			const now = deps.now();
			const last = deps.store.load();
			const since = last ? now - last.sentAt : Infinity;
			if (last && since < MIN_GAP_MS) return;
			if (last && since < HEARTBEAT_MS && !snapshotChanged(last.snap, snap)) return;
			const body = encodeSnapshot(c.reply_prefix, snap);
			if (!body) return;
			await deps.post(body);
			deps.store.save({ sentAt: now, snap });
		} catch (e) {
			log(`jandi: status snapshot not sent (${(e as Error)?.message || "error"})`);
		} finally {
			busy = false;
		}
	}

	function stop(): void {
		if (first) clearTimeout(first);
		if (every) clearInterval(every);
		first = every = undefined;
	}

	/** The first tick comes after 30 seconds, then one every 2 minutes. */
	function start(): void {
		stop();
		first = setTimeout(() => {
			void tick();
			every = setInterval(() => void tick(), TICK_MS);
			every.unref?.();
		}, FIRST_TICK_MS);
		first.unref?.();
	}

	return { tick, start, stop };
}
