// Live progress reports: while an owner message from Discord is still unanswered after FIRST_AFTER_MS, the gateway posts a
// short report in that channel (how long it has run, the tool-call intents since the last report, the current one, running
// lanes and task workers), then a new one every EVERY_MS (owner 2026-10-19: "5분은 괜찮아. 그 이후에 5분 단위로 새로
// 메시지 보내서 보고해"). As in Dori's freshness sweep, a report that would say nothing new since the last one is skipped.
// It costs no model tokens: the text is built from activity rows the gateway already has and is never localized or
// rewritten. The reports stay in the channel; they stop at the turn's end, at the answer (clearProgress hook, or any other
// message sent there) and after MAX_MS.
import { subagentLists } from "./activity.ts";
import { log } from "./config.ts";
import * as discord from "./discord.ts";
import { activityItems } from "./events.ts";
import { msg } from "./i18n.ts";
import { lanes } from "./lanes.ts";

const FIRST_AFTER_MS = 5 * 60_000;
const EVERY_MS = 5 * 60_000;
// A turn that never reports its end (the process died) must not keep reporting forever.
const MAX_MS = 6 * 3600_000;
const TEXT_MAX = 400;

// One reporter per target. While it is the entry of `active` it owns the target; a tick checks that before and after
// every await, so a reporter that was stopped (the entry is gone or replaced) cannot post. `turnFrom` moves when another
// owner message joins: the end of the turn that was running before it is not the end of the wait.
type Live = { source: string; since: number; turnFrom: number; timer?: Timer; lastAt: number; lastState?: string; postedAt?: number; inflight: Promise<void> };
const active = new Map<string, Live>();

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The tool-call intents of a source's current turn since `since` (oldest first, repeats folded), with when each was made.
function turnIntents(source: string, since: number): { t: string; at: number }[] {
	const out: { t: string; at: number }[] = [];
	for (const r of activityItems(source)) {
		const at = Date.parse(r.ts);
		if (at < since) continue;
		if (r.type === "turn_end") out.length = 0;
		else if (r.type === "tool_call") {
			const t = short((r.intent || r.text || "").replace(/\s+/g, " ").trim(), 60);
			if (t && out.at(-1)?.t !== t) out.push({ t, at });
		}
	}
	return out;
}

function list(items: string[], max: number): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(-max).join(", ")} ${msg().liveMore(items.length - max)}`;
}

// What a report says, and whether it says anything new: a tool call since the last report, or a changed current intent,
// lane or worker list (`state`, compared with the last report's). "Now" is the turn's latest intent; "since the last
// report" lists the ones made after the previous report, before it.
export function liveReport(live: { source: string; since: number; lastAt: number }): { state: string; moved: boolean; text: string } {
	const intents = turnIntents(live.source, live.since);
	const now = intents.pop()?.t ?? "";
	const between = intents.filter(i => i.at >= live.lastAt).map(i => i.t);
	const laneNames = [...lanes.values()].filter(l => l.status === "working" && `lane:${l.name}` !== live.source).map(l => l.name);
	const workers = Object.values(subagentLists())
		.flat()
		.filter(s => s.status === "running")
		.map(s => `${s.agent && s.agent !== "task" ? s.agent : s.id}${s.description ? `: ${short(s.description, 28)}` : ""}`);
	const parts = [list(between, 4), now, list(laneNames, 4), list(workers, 3)] as const;
	const minutes = Math.round((Date.now() - live.since) / 60_000);
	return { state: parts.slice(1).join("\n"), moved: between.length > 0, text: short(msg().liveStatus(minutes, ...parts), TEXT_MAX) };
}

async function tick(target: string, live: Live): Promise<void> {
	if (active.get(target) !== live) return;
	const ended = activityItems(live.source).some(r => r.type === "turn_end" && Date.parse(r.ts) >= live.turnFrom);
	// Anything else sent to the channel after the turn began (or after our last report) is the answer, or part of it.
	const answered = discord.lastSendAt(target) > (live.postedAt ?? live.since - 1);
	if (ended || answered || Date.now() - live.since >= MAX_MS) {
		active.delete(target);
		return;
	}
	const { state, moved, text } = liveReport(live);
	if (moved || state !== live.lastState) {
		live.inflight = discord
			.send(target, text)
			.then(r => {
				if (!r.delivered) return;
				live.lastState = state;
				live.lastAt = Date.now();
				live.postedAt = discord.lastSendAt(target);
			})
			.catch(e => log(`live report in ${target} failed: ${e}`));
		await live.inflight;
	}
	if (active.get(target) === live) live.timer = setTimeout(() => void tick(target, live), EVERY_MS);
}

/** An owner message from Discord started (or joined) a turn of `source` ("orchestrator" or "lane:<name>"); `target` is where the answer goes. */
export function begin(target: string, source: string): void {
	if (!discord.status.enabled) return;
	const since = Date.now();
	const joined = active.get(target);
	if (joined) {
		joined.turnFrom = since;
		return;
	}
	const live: Live = { source, since, turnFrom: since, lastAt: since, inflight: Promise.resolve() };
	live.timer = setTimeout(() => void tick(target, live), FIRST_AFTER_MS);
	active.set(target, live);
}

// Stops the reporter of a target and waits for a report still in flight, so the answer lands after it.
export function stop(target: string): Promise<void> {
	const live = active.get(target);
	if (!live) return Promise.resolve();
	active.delete(target);
	clearTimeout(live.timer);
	return live.inflight;
}

discord.setBeforeClearHook(stop);
