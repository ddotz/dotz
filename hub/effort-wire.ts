// The gateway side of hub/effort-learn.ts: the timer, the real model lists, and what happens once a model's benchmark value is recorded.
// A target (orchestrator, lanes, workers) whose config.json has no `thinking` runs its model at `sweetSpot`, so a new benchmark value reaches
// it with no write: that is the marker for an effort set automatically. Every `thinking` already stored counts as the owner's and is never
// touched. A session that is running keeps its effort unless OmO keeps the prompt cache across an effort change (hub/mid-effort.ts); otherwise
// it takes the new value at its next fresh start.
import { cfg, DATA_DIR, fallbackChain, type FallbackTarget, log, splitThinking } from "./config.ts";
import { collectFromBoard } from "./effort-collect.ts";
import { learnTick } from "./effort-learn.ts";
import { type EffortEntry, learnedOf, loadState } from "./effort-store.ts";
import { midConvoEffort } from "./mid-effort.ts";
import { bareId, useLearned } from "./model-effort.ts";
import { applyModelChange } from "./orchestrator.ts";
import { availableModels } from "./providers.ts";
import { runtimeFor } from "./runtime/index.ts";

const TARGETS: readonly FallbackTarget[] = ["orchestrator", "lanes", "workers"];
const FIRST_TICK_MS = 90_000;
const TICK_MS = 30 * 60_000;

export type ApplyIo = {
	stored: (target: FallbackTarget) => { model?: string; thinking?: string } | undefined;
	cacheSurvives: (model: string) => boolean;
	switchOrchestrator: () => void;
};

/** The targets that now run at the new value (their model is this one and the owner stored no effort); the running orchestrator is switched only when its cache survives the change. */
export function applyLearned(entry: EffortEntry, io: ApplyIo): FallbackTarget[] {
	const following = TARGETS.filter(t => {
		const c = io.stored(t);
		return c?.model !== undefined && c.thinking === undefined && !splitThinking(c.model).thinking && bareId(c.model) === entry.id;
	});
	const orchestrator = io.stored("orchestrator");
	if (following.includes("orchestrator") && orchestrator?.model && io.cacheSurvives(orchestrator.model)) io.switchOrchestrator();
	return following;
}

/** One clause of evidence for the worklog line: the source, the date, the chosen effort's score and cost and the next effort up. */
export function evidenceOf(e: EffortEntry): string {
	const at = e.rows.findIndex(r => r.effort === e.effort);
	const rows = at < 0 ? [] : e.rows.slice(at, at + 2);
	return `${new URL(e.sources[0]!.url).hostname} ${e.at.slice(0, 10)}${rows.map((r, i) => `${i ? ", " : ": "}${r.effort} ${r.score} / $${r.cost}`).join("")}`;
}

const namedModels = (): string[] => TARGETS.flatMap(t => [cfg.models?.[t]?.model, ...fallbackChain(t).map(f => f.model)]).filter((m): m is string => typeof m === "string");

/** Starts the background collection; `enabled` is read at every use, so turning the setting off stops both the fetching and the use of what was learned. */
export function startEffortLearning(o: { enabled: () => boolean; say: (model: string, effort: string, evidence: string) => void }): void {
	let learned = learnedOf(loadState(DATA_DIR)), busy = false;
	useLearned(() => (o.enabled() ? learned : undefined));
	const io: ApplyIo = {
		stored: t => cfg.models?.[t],
		cacheSurvives: model => runtimeFor("orchestrator").id === "omo" && midConvoEffort(model, /(?!)/),
		switchOrchestrator: () => void applyModelChange(),
	};
	const run = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		try {
			await learnTick({
				dir: DATA_DIR,
				enabled: o.enabled,
				listed: async () => (await availableModels()).map(m => m.selector),
				named: namedModels,
				collect: collectFromBoard(),
				now: Date.now,
				learned: e => {
					learned = learnedOf(loadState(DATA_DIR));
					o.say(e.id, e.effort, evidenceOf(e));
					applyLearned(e, io);
				},
			});
			learned = learnedOf(loadState(DATA_DIR));
		} catch (e) {
			log(`effort learning failed: ${(e as Error).message}`);
		} finally {
			busy = false;
		}
	};
	setTimeout(() => void run(), FIRST_TICK_MS);
	setInterval(() => void run(), TICK_MS);
}
