import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { debug } from "./debug.ts";
import { type Fields, fieldsOf } from "./host-types.ts";
import type { FinishedWorker, ProjectState } from "./state.ts";

const SIZE_WINDOW = 10;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const FAMILY_SUFFIX = /(?:\d+|Fix|Retry|Rework)$/;

const kilo = (tokens: number | undefined): string => (tokens === undefined ? "unrecorded" : `${Math.round(tokens / 1000)}K`);

/** The family of a worker name: the CamelCase name without trailing digits and trailing `Fix`, `Retry` or `Rework` (X, X2, XFix -> X); a name that is only such a word stays whole. */
export function familyOf(name: string): string {
	let family = name;
	for (let stripped = family.replace(FAMILY_SUFFIX, ""); stripped !== "" && stripped !== family; stripped = family.replace(FAMILY_SUFFIX, "")) family = stripped;
	return family;
}

function readWorkerSize(path: string): { peak?: number; compacted: boolean } | undefined {
	if (!existsSync(path)) return undefined;
	let text: string;
	try {
		if (statSync(path).size > MAX_SESSION_BYTES) return undefined;
		text = readFileSync(path, "utf8");
	} catch (error) {
		debug({ phase: "worker-size-unreadable", path, message: String(error) });
		return undefined;
	}
	let peak: number | undefined;
	let compacted = false;
	for (const line of text.split("\n")) {
		const isCompaction = line.includes('"type":"compaction"');
		if (!isCompaction && !line.includes('"usage"')) continue;
		let entry: Fields;
		try {
			entry = fieldsOf(JSON.parse(line));
		} catch (error) {
			debug({ phase: "worker-size-bad-line", path, message: String(error) });
			continue;
		}
		if (entry.type === "compaction") compacted = true;
		const message = fieldsOf(entry.message);
		if (message.role !== "assistant") continue;
		const usage = fieldsOf(message.usage);
		const context = [usage.input, usage.cacheRead, usage.cacheWrite].reduce<number>((sum, part) => sum + (typeof part === "number" ? part : 0), 0);
		if (context > 0 && (peak === undefined || context > peak)) peak = context;
	}
	return peak === undefined && !compacted ? undefined : { peak, compacted };
}

/**
 * Records, for every finished worker of `state` (not `running`, not `lost`) that has no size yet, its peak context
 * (largest input + cacheRead + cacheWrite of its assistant messages) and whether it compacted, read from its own session
 * file `<WorkerId>.jsonl` in the artifacts dir of the main session (`sessionFile` without `.jsonl`). The record is
 * also appended to `state.finished`, which outlives the worker record. A worker without a readable session file or
 * without any assistant usage stays unmeasured. Says whether anything was recorded.
 */
export function measureFinishedWorkers(sessionFile: unknown, state: ProjectState): boolean {
	if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl")) return false;
	const dir = sessionFile.slice(0, -".jsonl".length);
	let changed = false;
	for (const [id, worker] of Object.entries(state.workers)) {
		if (worker.status === "running" || worker.status === "lost" || worker.peak !== undefined || worker.compacted !== undefined || id !== basename(id)) continue;
		const size = readWorkerSize(join(dir, `${id}.jsonl`));
		if (!size) continue;
		worker.peak = size.peak;
		worker.compacted = size.compacted;
		state.finished = [...(state.finished ?? []).filter(entry => entry.id !== id), { id, at: Date.now(), items: worker.items, peak: size.peak, compacted: size.compacted }];
		changed = true;
	}
	return changed;
}

/** "N of your last M workers compacted (peak K)" over the last 10 finished workers with a recorded size, or undefined when none of them compacted. */
export function sizeNote(state: ProjectState): string | undefined {
	const recent = (state.finished ?? []).filter(entry => entry.compacted !== undefined).sort((a, b) => a.at - b.at).slice(-SIZE_WINDOW);
	const compacted = recent.filter(entry => entry.compacted);
	if (!compacted.length) return undefined;
	const peaks = compacted.flatMap(entry => (entry.peak === undefined ? [] : [entry.peak]));
	return `${compacted.length} of your last ${recent.length} workers compacted${peaks.length ? ` (peak ${kilo(Math.max(...peaks))})` : ""}`;
}

/** Refuses a spawn named `name` with `items` change items when a finished worker of its family compacted and the brief is not narrower than the narrowest such worker's brief; a compacted worker whose item count was not recorded, or was 0, does not count. */
export function familyProblem(state: ProjectState, name: string, items: number): string | undefined {
	const family = familyOf(name);
	const compacted = (state.finished ?? []).filter((entry): entry is FinishedWorker & { items: number } => entry.compacted === true && entry.items !== undefined && entry.items > 0 && familyOf(entry.id) === family);
	if (!compacted.length) return undefined;
	const narrowest = compacted.reduce((best, entry) => (entry.items < best.items ? entry : best));
	if (items < narrowest.items) return undefined;
	return `orchestrator-guard: worker ${narrowest.id} of the same family (${family}) compacted (peak ${kilo(narrowest.peak)}) on a brief of ${narrowest.items} change items; ${name} lists ${items}. A rework of work that did not fit one context must be smaller: split it, with fewer than ${narrowest.items} change items in this worker and the rest in later ones.`;
}
