// The expensive-model gate's pieces outside the hooks (extension/guard.ts): the worker model a swapped call gets, and the two
// gateway-owned state files it reads (hub/model-guard.ts writes them): expensive-grants.json and model-picks.json.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir, expensiveMatch, type GuardConfig } from "./guard-config.ts";

// The configured worker model (models.workers in <DOTZ_DIR>/config.json, default as hub/config.ts workerModel()) in OmO's provider names.
const DEFAULT_WORKER_MODEL = "anthropic/claude-sonnet-5-5:high";
const splitLevel = (selector: string): { model: string; thinking?: string } => {
	const i = selector.lastIndexOf(":");
	return i > 0 && /^[a-z]+$/i.test(selector.slice(i + 1)) ? { model: selector.slice(0, i), thinking: selector.slice(i + 1) } : { model: selector };
};
export function workerPin(): string {
	let configured: { model?: unknown; thinking?: unknown } = {};
	try {
		const w = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8"))?.models?.workers;
		if (w && typeof w === "object") configured = w;
	} catch {
		// No readable config: the default worker model.
	}
	const d = splitLevel(DEFAULT_WORKER_MODEL);
	const own = typeof configured.model === "string" && configured.model ? splitLevel(configured.model) : undefined;
	const model = own?.model ?? d.model;
	const thinking = typeof configured.thinking === "string" && configured.thinking ? configured.thinking : own ? own.thinking : d.thinking;
	const mapped = model.startsWith("anthropic/") ? `anthropic-subscription/${model.slice("anthropic/".length)}` : model;
	return thinking ? `${mapped}:${thinking}` : mapped;
}

// Gateway-owned state files, read-only here; re-parsed only when the file changed.
const stateCache = new Map<string, { stamp: string; value: any }>();
function readGatewayState(name: string): any {
	const file = join(dataDir(), "state", name);
	try {
		const s = statSync(file);
		const stamp = `${s.mtimeMs}:${s.size}:${s.ino}`;
		const cached = stateCache.get(file);
		if (cached?.stamp === stamp) return cached.value;
		const value = JSON.parse(readFileSync(file, "utf8"));
		stateCache.set(file, { stamp, value });
		return value;
	} catch {
		stateCache.delete(file);
		return undefined;
	}
}

// A task call under the expensive gate without a grant: an expensive `model` on the call or an item becomes the worker model
// (a category item just drops it: its category profile carries the worker model, and OmO refuses both together).
export function swapExpensiveModels(input: any, g: GuardConfig): boolean {
	let swapped = false;
	const items: any[] = Array.isArray(input?.tasks) ? input.tasks : [];
	for (const holder of [input, ...items]) {
		if (!holder || typeof holder !== "object" || !expensiveMatch(holder.model, g)) continue;
		swapped = true;
		if (holder === input && items.length) {
			delete holder.model;
			for (const item of items) if (item && typeof item === "object" && !item.category && item.model === undefined) item.model = workerPin();
		} else if (holder.category) delete holder.model;
		else holder.model = workerPin();
	}
	return swapped;
}

// The conversation key of this process in expensive-grants.json: DOTZ_CONV, lane:<name>, else main.
const convKey = () => process.env.DOTZ_CONV || (process.env.DOTZ_LANE ? `lane:${process.env.DOTZ_LANE}` : "main");
/** True while the gateway holds a live expensive-model grant for this process's conversation. */
export const grantedHere = (now = Date.now()): boolean => Date.parse(readGatewayState("expensive-grants.json")?.[convKey()]?.until) > now;

/** True when the model now running is the one the owner picked for this process (model-picks.json, by owner or an owner message), effort included when the effort is on the list. */
export function ownerPickedHere(running: unknown, effort: string, g: GuardConfig): boolean {
	const target = process.env.DOTZ_CONV?.startsWith("ch:") ? process.env.DOTZ_CONV : process.env.DOTZ_LANE ? `lane:${process.env.DOTZ_LANE}` : "orchestrator";
	const picks = readGatewayState("model-picks.json");
	const pick = picks?.[target] ?? (target.startsWith("ch:") ? picks?.orchestrator : undefined); // a conversation without its own pick runs main's
	if (!pick || !(pick.by === "owner" || String(pick.by).startsWith("owner-message:"))) return false;
	const bare = (s: unknown) => String(s ?? "").replace(/:[a-z]+$/i, "").split("/").pop();
	if (!bare(pick.model) || bare(pick.model) !== bare(running)) return false;
	return !(expensiveMatch(`:${effort}`, g) && pick.thinking !== effort);
}
