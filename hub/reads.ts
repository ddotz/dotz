import { existsSync, readFileSync } from "node:fs";
import { log, paths, writeAtomic } from "./config.ts";
import { broadcast } from "./events.ts";

// Where the owner has read up to in each conversation (Discord-style), kept in reads.json {target: lastReadTs} so every
// device agrees. A position only moves forward. The unread count itself is derived in hub/conversations.ts.
const READ_TARGET = /^(?:main|alert|worklog|ch:\d+|lane:\S+)$/;

const load = (): Record<string, string> => {
	if (!existsSync(paths.reads)) return {};
	try {
		const parsed = JSON.parse(readFileSync(paths.reads, "utf8"));
		const out: Record<string, string> = {};
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && Number.isFinite(Date.parse(v))) out[k] = v;
		return out;
	} catch (e) {
		log(`reads.json unreadable, starting empty: ${e}`);
		return {};
	}
};
const reads = load();
// First run with read positions (no reads.json yet): everything said before now counts as read, so an existing install does
// not open with every old message as unread. Kept under a key no target can match.
const SINCE = "_since";
if (!reads[SINCE] && !existsSync(paths.reads)) {
	reads[SINCE] = new Date(Date.now()).toISOString();
	writeAtomic(paths.reads, `${JSON.stringify(reads, null, 1)}\n`);
}

export const readOf = (target: string): string | null => (target === SINCE ? null : (reads[target] ?? null));
// The position unread counts start from: the conversation's own, else the first-run baseline.
export const unreadFrom = (target: string): string | null => readOf(target) ?? reads[SINCE] ?? null;

type ReadResult = { ok: true; target: string; ts: string; moved: boolean } | { ok: false; error: string };

// POST /api/read {target, ts}: moves the position forward (an older or equal ts changes nothing) and tells every device.
export function markRead(input: { target?: unknown; ts?: unknown }): ReadResult {
	const target = typeof input.target === "string" ? input.target : "";
	if (!READ_TARGET.test(target)) return { ok: false, error: "target must be main, alert, worklog, ch:<id> or lane:<name>" };
	const at = typeof input.ts === "string" ? Date.parse(input.ts) : Number.NaN;
	if (!Number.isFinite(at)) return { ok: false, error: "ts must be an ISO timestamp" };
	const ts = new Date(at).toISOString();
	const prev = reads[target];
	if (prev && prev >= ts) return { ok: true, target, ts: prev, moved: false };
	reads[target] = ts;
	writeAtomic(paths.reads, `${JSON.stringify(reads, null, 1)}\n`);
	broadcast({ kind: "read", source: "gateway", target, ts });
	return { ok: true, target, ts, moved: true };
}
