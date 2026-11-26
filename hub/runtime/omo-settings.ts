// The OmO files dotz keeps in step: the orchestrator's compaction tail, and the Claude-login models OmO's catalog lacks.
// The orchestrator's compaction tail. OmO reads `compaction.keepRecentTokens` (default 20000) from the global settings.json
// or from <cwd>/.omo/settings.json, and reads the project file only when the project is trusted; the gateway starts the
// orchestrator with --approve (omo.ts), which keeps the data folder exactly as trusted as it is without the file.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DEFAULTS, log, writeAtomic } from "../config.ts";

export const ORCH_KEEP_RECENT_MIN = 5_000;

// orchestrator.keep_recent in OmO's token estimate (4 characters per token); a missing or invalid value is the default, a small one is raised.
export function orchestratorKeepRecent(): number {
	const v = cfg.orchestrator?.keep_recent;
	return Math.max(ORCH_KEEP_RECENT_MIN, typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULTS.orch_keep_recent);
}

// Sets compaction.keepRecentTokens in <cwd>/.omo/settings.json, keeping every other key; writes only when the value differs.
// A file that is not a JSON object is left alone. Returns true when the file was written.
export function syncKeepRecent(cwd: string, value = orchestratorKeepRecent()): boolean {
	const file = join(cwd, ".omo", "settings.json");
	let doc: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		doc = parsed as Record<string, unknown>;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			log(`omo project settings left alone (${file}): ${(e as Error).message}`);
			return false;
		}
	}
	const compaction = doc.compaction && typeof doc.compaction === "object" && !Array.isArray(doc.compaction) ? (doc.compaction as Record<string, unknown>) : {};
	if (compaction.keepRecentTokens === value) return false;
	mkdirSync(join(cwd, ".omo"), { recursive: true });
	writeAtomic(file, `${JSON.stringify({ ...doc, compaction: { ...compaction, keepRecentTokens: value } }, null, 2)}\n`);
	return true;
}

// OmO's bundled catalog for the Claude login (`anthropic-subscription`) has no Mythos models, so they never reach a model picker.
// OmO takes extra models from <agent dir>/models.json; these entries are complete (an entry without `api` stops OmO loading any
// model, for every provider: MacBook 2026-11-25). Costs and limits are omp's Anthropic catalog rows (read 2026-11-26); the shape is
// the Claude-login entry that ran claude-mythos-5-2. supportsMidConvoEffort follows those rows' supportsPerMessageEffort.
const subscriptionModel = (id: string, name: string, cost: [input: number, output: number, cacheRead: number, cacheWrite: number], midConvoEffort: boolean) => ({
	id,
	name,
	api: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: cost[3] },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	compat: { forceAdaptiveThinking: true, supportsStrictTools: true, supportsTemperature: false, ...(midConvoEffort ? { supportsMidConvoEffort: true } : {}) },
});
export const SUBSCRIPTION_MODELS = [
	subscriptionModel("claude-mythos-5", "Claude Mythos 5", [10, 50, 1, 12.5], false),
	subscriptionModel("claude-mythos-5-1", "Claude Mythos 5.1", [10, 50, 0.25, 12.5], true),
	subscriptionModel("claude-mythos-5-2", "Claude Mythos 5.2", [8, 40, 0.2, 10], true),
];
const SUBSCRIPTION = "anthropic-subscription";
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Adds to <agentDir>/models.json each SUBSCRIPTION_MODELS entry that neither OmO's catalog (`table`: `omo --list-models` output) nor
// the file has, when OmO holds the Claude login (`auth` is its auth.json). Every entry already in the file stays as written; a file
// that is not a JSON object of that shape is left alone. Returns the ids it added; the write moves the file's mtime, which is in the
// model list's cache stamp (hub/providers.ts modelsStamp), so the next list read shows them.
export function syncSubscriptionModels(agentDir: string, auth: Record<string, unknown> | undefined, table: string): string[] {
	if (!auth || !(SUBSCRIPTION in auth)) return [];
	const listed = new Set(table.split("\n").flatMap(line => { const [provider, model] = line.trim().split(/\s+/); return provider === SUBSCRIPTION && model ? [model] : []; }));
	const file = join(agentDir, "models.json");
	let doc: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isObject(parsed)) throw new Error("not an object");
		doc = parsed;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			log(`omo models.json left alone (${file}): ${(e as Error).message}`);
			return [];
		}
	}
	const providers = doc.providers ?? {};
	const provider = isObject(providers) ? (providers[SUBSCRIPTION] ?? {}) : undefined;
	const models = isObject(provider) ? (provider.models ?? []) : undefined;
	if (!isObject(providers) || !isObject(provider) || !Array.isArray(models)) {
		log(`omo models.json left alone (${file}): providers.${SUBSCRIPTION}.models is not a list`);
		return [];
	}
	const have = new Set(models.map(m => (isObject(m) ? m.id : undefined)));
	const add = SUBSCRIPTION_MODELS.filter(m => !listed.has(m.id) && !have.has(m.id));
	if (!add.length) return [];
	mkdirSync(agentDir, { recursive: true });
	writeAtomic(file, `${JSON.stringify({ ...doc, providers: { ...providers, [SUBSCRIPTION]: { ...provider, models: [...models, ...add] } } }, null, 2)}\n`);
	log(`omo models.json: added ${add.map(m => m.id).join(", ")} for the Claude login`);
	return add.map(m => m.id);
}

/** OmO's model table (`list`: `omo --list-models`), read once more when syncSubscriptionModels just added models, so the first list already shows them. */
export async function listWithSubscriptionModels(agentDir: string, auth: Record<string, unknown> | undefined, list: () => Promise<string | undefined>): Promise<string | undefined> {
	const table = await list();
	if (table === undefined || !syncSubscriptionModels(agentDir, auth, table).length) return table;
	return (await list()) ?? table;
}
