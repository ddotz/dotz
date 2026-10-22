// Live progress while an owner message from Discord is unanswered. Typing shows from the start and is renewed every
// TYPING_MS (Discord drops it after ~10 s). From FIRST_AFTER_MS on the gateway keeps ONE progress message in that channel,
// edited in place (the same "progress" slot the orchestrator's own update_key note uses): how long it has run, the
// tool-call intents since the last edit, the current one, running lanes and task workers. It is edited at each milestone
// (a lane or task worker started or finished) and otherwise at most every EVERY_MS, and only when it would say something
// new (owner 2026-10-20: "답변은 준비되고 해야해. 먼저하면 안됨": while working, only 👀, typing and one edited progress
// message; it replaces the 2026-10-19 "every 5 minutes a new message"). It costs no model tokens and is never localized.
// The answer deletes it (clearProgress hook); it also stops at the turn's end and after MAX_MS.
import { subagentLists } from "./activity.ts";
import { log } from "./config.ts";
import * as discord from "./discord.ts";
import { activityItems } from "./events.ts";
import { msg } from "./i18n.ts";
import { lanes } from "./lanes.ts";

export const FIRST_AFTER_MS = 5 * 60_000;
const EVERY_MS = 5 * 60_000;
// After the first report a milestone (a lane or task worker started or finished) is reported at the next check instead
// of waiting out EVERY_MS (owner 2026-10-19: "진행보고도 오모냥처럼": a reply at each milestone, at most every 5 min otherwise).
const CHECK_MS = 30_000;
// A turn that never reports its end (the process died) must not keep reporting forever.
const MAX_MS = 6 * 3600_000;
const TEXT_MAX = 400;
const TYPING_MS = 8000;

// One reporter per target. While it is the entry of `active` it owns the target; a tick checks that before and after
// every await, so a reporter that was stopped (the entry is gone or replaced) cannot post. `turnFrom` moves when another
// owner message joins: the end of the turn that was running before it is not the end of the wait.
type Live = { web?: boolean; key: string; source: string; since: number; turnFrom: number; timer?: Timer; typing?: Timer; lastAt: number; lastState?: string; lastRunning?: string; posted?: boolean; inflight: Promise<void> };
const active = new Map<string, Live>();

// The web chat has no Discord message to edit: its progress line is an "out" event with update_key "progress" that the page
// keeps as one note per conversation (main.ts wires this; the answer drops it).
let webPost: (target: string, text: string) => void = () => {};
export function setWebProgress(fn: (target: string, text: string) => void): void {
	webPost = fn;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The tool-call intents of a source's current turn since `since` (oldest first, repeats folded), with when each was made.
function turnIntents(source: string, since: number): { t: string; at: number }[] {
	const out: { t: string; at: number }[] = [];
	for (const r of activityItems(source)) {
		const at = Date.parse(r.ts);
		if (at < since) continue;
		if (r.type === "turn_end") out.length = 0;
		else if (r.type === "tool_call") {
			// An absolute path reads as its file name: the owner knows the file, not the folders above it.
			const t = short((r.intent || r.text || "").replace(/\s+/g, " ").trim().replace(/(?:~?\/[^\s/]+)+\/([^\s/]+)/g, "$1"), 60);
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
function liveReport(live: { source: string; since: number; lastAt: number }): { state: string; running: string; moved: boolean; text: string } {
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
	return { state: parts.slice(1).join("\n"), running: parts.slice(2).join("\n"), moved: between.length > 0, text: short(msg().liveStatus(minutes, ...parts), TEXT_MAX) };
}

// The wait is over: the turn ended, a real message (not the progress edit) reached the channel, or MAX_MS passed.
function over(target: string, live: Live): boolean {
	const ended = activityItems(live.source).some(r => r.type === "turn_end" && Date.parse(r.ts) >= live.turnFrom);
	return ended || discord.lastSendAt(target) >= live.since || Date.now() - live.since >= MAX_MS;
}

function end(_target: string, live: Live): void {
	if (active.get(live.key) === live) active.delete(live.key);
	clearTimeout(live.timer);
	clearInterval(live.typing);
}

async function tick(target: string, live: Live): Promise<void> {
	if (active.get(live.key) !== live) return;
	if (over(target, live)) {
		end(target, live);
		// A turn that ended with no answer here ("-", or its answer went elsewhere) leaves no stale progress message behind.
		if (live.posted && !live.web) void discord.clearProgress(target).catch(e => log(`progress clear in ${target} failed: ${e}`));
		return;
	}
	const { state, running, moved, text } = liveReport(live);
	const first = !live.posted;
	const milestone = !first && running !== live.lastRunning;
	const due = Date.now() - live.lastAt >= EVERY_MS - 1000 || first;
	if (milestone || (due && (moved || state !== live.lastState))) {
		live.inflight = (live.web ? Promise.resolve({ delivered: (webPost(target, text), true) }) : discord.progress(target, "progress", text))
			.then(r => {
				if (!r.delivered) return;
				live.lastState = state;
				live.lastRunning = running;
				live.lastAt = Date.now();
				live.posted = true;
			})
			.catch(e => log(`live report in ${target} failed: ${e}`));
		await live.inflight;
	}
	if (active.get(live.key) === live) live.timer = setTimeout(() => void tick(target, live), CHECK_MS);
}

/** An owner message from Discord (or, with `web`, from the web chat) started (or joined) a turn of `source` ("orchestrator" or "lane:<name>"); `target` is where the answer goes. */
export function begin(target: string, source: string, web = false): void {
	if (!web && !discord.status.enabled) return;
	const since = Date.now();
	// The web chat's progress line and the Discord channel's are separate waits on the same target.
	const key = web ? `web|${target}` : target;
	const joined = active.get(key);
	if (joined) {
		joined.turnFrom = since;
		return;
	}
	const live: Live = { web, key, source, since, turnFrom: since, lastAt: since, inflight: Promise.resolve() };
	live.timer = setTimeout(() => void tick(target, live), FIRST_AFTER_MS);
	live.typing = setInterval(() => (active.get(key) !== live || over(target, live) ? end(target, live) : live.web || discord.typing(target)), TYPING_MS);
	active.set(key, live);
}

// Stops the reporter of a target and waits for a report still in flight, so the answer lands after it.
export function stop(target: string): Promise<void> {
	const live = active.get(target);
	if (!live) return Promise.resolve();
	end(target, live);
	return live.inflight;
}

discord.setBeforeClearHook(stop);
