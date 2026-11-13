import { type Lane, persist } from "./lanestate.ts";
import { settleRevert } from "./lanefailover.ts";
import { msg, lang } from "./i18n.ts";
import { languageName } from "./language.ts";
import { log } from "./config.ts";
import { handoffNote } from "./outlang.ts";
import { footer } from "./lanefooter.ts";

const WATCHDOG_MS = 120_000;

// A paused lane (rate limit) keeps owner messages on disk instead of starting turns that fail at once; they go in with
// the resume note.
export function prompt(lane: Lane, text: string): void {
	lane.silent = undefined;
	// OmO refuses a prompt while a requested compaction runs, so a message sent then was lost (2026-10-21, the same hole
	// as the orchestrator's): it is held and goes in when the compaction ends (or with the resume note if it failed).
	if (lane.status === "rate-limited" || (lane.status !== "working" && lane.ctx.compaction.state === "compacting")) {
		(lane.held ??= []).push(text);
		persist(lane);
		return;
	}
	settleRevert(lane, false);
	// Every lane turn ends with the reply-language line too: lane progress notes drifted into English ("Now a throwaway
	// smoke script against a temp DOTZ_DIR.") because the language sat only in the launch footer. It names every kind of lane text
	// (report, progress note, todo item, tool intent): "answer the owner in Korean" read as covering replies only.
	const nudge = (lane.retainNext ? `\n${msg().retainNudge}` : "") + (lane.workerNext ? `\n${lane.workerNext}` : "") + (/^\[owner via /.test(text) ? `\n${msg().ownerAnswerNudge}` : "");
	// A compaction finished and the extension's re-read of the footer (identity, rules) is not in this process: this prompt carries it once.
	const contract = lane.contractDue && !lane.contractQueued ? `\n${footer(lane).trim()}` : "";
	if (lane.contractDue && !lane.contractQueued) {
		lane.contractDue = undefined;
		persist(lane);
	}
	lane.retainNext = lane.workerNext = undefined;
	// The owner's next message while the turn is still starting joins its first model call: a queued steer is drained at the start of
	// the agent loop (orchestrator.ts), a second "prompt" would ask for a second turn.
	const joins = lane.status === "working" || (lane.startingOn === lane.proc && lane.proc !== undefined && /^\[owner via /.test(text));
	lane.proc?.send(`${text}${nudge}${contract}\n${msg().laneLanguage(languageName(lang()))}${handoffNote(`lane:${lane.name}`)}`, joins ? "steer" : "prompt");
	if (joins) return;
	lane.prompted = text;
	lane.startingOn = lane.proc;
	clearTimeout(lane.watchdog);
	lane.watchdog = setTimeout(() => {
		log(`lane ${lane.name} did not start a turn after a prompt; restarting it`);
		lane.revive = { text: msg().laneStopped };
		lane.proc?.kill(true);
	}, WATCHDOG_MS);
}
