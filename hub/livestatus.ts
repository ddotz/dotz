// Live status line: while an owner message from Discord is still unanswered after START_AFTER_MS, one message in that
// channel shows what the turn is doing (elapsed time, the latest tool-call intent, running lanes and task workers) and is
// edited in place. It costs no model tokens: the text is built from activity rows the gateway already has and is never
// localized or rewritten. clearProgress (final answer, lane report) removes it, and nothing can put it back after that.
import { subagentLists } from "./activity.ts";
import { log } from "./config.ts";
import * as discord from "./discord.ts";
import { activityItems } from "./events.ts";
import { msg } from "./i18n.ts";
import { lanes } from "./lanes.ts";

const START_AFTER_MS = 10_000;
// Discord allows about 5 edits per 5 s per channel; one attempt every 2 s (and only when the text changed) keeps far below
// it while a 15 s turn still shows its intents moving.
const TICK_MS = 2_000;
// A turn that never reports its end (the process died) must not keep a line alive forever.
const MAX_MS = 60 * 60_000;
const KEY = "live";
const TEXT_MAX = 300;

// One live line per target. While it is the entry of `active` it owns the target; a tick checks that before and after
// every await, so a line that was stopped (the entry is gone or replaced) can neither post nor edit.
type Live = { source: string; since: number; timer?: Timer; text?: string; inflight: Promise<void> };
const active = new Map<string, Live>();

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The latest tool call of a source in its current turn; nothing once that turn has ended.
function latestIntent(source: string): string {
	const rows = activityItems(source);
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i]!;
		if (r.type === "turn_end") return "";
		if (r.type === "tool_call") return short((r.intent || r.text || "").replace(/\s+/g, " ").trim(), 80);
	}
	return "";
}

function list(items: string[], max: number): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} ${msg().liveMore(items.length - max)}`;
}

export function liveText(live: { source: string; since: number }): string {
	const seconds = Math.floor((Date.now() - live.since) / 10_000) * 10;
	const laneNames = [...lanes.values()].filter(l => l.status === "working" && `lane:${l.name}` !== live.source).map(l => l.name);
	const workers = Object.values(subagentLists())
		.flat()
		.filter(s => s.status === "running")
		.map(s => `${s.agent ?? "worker"}${s.description ? `: ${short(s.description, 28)}` : ""}`);
	return short(msg().liveStatus(seconds, latestIntent(live.source), list(laneNames, 4), list(workers, 3)), TEXT_MAX);
}

// Posts the line, or edits it when the text changed (discord.progress edits in place once it has posted).
async function show(target: string, live: Live): Promise<void> {
	const text = liveText(live);
	if (text === live.text) return;
	try {
		const r = await discord.progress(target, KEY, text);
		if (r.delivered) live.text = text;
	} catch (e) {
		log(`live status in ${target} failed: ${e}`);
	}
}

async function tick(target: string, live: Live): Promise<void> {
	if (active.get(target) !== live) return;
	const ended = activityItems(live.source).some(r => r.type === "turn_end" && Date.parse(r.ts) >= live.since);
	const over = ended || Date.now() - live.since >= MAX_MS;
	// Something already answered here before the line ever appeared: nothing to show.
	const answered = !live.text && discord.lastSendAt(target) >= live.since;
	if (over || answered) {
		if (live.text) await discord.clearProgress(target);
		else active.delete(target);
		return;
	}
	live.inflight = show(target, live);
	await live.inflight;
	if (active.get(target) === live) live.timer = setTimeout(() => void tick(target, live), TICK_MS);
}

/** An owner message from Discord started (or joined) a turn of `source` ("orchestrator" or "lane:<name>"); `target` is where the answer goes. */
export function begin(target: string, source: string): void {
	if (!discord.status.enabled || active.has(target)) return;
	const live: Live = { source, since: Date.now(), inflight: Promise.resolve() };
	live.timer = setTimeout(() => void tick(target, live), START_AFTER_MS);
	active.set(target, live);
}

// Stops the ticker of a target and waits for a post or edit still in flight, so the caller can delete the message
// afterwards without a late request putting it back.
export function stop(target: string): Promise<void> {
	const live = active.get(target);
	if (!live) return Promise.resolve();
	active.delete(target);
	clearTimeout(live.timer);
	return live.inflight;
}

discord.setBeforeClearHook(stop);
