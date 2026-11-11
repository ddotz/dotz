// The summary OmO wrote at its latest compaction of a session, which holds the live goal chain a fresh session's handover needs.
// A session file is JSONL; the compaction entry is one line that begins {"type":"compaction" and has a string `summary`. A quote inside
// a JSON string is escaped, so that text at the start of a line can only be an entry of that type.
import { readFileSync } from "node:fs";
import { realTurn, type SessionMessage } from "./omp.ts";

const MARK = '{"type":"compaction"';

export function lastCompactionSummary(sessionFile: string): string | undefined {
	try {
		const buf = readFileSync(sessionFile);
		for (let at = buf.lastIndexOf(MARK); at >= 0; at = at > 0 ? buf.lastIndexOf(MARK, at - 1) : -1) {
			if (at > 0 && buf[at - 1] !== 0x0a) continue;
			const end = buf.indexOf(0x0a, at);
			const entry: { type?: string; summary?: unknown } = JSON.parse(buf.toString("utf8", at, end < 0 ? buf.length : end));
			if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) return entry.summary.trim();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

// Whether the latest summary is out of date: a real exchange (as recentExchanges counts them) follows the latest compaction entry, or the
// session has real exchanges and no compaction entry at all. An unreadable file is not stale. Only the part after the latest entry is parsed.
export function summaryStale(sessionFile: string): boolean {
	try {
		const buf = readFileSync(sessionFile);
		let at = buf.lastIndexOf(MARK);
		while (at > 0 && buf[at - 1] !== 0x0a) at = buf.lastIndexOf(MARK, at - 1);
		for (const line of buf.toString("utf8", Math.max(at, 0)).split("\n")) {
			if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
			const parsed: { message?: SessionMessage } = JSON.parse(line);
			if (parsed.message && realTurn(parsed.message) !== undefined) return true;
		}
	} catch {
		return false;
	}
	return false;
}
