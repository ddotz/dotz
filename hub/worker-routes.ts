import { DATA_DIR, orchestratorModel, lanesModel, selectorOf, splitThinking, workerModel } from "./config.ts";
import { shippedRows } from "./effort-points.ts";
import { workerRoutes, type WorkerRoutes } from "./effort-route.ts";
import { loadState } from "./effort-store.ts";
import { lookupModel } from "./lanegates.ts";
import { bareId, capEffort, EFFORT_ORDER, type Effort } from "./model-effort.ts";
import { ownerOnlyModel } from "./model-guard.ts";
import { heldModels } from "./providers.ts";

const providerOf = (model: string): string => model.slice(0, Math.max(0, model.indexOf("/")));

const isEffort = (level: string | undefined): level is Effort => (EFFORT_ORDER as readonly (string | undefined)[]).includes(level);

function onePerModel(models: readonly string[]): string[] {
	const spelled = new Map<string, string>();
	for (const model of models) if (!spelled.has(bareId(model))) spelled.set(bareId(model), model);
	return [...spelled.values()];
}

/**
 * The three routes (light, standard, hard) of a task subagent whose configured worker selector is `anchor`. Candidates are the models of the
 * anchor's provider only, so an API-key anchor never routes back onto the subscription: this install's role models (orchestrator, lanes,
 * workers, lookups; never a fallback entry) and, when the gateway already holds its model list, its listed models. Rows are the shipped
 * ones, else what this install collected for the model. A level above the automatic ceiling (hub/model-effort.ts `capEffort`), the
 * owner-only rules and the listed thinking levels bound which points can route.
 */
export function workerRoutesOf(anchor: string): WorkerRoutes {
	const anchorModel = splitThinking(anchor).model;
	const held = heldModels();
	const provider = providerOf(anchorModel);
	const roleModels = [selectorOf(orchestratorModel()), selectorOf(lanesModel()), workerModel(), lookupModel()].map(s => splitThinking(s).model).filter(m => m.includes("/"));
	const listed = held?.map(m => m.selector) ?? [];
	const levels = new Map(held?.flatMap(m => (m.thinking ? [[m.selector, m.thinking] as const] : [])));
	const collected = loadState(DATA_DIR).entries;
	return workerRoutes({
		anchor,
		candidates: onePerModel([anchorModel, ...[...roleModels, ...listed].filter(m => providerOf(m) === provider)]),
		rowsOf: model => {
			const shipped = shippedRows(model);
			if (shipped.length) return shipped;
			const entry = collected[bareId(model)];
			return entry?.status === "benchmark" ? entry.rows : [];
		},
		ownerOnly: selector => {
			const level = splitThinking(selector).thinking;
			return isEffort(level) && capEffort(level) !== level ? "above the automatic effort ceiling" : ownerOnlyModel(selector);
		},
		...(held ? { levelsOf: (model: string) => levels.get(model) } : {}),
	});
}
