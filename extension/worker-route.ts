import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { debug } from "./guard-debug.ts";

export type Difficulty = "light" | "standard" | "hard";
export type RouteChoice = { selector: string; score?: number; cost?: number };
export type RouteTable = Record<Difficulty, RouteChoice>;

type Item = { name?: unknown; agent?: unknown; effort?: unknown };

const REMEMBERED_MAX = 4096;
type Pending = { name: string; difficulty: Difficulty };
let pending: Pending[] = [];
const letThrough = new Set<string>();
const tables = new Map<string, { stamp: string; table: RouteTable | undefined }>();

const isItem = (v: unknown): v is Item => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function choiceOf(v: unknown): RouteChoice | undefined {
	if (typeof v !== "object" || v === null || !("selector" in v) || typeof v.selector !== "string" || !v.selector) return undefined;
	const score = "score" in v ? v.score : undefined;
	const cost = "cost" in v ? v.cost : undefined;
	return isNumber(score) && isNumber(cost) ? { selector: v.selector, score, cost } : { selector: v.selector };
}

function tableOf(raw: unknown): RouteTable | undefined {
	if (typeof raw !== "object" || raw === null || !("light" in raw) || !("standard" in raw) || !("hard" in raw)) return undefined;
	const [light, standard, hard] = [raw.light, raw.standard, raw.hard].map(choiceOf);
	return light && standard && hard ? { light, standard, hard } : undefined;
}

/** The routes in the file named by DOTZ_WORKER_ROUTES_FILE (written by the gateway at each process spawn), parsed again only when the file changed; a missing or malformed file is no table. */
export function readRoutes(file = process.env.DOTZ_WORKER_ROUTES_FILE): RouteTable | undefined {
	if (!file) return undefined;
	let stamp: string;
	try {
		const s = statSync(file);
		stamp = `${s.mtimeMs}:${s.size}:${s.ino}`;
	} catch (error) {
		tables.delete(file);
		debug({ phase: "worker-routes-missing", file, error: String(error) });
		return undefined;
	}
	const cached = tables.get(file);
	if (cached?.stamp === stamp) return cached.table;
	let table: RouteTable | undefined;
	try {
		table = tableOf(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		debug({ phase: "worker-routes-unreadable", file, error: String(error) });
	}
	if (!table) debug({ phase: "worker-routes-malformed", file });
	tables.set(file, { stamp, table });
	return table;
}

/** The difficulty a task item's `effort` states: lo is light, hi is hard, anything else (omitted, med) is standard. */
export const difficultyOf = (effort: unknown): Difficulty => (effort === "lo" ? "light" : effort === "hi" ? "hard" : "standard");

const taken = (name: string, asked: ReadonlySet<string>): boolean => letThrough.has(name.toLowerCase()) || asked.has(name.toLowerCase());

function freshName(asked: ReadonlySet<string>): string {
	for (;;) {
		const name = `Worker${Math.random().toString(36).slice(2, 8)}`;
		if (!taken(name, asked)) return name;
	}
}

function uniqueName(given: string): string {
	if (!letThrough.has(given.toLowerCase())) return given;
	for (let n = 2; ; n++) {
		const name = `${given}-${n}`;
		if (!letThrough.has(name.toLowerCase())) return name;
	}
}

function remember(name: string, difficulty: Difficulty): void {
	pending.push({ name, difficulty });
	if (pending.length > REMEMBERED_MAX) pending = pending.slice(pending.length - REMEMBERED_MAX);
}

// why(vendor): omp fills its worker-id set from `<id>.md` and `<id>.jsonl` in the session's artifacts folder (the session file's path without `.jsonl`) on its first allocation, so a resumed session already holds the ids of earlier runs (omp@19.1.1 packages/coding-agent/src/task/output-manager.ts)
function idsOnDisk(sessionFile: string | undefined): string[] {
	const folder = sessionFile?.replace(/\.jsonl$/, "");
	if (!folder || folder === sessionFile || !existsSync(folder)) return [];
	try {
		return readdirSync(folder).flatMap(file => (/\.(?:md|jsonl)$/.test(file) ? [file.replace(/\.(?:md|jsonl)$/, "")] : []));
	} catch (error) {
		debug({ phase: "worker-ids-unreadable", folder, error: String(error) });
		return [];
	}
}

/** The session file of a handler's `ctx`, when the host has one: where the ids of a resumed session's earlier workers are found. */
export function sessionFileOf(ctx: unknown): string | undefined {
	if (typeof ctx !== "object" || ctx === null || !("sessionManager" in ctx)) return undefined;
	const manager = ctx.sessionManager;
	if (typeof manager !== "object" || manager === null || !("getSessionFile" in manager) || typeof manager.getSessionFile !== "function") return undefined;
	const file: unknown = manager.getSessionFile();
	return typeof file === "string" && file ? file : undefined;
}

/**
 * Step A, on the input of a `task` call (a `tasks[]` batch or the flat call) once the guard's own edits are done. Every item of every
 * agent loses `effort`, so omp maps no lo/med/hi onto a level itself; a process of the OmO runtime is left alone. With a table (a process whose spawn
 * hook routes) every item also leaves with a name no earlier item of this session has (compared trimmed and case-insensitively; the ids a
 * resumed session left on disk beside `sessionFile` count): a repeat is renamed `<name>-<n>` with the smallest free n >= 2, an item without a
 * name gets a fresh one. omp then allocates exactly that name as the spawn key, and a `task` agent's item (agent omitted counts as `task`)
 * has its difficulty remembered under it, in call order.
 */
export function assignRoutes<T>(input: T, table: RouteTable | undefined, sessionFile?: string): T {
	if (!isItem(input) || process.env.DOTZ_RUNTIME === "omo") return input;
	const all: Item[] = "tasks" in input && Array.isArray(input.tasks) ? input.tasks.filter(isItem) : [input];
	if (table) {
		for (const id of idsOnDisk(sessionFile)) letThrough.add(id.toLowerCase());
		const asked = new Set(all.flatMap(item => (typeof item.name === "string" && item.name.trim() ? [item.name.trim().toLowerCase()] : [])));
		for (const item of all) {
			const given = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
			const name = given ? uniqueName(given) : freshName(asked);
			if (name !== given) item.name = name;
			letThrough.add(name.toLowerCase());
			const agent = typeof item.agent === "string" && item.agent ? item.agent : "task";
			if (agent === "task") remember(name, difficultyOf(item.effort));
		}
	}
	for (const item of all) delete item.effort;
	return input;
}

function noteOf(difficulty: Difficulty, route: RouteChoice): string {
	const cut = route.selector.lastIndexOf(":");
	const model = cut > 0 ? route.selector.slice(0, cut) : route.selector;
	const level = cut > 0 ? ` ${route.selector.slice(cut + 1)}` : "";
	const benchmark = route.score !== undefined && route.cost !== undefined ? ` (${route.score.toFixed(2)} / $${route.cost.toFixed(2)})` : "";
	return `${difficulty}: ${model.slice(model.lastIndexOf("/") + 1)}${level}${benchmark}`;
}

/**
 * Step B, first thing in a `before_subagent_spawn` handler: takes the difficulty remembered for the spawn. omp's `spawnKey` is the id it
 * allocated; in this process that is the name `assignRoutes` let through, so the oldest pending entry named the key is the one. Only when
 * none is, omp added its own `-2`, `-3` to an id from before a restart, so the oldest entry named the key without one trailing `-<n>` is.
 * Only a `task` agent's spawn takes anything. An entry waits as long as its spawn waits in omp's queue; only `REMEMBERED_MAX` evicts.
 */
export function takeDifficulty(event: { agent?: unknown; spawnKey?: unknown; invocationKind?: unknown }): Difficulty | undefined {
	if (event.agent !== "task" || event.invocationKind === "eval" || typeof event.spawnKey !== "string") return undefined;
	const key = event.spawnKey;
	const stem = key.replace(/-\d+$/, "");
	let at = pending.findIndex(p => p.name === key);
	if (at < 0 && stem !== key) at = pending.findIndex(p => p.name === stem);
	if (at < 0) return undefined;
	const [entry] = pending.splice(at, 1);
	return entry?.difficulty;
}

/**
 * Step B, for a spawn no refusal stopped: the route of the difficulty `takeDifficulty` returned, as the worker's model, with a note like
 * `hard: claude-opus-5-5 high (51.84 / $3.46)`, when that route differs from the standard one. `refused` says whether the expensive-model
 * gate would stop a selector now; such a route is not returned. Undefined leaves the spawn on the configured worker level.
 */
export function routeSpawn(difficulty: Difficulty | undefined, table: RouteTable | undefined, refused: (selector: string) => boolean): { model: string; note: string } | undefined {
	if (!difficulty || !table) return undefined;
	const route = table[difficulty];
	if (route.selector === table.standard.selector || refused(route.selector)) return undefined;
	return { model: route.selector, note: noteOf(difficulty, route) };
}

/** Test only: forgets every remembered item and every name let through. */
export function forgetRoutes(): void {
	pending = [];
	letThrough.clear();
}
