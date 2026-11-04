// Lane questions waiting for the owner: a lane's [ask] report is saved in its lane.json (pendingAsk) until the owner
// answers, so a restarted or rotated orchestrator still hears it. Reads the files directly (no lanes.ts import), so it
// works before the lanes are restored and cannot form an import cycle with the orchestrator.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, TZ, tzLabel } from "./config.ts";
import { msg } from "./i18n.ts";
import type { Notice } from "./notices.ts";

const ASK_MAX = 1500;

// The file that holds a lane's pending question in full for as long as it is pending (report.md is overwritten by gateway notices).
export const pendingAskFile = (lane: string) => join(paths.lanes, lane, "pending-ask.md");

type PendingAsk = { lane: string; text: string; at: string };

export function pendingAsks(): PendingAsk[] {
	if (!existsSync(paths.lanes)) return [];
	const asks: PendingAsk[] = [];
	for (const lane of readdirSync(paths.lanes)) {
		try {
			const rec: { pendingAsk?: { text?: string; at?: string } } = JSON.parse(readFileSync(join(paths.lanes, lane, "lane.json"), "utf8"));
			const ask = rec.pendingAsk;
			if (typeof ask?.text === "string" && ask.text) asks.push({ lane, text: ask.text, at: typeof ask.at === "string" ? ask.at : "" });
		} catch {
			// no lane.json (a stray folder) or a half-written one: not a lane with a question
		}
	}
	return asks.sort((a, b) => a.at.localeCompare(b.at));
}

// "" when no lane waits for an answer; else the block the orchestrator needs to pick the questions up again.
export function pendingAsksBlock(): string {
	const asks = pendingAsks();
	if (!asks.length) return "";
	const entries = asks.map(a => {
		const at = a.at ? new Date(a.at).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
		const cut = a.text.length > ASK_MAX;
		return msg().pendingAskEntry(a.lane, `${at} ${tzLabel()}`, cut ? a.text.slice(0, ASK_MAX) : a.text, cut ? pendingAskFile(a.lane) : undefined);
	});
	return `[${msg().pendingAsksHead}]\n${entries.join("\n\n")}`;
}

// Asks stored before one question was one item (2026-11-05), read once on start, silently: a report row beside its card leaves every list, and a
// session's open question with no choice to answer it, or an unread loose [ask] of a session, closes. The text stays in the history.
export function retireStoredAsks(list: Notice[], at: string): number {
	let n = 0;
	const cards = new Set(list.filter(d => d.decision?.reply_to).map(d => `${d.decision!.to}|${d.decision!.reply_to}`));
	const lane = (s?: string) => !!s?.startsWith("lane:");
	for (const i of list) {
		const d = i.decision;
		if (d) {
			if (d.state !== "open" || !lane(d.to) || d.options.length) continue;
			Object.assign(d, { state: "answered", resolved: true, answered_at: at });
			i.read = true;
			n++;
		} else if (i.tone === "ask" && !i.dismissed && cards.has(`${i.src ?? i.open}|${i.at}`)) {
			i.read = i.dismissed = true;
			n++;
		} else if (i.tone === "ask" && !i.read && !i.dismissed && lane(i.by)) {
			i.read = true;
			n++;
		}
	}
	return n;
}
