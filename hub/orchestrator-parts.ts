// Pieces of the orchestrator that hold no state of their own: the start prompt and the handover text, the fresh status record,
// and the read of when a session file last got an answer. hub/orchestrator.ts passes them what they need.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, IDENTITY_FILE, log, paths } from "./config.ts";
import { SUMMARY_MAX_CHARS } from "./compact-instructions.ts";
import { newCtx } from "./context.ts";
import { yesterdayNote } from "./day-note-format.ts";
import { featurePrompt } from "./featuredirs.ts";
import { modeFile, msg, withReplyLine } from "./i18n.ts";
import type { OrchError } from "./orch-error.ts";
import { LESSONS_MAX_BYTES } from "./prompt-budget.ts";
import { quickMode } from "./quick-chat.ts";
import { boundaryEntries, dropSection, newestLines, renderState } from "./recall-parts.ts";
import type { RuntimeAdapter } from "./runtime/types.ts";
import { setupsSummary } from "./workchannels.ts";

// When the model last answered in a session file: the timestamp of its last assistant message, read from the file's tail
// (startup bookkeeping lines after it and the file's mtime say nothing about the prompt cache).
export function lastAnswerAt(file: string, tailBytes = 512 * 1024): number | undefined {
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - tailBytes);
		const buf = Buffer.alloc(size - start);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, buf.length, start);
		} finally {
			closeSync(fd);
		}
		const lines = buf.toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i]!.includes('"assistant"')) continue;
			try {
				const e = JSON.parse(lines[i]!);
				if (e.type !== "message" || e.message?.role !== "assistant") continue;
				const at = Date.parse(e.timestamp);
				if (Number.isFinite(at)) return at;
			} catch {}
		}
	} catch {}
	return undefined;
}

// The static part of the contract: the owner's identity and MODE (no mail section while zele is off; cut to quickMode for the quick chat, `light`). It reads
// files and config only, no time, state or ledger, so it is the same at every spawn of a session until MODE.md, IDENTITY.md or the zele setting is edited:
// a runtime that keeps it in its system prompt (caps.modeInSystem) then reads it from the prompt cache on every turn, after a compaction and after a resume.
// A resume after such an edit writes the prompt cache anew once, as after a change of a tool text (tools sit before the system prompt in the same prefix).
export function modeContract(light = false): string {
	// The mail and calendar section is only useful while zele runs (zele.enabled defaults to on, as in zele.ts).
	const zeleOn = (cfg as { zele?: { enabled?: boolean } }).zele?.enabled !== false;
	const modeText = readFileSync(modeFile(), "utf8");
	const full = zeleOn ? modeText : dropSection(modeText, "## Mail and calendar");
	const id = cfg.identity;
	const identity = existsSync(IDENTITY_FILE) ? readFileSync(IDENTITY_FILE, "utf8").slice(0, 3000) : msg().identityFallback(id?.character ?? "", id?.tone ?? "");
	return msg().contract({ identity, mode: light ? quickMode(full) : full });
}

// The first prompt. `light` is the quick chat's: the contract cut to quickMode, and neither the channel setups nor state.json (hub/quick-chat.ts).
// `modeInSystem`: identity and MODE are in the system note (modeContract), so the prompt leaves them out and says where they are.
export function recallText(scope: string, ledger = "", light = false, modeInSystem = false): string {
	const stateFile = join(DATA_DIR, "state.json");
	const state = existsSync(stateFile) ? renderState(readFileSync(stateFile, "utf8"), stateFile) : "{}";
	// A cut file says so: RULES.md outgrew the old 6000-character cap and silently lost its last lines (blocked commands).
	const whole = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
	const file = (p: string, max: number) => {
		const t = whole(p);
		return t.length > max ? `${t.slice(0, max)}\n[... cut at ${max} characters; read ${p} for the rest]` : t;
	};
	const features = featurePrompt(DATA_DIR, "orchestrator", log);
	const text = withReplyLine(msg().recall({ contract: modeInSystem ? undefined : modeContract(light), rules: file(paths.rules, 12000) + (features ? `\n\n${features}` : ""), lessons: file(paths.lessons, LESSONS_MAX_BYTES), memory: `${newestLines(whole(paths.owner), paths.owner)}\n${boundaryEntries(whole(paths.boundaries))}`, ...(light ? {} : { setups: setupsSummary(), state }) }) + (ledger ? `\n\n${ledger}` : "") + (scope ? `\n\n${scope}` : ""));
	const note = yesterdayNote();
	return note ? `${text}\n${msg().dayNote.line(note)}` : text;
}

// The whole handover (framing, the previous session's last compaction summary, recent exchanges) is cut at this many characters, about 6K tokens:
// the summary (at most SUMMARY_MAX_CHARS, the size the compaction asks for) goes in first, the recent exchanges fill what is left, newest kept.
export const HANDOVER_MAX_CHARS = 16_000;

export function handover(runtime: RuntimeAdapter, previous: string): string {
	const exchanges = runtime.recentExchanges(previous);
	if (exchanges === undefined) return "";
	const summary = runtime.lastCompactionSummary?.(previous)?.slice(0, SUMMARY_MAX_CHARS) ?? "";
	const room = HANDOVER_MAX_CHARS - msg().handover(previous, "", summary).length;
	if (exchanges.length <= room) return msg().handover(previous, exchanges, summary);
	const newest = exchanges.slice(exchanges.length - Math.max(0, room));
	const turn = newest.indexOf("\n\n");
	return msg().handover(previous, turn >= 0 ? newest.slice(turn + 2) : newest, summary);
}

/**
 * Where in the owner prompts sent to a process the one that `seen` (a user message the session recorded) carries sits; -1 when it carries none.
 * Compared trimmed: the runtime's user text is trimmed, so a prompt ending in a newline would never match and stay owed, keeping the session from parking.
 */
export const startedIndex = (unstarted: { text: string }[], seen: string): number => unstarted.findIndex(u => u.text.trim() !== "" && seen.includes(u.text.trim()));

export const newOrchState = () => ({
	status: "stopped" as "stopped" | "starting" | "idle" | "working" | "rate-limited",
	// Why a "rate-limited" pause is on: a usage limit, or a billing/auth problem only the owner can fix.
	pauseKind: "rate" as "rate" | "owner",
	// Who stopped it (the run state line says "주인님이 멈추게 했어요" for the owner's own stop, hub/runstate.ts).
	stoppedBy: "" as "" | "owner",
	stoppedAt: "",
	sessionFile: "",
	// The model the running process answers on now: the configured one, or the fallback it switched to (reset at every start).
	activeModel: "",
	startedAt: "",
	lastText: "",
	rateLimitedUntil: "",
	// The limit lifted and the held work went back in: true until a turn starts on it (the web line says so) or the session pauses again.
	resuming: false,
	restarts: [] as number[],
	// Set when the automatic retries gave up (markError); cleared by the next successful turn. The web banner reads it.
	error: undefined as OrchError | undefined,
	ctx: newCtx(),
});
