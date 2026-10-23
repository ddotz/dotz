import { type Lane, persist } from "./lanestate.ts";
import { settleRevert } from "./lanefailover.ts";
import { msg, lang } from "./i18n.ts";
import { languageName } from "./language.ts";
import { log } from "./config.ts";
import { handoffNote } from "./outlang.ts";

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
	// smoke script against a temp DOTZ_DIR.") because the language sat only in the launch footer.
	const nudge = (lane.retainNext ? `\n${msg().retainNudge}` : "") + (/^\[owner via /.test(text) ? `\n${msg().ownerAnswerNudge}` : "");
	lane.retainNext = undefined;
	lane.proc?.send(`${text}${nudge}\n${msg().replyIn(languageName(lang()), false)}${handoffNote(`lane:${lane.name}`)}`, lane.status === "working" ? "steer" : "prompt");
	if (lane.status === "working") return;
	clearTimeout(lane.watchdog);
	lane.watchdog = setTimeout(() => {
		log(`lane ${lane.name} did not start a turn after a prompt; restarting it`);
		lane.revive = { text: msg().laneStopped };
		lane.proc?.kill(true);
	}, WATCHDOG_MS);
}
