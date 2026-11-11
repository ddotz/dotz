// Pieces of the orchestrator's recall prompt (the first message of a session, and the re-read after a compaction: the
// runtime drops every entry before a compaction's first kept one, the first message included).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_CAP = 2500;
export const OWNER_CAP = 3000;
export const LEDGER_CAP = 3000;
const LEDGER_WORDS = 300;
const OLD_MS = 14 * 86_400_000;

type OpenTask = { id?: unknown; what?: unknown; next?: unknown; lane?: unknown; since?: unknown; started?: unknown };

/** One open owner request in a session's ledger file (hub/open-ledger.ts writes it, the recall prompts read it). `lost`: it left the queue's tracking (deferred over 3 h) without an answer. */
export type LedgerEntry = { id: string; target: string; at: number; text: string; state: "queued" | "deferred"; workers?: string[]; interim?: number; lost?: true };

/** Where a session keeps its ledger: beside its pending.json (the main session's folder is the data folder). */
export const ledgerIn = (dir: string): string => join(dir, "pending-ledger.json");

export function loadLedger(file: string | undefined): LedgerEntry[] {
	try {
		const list: unknown = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
		return Array.isArray(list) ? list.filter((e): e is LedgerEntry => !!e && typeof e.id === "string" && typeof e.at === "number") : [];
	} catch {
		return [];
	}
}

const clock = (at: number, tz: string, withDate: boolean): string => {
	const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map(x => [x.type, x.value]));
	return `${withDate ? `${p.month}-${p.day} ` : ""}${p.hour}:${p.minute}`;
};

/**
 * The open owner requests as one block, newest first, under `max` characters: id, time in the owner's zone, state and the owner's words
 * (cut at 300 characters; the whole message is in inbox.jsonl under its id). What does not fit, and every request older than 14 days,
 * is named by id in the last line, with the count and the file. Empty when nothing is open.
 */
export function renderOpenRequests(entries: LedgerEntry[], file: string, tz: string, now = Date.now(), max = LEDGER_CAP): string {
	if (!entries.length) return "";
	const head = `Open owner requests (kept by the gateway, newest first, times in ${tz}; the owner's words are cut at ${LEDGER_WORDS} characters, the whole message is in inbox.jsonl under its id). A request stays listed until its answer goes out with its id as reply_to:`;
	const line = (e: LedgerEntry) => {
		const words = e.text.replace(/\s+/g, " ").trim();
		const how = e.state === "queued" ? "queued or being answered" : e.lost ? "deferred; the queue no longer tracks it (over 3 h), still unanswered" : `deferred${e.workers?.length ? `, waiting on ${e.workers.join(", ")}` : ", no worker listed"}`;
		return `- ${e.id} · ${e.target} · ${clock(e.at, tz, true)} · ${how}${e.interim ? `; interim answer given at ${clock(e.interim, tz, false)}` : ""} · "${words.slice(0, LEDGER_WORDS)}${words.length > LEDGER_WORDS ? "…" : ""}"`;
	};
	const sorted = entries.toSorted((x, y) => y.at - x.at);
	const tailOf = (ids: string[]) => (ids.length ? `\n[... ${ids.length} more open, by id: ${ids.join(", ")}; read ${file}; the owner's message is in inbox.jsonl]` : "");
	const shown: LedgerEntry[] = [];
	const fits = (e: LedgerEntry) => {
		const rest = sorted.filter(x => x !== e && !shown.includes(x)).map(x => x.id);
		return `${head}\n${[...shown, e].map(line).join("\n")}${tailOf(rest)}`.length <= max;
	};
	// Newest first until the budget is reached; the rest, and every request older than 14 days, are named by id in the closing line.
	for (const e of sorted) {
		if (now - e.at > OLD_MS || !fits(e)) break;
		shown.push(e);
	}
	return `${head}\n${shown.map(line).join("\n")}${tailOf(sorted.filter(x => !shown.includes(x)).map(x => x.id))}`;
}

const dayOf = (t: OpenTask): number => Date.parse(String(t.since ?? t.started ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "");

// state.json as a compact listing: one line per open task, the other top-level keys by name only, cut at a line
// boundary under `max` characters with a marker that names the file. Newest first (state.json appends new tasks at the end),
// so a cut drops the oldest. Not a JSON object: the old raw slice.
export function renderState(raw: string, path: string, max = STATE_CAP, now = Date.now()): string {
	let state: unknown;
	try {
		state = JSON.parse(raw);
	} catch {
		return raw.slice(0, 4000);
	}
	if (!state || typeof state !== "object" || Array.isArray(state)) return raw.slice(0, 4000);
	const { open_tasks: tasks, ...rest } = state as Record<string, unknown>;
	const lines: string[] = [];
	if (Array.isArray(tasks)) {
		lines.push("open_tasks:");
		for (const t of (tasks as OpenTask[]).toReversed()) {
			const task = t && typeof t === "object" ? t : {};
			const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
			lines.push(`- ${text(task.id)}: ${text(task.what)}${task.next ? ` (next: ${text(task.next)})` : ""}${task.lane ? ` [lane: ${text(task.lane)}]` : ""}`);
		}
	}
	const others = Object.keys(rest);
	if (others.length) lines.push(`other keys: ${others.join(", ")}`);
	const text = lines.join("\n");
	if (text.length <= max) return text;
	// The marker says how many tasks the cut left out and how many of all are older than 14 days, so the model closes them.
	const all = Array.isArray(tasks) ? (tasks as OpenTask[]) : [];
	const old = all.filter(t => t && typeof t === "object" && now - dayOf(t) > OLD_MS).length;
	const markerFor = (n: number) => `[... cut at ${max} characters: ${n} of ${all.length} tasks shown, ${all.length - n} cut, ${old} older than 14 days; close the finished ones in ${path}]`;
	const room = max - markerFor(all.length).length - 1;
	const cut = text.slice(0, Math.max(0, room));
	const end = cut.lastIndexOf("\n");
	const kept = end >= 0 ? cut.slice(0, end) : "";
	return `${kept}\n${markerFor(kept.split("\n").filter(l => l.startsWith("- ")).length)}`;
}

// owner.md grows at the end, so an old head-only cut kept the oldest facts and lost every recent one. Over `max` characters
// the card goes newest line first, whole lines only, and ends with a marker that names the file.
export function newestLines(text: string, path: string, max = OWNER_CAP): string {
	if (text.length <= max) return text;
	const lines = text.split("\n").filter(line => line.trim());
	const room = max - path.length - 60;
	const kept: string[] = [];
	let used = 0;
	for (const line of lines.toReversed()) {
		if (used + line.length + 1 > room) break;
		kept.push(line);
		used += line.length + 1;
	}
	return `${kept.join("\n")}\n[... newest ${kept.length} of ${lines.length} lines; read ${path} for the rest]`;
}

// MODE.md without one `## ` section: from the heading that starts with `heading` to the next `## ` heading (or the end).
export function dropSection(mode: string, heading: string): string {
	const lines = mode.split("\n");
	const from = lines.findIndex(l => l.startsWith(heading));
	if (from < 0) return mode;
	let to = lines.findIndex((l, i) => i > from && l.startsWith("## "));
	if (to < 0) to = lines.length;
	return [...lines.slice(0, from), ...lines.slice(to)].join("\n");
}

// channel-setups.json as one line per channel, the shape of workchannels.ts setupsSummary (that module needs the gateway's config):
// the raw JSON with timestamps and ids took 2.8K of the re-read after a compaction. Not a list: the old raw slice.
export function renderSetups(raw: string, max = 3000): string {
	let list: unknown;
	try {
		list = JSON.parse(raw);
	} catch {
		return raw.slice(0, max);
	}
	if (!Array.isArray(list)) return raw.slice(0, max);
	const text = list
		.filter(s => s && typeof s === "object")
		.map(s => `- #${s.name} (ch:${s.channel}): ${s.purpose ?? ""}${s.standing ? ` | standing: ${s.standing} (${s.scope ?? "no limit set"}${s.expires ? `, until ${s.expires}` : ""})` : ""} | logins: ${(s.logins ?? []).join(", ") || "none"} | monitors: ${(s.monitors ?? []).length}`)
		.join("\n");
	return text.length > max ? `${text.slice(0, max)}\n[... cut at ${max} characters; dotz_channel list]` : text;
}

/** The ledger block of a session's recall prompt: "" when the file holds nothing open. */
export const openRequestsBlock = (file: string, tz: string, now = Date.now()): string => renderOpenRequests(loadLedger(file), file, tz, now);
