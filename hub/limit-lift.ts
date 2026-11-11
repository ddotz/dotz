// The subscription's usage limit is over, and dotz acts on it without a restart or a new login. Two ways to know: the 리셋권 was just spent
// here (hub/claude-reset.ts), or the usage read dotz already has (one GET, no model call) shows the window that was full under its limit
// again while a session is paused on it: when the owner presses 재개 or restart, and every LIMIT_WATCH_MS while something is paused
// (hub/limit-watch.ts). Lifting is the same either way, mirroring Claude Code's /limit-reset: forget the recorded limit, then read the usage again.
//   1. dotz's own quota blocks on the subscription pools (hub/fallback.ts liftQuotaBlocks);
//   2. OmO's usage block on that account, with OmO's own command (omoUnblockAccount);
//   3. the paused orchestrator sessions and lanes go on, so held messages go out;
//   4. the usage is read again;
//   5. the owner is told once that the limit is over, when a pause alert of this episode (hub/limit-alert.ts) is still the latest word, and the saved pauses go.
//      The episode, not the counts of 1-3, decides: a session that ran on by itself leaves nothing to count, yet its alert still reads "paused until <date>".
// A try that fails anyway is not repeated for the same episode: the session pauses again for the time the server names.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, NAME, writeAtomic } from "./config.ts";
import { convs } from "./convsessions.ts";
import { liftQuotaBlocks } from "./fallback.ts";
import { msg } from "./i18n.ts";
import { liftLanePauses, limitPausedLanes, limitPausedModels } from "./laneops.ts";
import { lanes } from "./lanestate.ts";
import { report } from "./lanereport.ts";
import { endLimitEpisodes } from "./limit-alert.ts";
import { alert } from "./outbound.ts";
import { LIMIT_WATCH_MS, setLimitWatch } from "./limit-watch.ts";
import { limitsUsable, main } from "./orchestrator.ts";
import { anthropicUsage, forgetAccountUsage, refreshQuota } from "./providers.ts";
import { omoUnblockAccount } from "./runtime/omo-login.ts";

type Role = "orchestrator" | "lane";
type Session = { liftLimit: () => boolean; limitPaused: () => boolean; limitModel: () => string };
// Swapped by the tests; nothing else reads it.
export const liftEnv = {
	usage: async (role: Role): Promise<{ account: string; omo: boolean; usable: boolean; spentScopes: string[] } | undefined> => {
		const r = await anthropicUsage(role, true).catch(() => {
			// an unreadable report lifts nothing: undefined means "no word"
			return undefined;
		});
		if (!r || r.problem || !r.limits.length) return undefined;
		return { account: r.account, omo: r.via !== "omp", usable: limitsUsable(r.limits), spentScopes: r.limits.filter(l => l.scope && l.amount.remaining < 1).map(l => l.scope!.toLowerCase()) };
	},
	unblock: (account: string): Promise<string> => omoUnblockAccount(account),
	sessions: (): Session[] => [main, ...convs.conversations().map(c => c.o)],
	lanes: { paused: (): number => limitPausedLanes().length, models: limitPausedModels, lift: liftLanePauses },
	// Where each session keeps its saved pause (orchestrator.ts: main's file is DATA_DIR/orchestrator.json, convsessions.ts: <dir>/state.json).
	stateFiles: (): string[] => [join(DATA_DIR, "orchestrator.json"), ...convs.conversations().flatMap(c => (c.dir ? [join(c.dir, "state.json")] : []))],
	// The line goes where the pause alert went: the lane's channel for a lane, the alert conversation otherwise.
	tell: (agent: string, text: string): void => {
		const lane = agent.startsWith("lane:") ? lanes.get(agent.slice(5)) : undefined;
		if (lane) report(lane, text, "pause");
		else alert(`${NAME}: ${text}`);
	},
	refresh: (account?: string): void => {
		if (account) forgetAccountUsage(account);
		void refreshQuota().catch(e => log(`usage refresh failed: ${(e as Error).message}`));
	},
};

// A restart must not read a usage-limit pause again after the lift (orchestrator.ts start()): the saved pause goes. A billing/auth pause stays.
function clearSavedPauses(): number {
	let cleared = 0;
	for (const file of liftEnv.stateFiles()) {
		if (!existsSync(file)) continue;
		try {
			const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			if (typeof s.pausedUntil !== "string" || s.pausedKind === "owner") continue;
			const { pausedUntil: _u, pausedKind: _k, pausedAuth: _a, ...rest } = s;
			writeAtomic(file, `${JSON.stringify(rest, null, 2)}\n`);
			cleared++;
		} catch (e) {
			log(`saved pause in ${file} not cleared: ${(e as Error).message}`);
		}
	}
	return cleared;
}

// `resume` false: the caller restarts the session itself (the owner's 재개), so only the recorded limits are forgotten.
// `spentReset`: the lift is the owner's 리셋권 spent here, which the notice says.
export async function liftUsageLimit(account: string | undefined, why: string, resume = true, spentReset = false): Promise<void> {
	const chain = liftQuotaBlocks();
	const omo = account ? await liftEnv.unblock(account).catch(() => "failed") : "-";
	const sessions = resume ? liftEnv.sessions().filter(s => s.liftLimit()).length : 0;
	const lanes = resume ? liftEnv.lanes.lift() : 0;
	liftEnv.refresh(account);
	const saved = clearSavedPauses();
	// Ending the episode and telling happen in one synchronous step, so the reset path and the usage-report path never both tell it.
	const told = endLimitEpisodes();
	if (told) liftEnv.tell(told, spentReset ? msg().limitLiftedReset : msg().limitLifted);
	log(`usage limit lifted (${why}): chain blocks ${chain}, omo ${omo}, orchestrator sessions ${sessions}, lanes ${lanes}, saved pauses cleared ${saved}, owner ${told ? `told (${told})` : "not told"}`);
}

// Per role: when a lift went out and whether a later tick has seen the session paused again (the try failed). One lift per episode.
const TRY_WINDOW_MS = 2 * 60_000;
const tried = new Map<Role, { at: number; retried: boolean }>();
export const resetLiftMemory = (): void => tried.clear();

// A model-scoped weekly window (7 Day (<model>)) used up keeps the session on that model paused although the unscoped windows are fine:
// it counts as over only when no spent scope belongs to a model a paused session of the role runs. Models unreadable: any spent scope blocks.
// A scope display name can hold several words ("Claude Sonnet 5.5"): it belongs to a model when any word of 3+ letters other than "claude" is in the model id.
// A scope with no such word blocks, like an empty model id.
const scopeWords = (scope: string): string[] =>
	scope.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3 && w !== "claude");
export const scopeBlocksModels = (spent: string[], models: string[]): boolean =>
	spent.some(s => {
		const words = scopeWords(s);
		return !models.length || !words.length || models.some(m => !m || words.some(w => m.toLowerCase().includes(w)));
	});

async function checkRole(role: Role, paused: boolean, resume: boolean, models: string[]): Promise<boolean> {
	const t = tried.get(role);
	if (!paused) {
		if (t && (t.retried || Date.now() - t.at > TRY_WINDOW_MS)) tried.delete(role);
		return false;
	}
	if (t) {
		t.retried = true;
		return false;
	}
	const u = await liftEnv.usage(role);
	if (!u?.usable || scopeBlocksModels(u.spentScopes, models)) return false;
	tried.set(role, { at: Date.now(), retried: false });
	await liftUsageLimit(u.omo ? u.account : undefined, `${role} usage report`, resume);
	return true;
}

// Asks the usage read for the roles that are paused on a usage limit and lifts where the limit is over. True: something was lifted.
export async function checkUsageLimit(resume = true): Promise<boolean> {
	const pausedSessions = liftEnv.sessions().filter(s => s.limitPaused());
	const orch = pausedSessions.length > 0;
	const lanes = resume && liftEnv.lanes.paused() > 0;
	const a = await checkRole("orchestrator", orch, resume, pausedSessions.map(s => s.limitModel()));
	const b = resume ? await checkRole("lane", lanes, resume, liftEnv.lanes.models()) : false;
	return a || b;
}

setLimitWatch({
	paused: () => liftEnv.sessions().filter(s => s.limitPaused()).length + liftEnv.lanes.paused(),
	tick: async () => void (await checkUsageLimit()),
});
export { LIMIT_WATCH_MS };

// The owner's restart button: when the check lifted a usage limit, the session comes back through the same path as 재개 (which also clears
// the saved pause, else the new process would read it and wait again); otherwise a plain restart.
export async function restartChecked(restart: () => unknown, resume: () => unknown): Promise<void> {
	const lifted = await checkUsageLimit(false).catch(() => false);
	if (lifted) resume();
	else restart();
}
