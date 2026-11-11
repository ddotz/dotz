// Session files of both runtimes for the token audits (the gateway's nightly hub/token-audit.ts and the /token-audit
// command in extension/token-audit.ts). No config import, so the agent-side extension can load it.
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Runtime = "omp" | "omo";
// target: the model target the session runs on (orchestrator | lane:<name>), for a worker its parent's; parent: an OmO task worker's parent session id.
export type Src = { file: string; label: string; child: boolean; runtime: Runtime; requested?: string; target?: string; parent?: string };
export type Words = { orchestrator: string; lane: string; worker: string };
type SourceOptions = { home: string; dataDir: string; roots?: { dir: string; runtime: Runtime }[]; omoStores?: string | false; words?: Words };

const KO: Words = { orchestrator: "오케스트레이터", lane: "레인", worker: "워커" };
const SKIP_DIRS = ["resident-blobs", "extensions", "session-holders"];
// OmO events that start a turn without the owner (a task completion, a monitor line, a goal continuation). Bookkeeping
// entries OmO writes around every turn (todo state, oauth binding, rules scan) do not count as a wake.
export const OMO_WAKE = new Set(["goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-codemode:notification", "senpi-terminal:notification"]);

// OmO keeps task workers outside the session tree, in the task stores this file lists (<store>/children/<id>/sessions/<id>/).
const defaultRoots = (home: string): { dir: string; runtime: Runtime }[] => [
	{ dir: join(home, ".omo", "agent", "sessions"), runtime: "omo" },
	{ dir: join(home, ".omp", "agent", "sessions"), runtime: "omp" },
];

// A session folder is named after the cwd: omp "-<home-relative path with / as ->" (absolute outside home "--<path>--"),
// OmO always "--<absolute path>--".
export function projectLabel(dir: string, home: string, dataDir: string, words: Words = KO): string {
	const name = dir.replace(/(?<=.)--$/, "");
	for (const orch of [`-${relative(home, dataDir).replace(/\//g, "-")}`, `-${dataDir.replace(/\//g, "-")}`]) {
		if (name === orch) return words.orchestrator;
		const lane = name.match(new RegExp(`^${orch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-lanes-(.+)-worktree$`));
		if (lane) return `${words.lane} ${lane[1]}`;
	}
	if (dir.startsWith("--")) return `/${dir.replace(/^--|--$/g, "").replace(/-/g, "/")}`;
	return `~/${dir.replace(/^-/, "")}`;
}
// The same folder as a model target (hub/model-guard.ts model-picks.json keys), undefined outside dotz's own folders.
const targetOf = (dir: string, home: string, dataDir: string): string | undefined => {
	const label = projectLabel(dir, home, dataDir, { orchestrator: "\0o", lane: "\0l", worker: "" });
	return label === "\0o" ? "orchestrator" : label.startsWith("\0l ") ? `lane:${label.slice(3)}` : undefined;
};

export function collectSessions(since: number, opts: SourceOptions): Src[] {
	const words = opts.words ?? KO;
	const out: Src[] = [];
	const fresh = (p: string) => {
		try {
			return statSync(p).mtimeMs >= since;
		} catch {
			return false;
		}
	};
	const tag = (runtime: Runtime) => (runtime === "omo" ? "OmO" : "omp");
	const walk = (root: string, runtime: Runtime, dir: string, depth: number) => {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (depth > 0 && !e.name.endsWith("-artifacts") && !SKIP_DIRS.includes(e.name)) walk(root, runtime, p, depth - 1);
				continue;
			}
			if (!e.name.endsWith(".jsonl") || !fresh(p)) continue;
			const parts = relative(root, p).split("/");
			const project = projectLabel(parts[0], opts.home, opts.dataDir, words);
			const child = parts.length >= 3;
			const id = e.name.match(/_([0-9a-f]{8})/)?.[1] ?? e.name.replace(/\.jsonl$/, "");
			const target = targetOf(parts[0], opts.home, opts.dataDir);
			out.push({ file: p, child, runtime, label: `${child ? `${project} ${words.worker} ${e.name.replace(/\.jsonl$/, "")}` : `${project} ${id}`} [${tag(runtime)}]`, ...(target ? { target } : {}) });
		}
	};
	for (const r of opts.roots ?? defaultRoots(opts.home)) walk(r.dir, r.runtime, r.dir, 3);
	let stores: string[] = [];
	if (opts.omoStores !== false) try {
		stores = Object.keys(JSON.parse(readFileSync(opts.omoStores ?? join(opts.home, ".omo", "agent", "rpc", "task-stores.json"), "utf8")).stores ?? {});
	} catch {}
	for (const store of stores) {
		const children = join(store, "children");
		if (!existsSync(children)) continue;
		for (const tid of readdirSync(children)) {
			const dir = join(children, tid, "sessions", tid);
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter(f => f.endsWith(".jsonl") && fresh(join(dir, f)));
			} catch {
				continue;
			}
			let t: Record<string, any> = {};
			try {
				t = JSON.parse(readFileSync(join(store, "tasks", `${tid}.json`), "utf8"));
			} catch {}
			const name = t.name && t.name !== tid ? String(t.name) : String(t.task_summary ?? tid).slice(0, 40);
			const rq = t.requested_model;
			const parent = typeof t.parent_session_id === "string" ? { parent: t.parent_session_id } : {};
			for (const f of files) out.push({ file: join(dir, f), child: true, runtime: "omo", label: `task:${name} (${tid}) [OmO]`, ...(rq?.model_id ? { requested: `${rq.provider}/${rq.model_id}` } : {}), ...parent });
		}
	}
	return out;
}

// What a session scan adds up per turn, shared by the nightly audit (hub/token-audit.ts) and the /token-audit command (extension/token-audit.ts).
export type Tally = {
	start?: number; turns: number; tokens: number; cost: number; cw: number; cr: number; out: number; maxCtx: number;
	wakes: Record<string, { n: number; tokens: number; cost: number }>;
	bigTokens: number; bigCost: number; maxBigStreak: number;
	loopTokens: number; loopCost: number; maxToolStreak: number; maxToolDesc: string;
};
// Streaks that run across the turns of one session file.
export type Streaks = { big: number; hash: string; tool: number };
export const newStreaks = (): Streaks => ({ big: 0, hash: "", tool: 0 });

export function addTurn(s: Tally, ts: number, t: { tokens: number; cost: number; cw: number; cr: number; out: number; ctx: number }): void {
	s.start ??= ts;
	s.turns++;
	s.tokens += t.tokens;
	s.cost += t.cost;
	s.cw += t.cw;
	s.cr += t.cr;
	s.out += t.out;
	s.maxCtx = Math.max(s.maxCtx, t.ctx);
}

// An idle wake: a turn started by notifications only. Counted under the last event that woke it.
export function addWake(s: Tally, key: string, tokens: number, cost: number): void {
	const w = (s.wakes[key] ??= { n: 0, tokens: 0, cost: 0 });
	w.n++;
	w.tokens += tokens;
	w.cost += cost;
}

// Turns whose context is over `bigCtx`, and the longest run of them.
export function addBigContext(s: Tally, run: Streaks, ctx: number, bigCtx: number, tokens: number, cost: number): void {
	if (ctx > bigCtx) {
		run.big++;
		s.bigTokens += tokens;
		s.bigCost += cost;
		s.maxBigStreak = Math.max(s.maxBigStreak, run.big);
	} else run.big = 0;
}

// The same tool call with the same arguments again and again: from the third in a row its share of the turn is loop cost.
export function addToolCalls(s: Tally, run: Streaks, calls: { name?: string; arguments?: unknown }[], tokens: number, cost: number): void {
	for (const call of calls) {
		const hash = `${call.name}${JSON.stringify(call.arguments ?? {}).slice(0, 4000)}`;
		if (hash === run.hash) {
			run.tool++;
			if (run.tool >= 3) {
				s.loopTokens += tokens / calls.length;
				s.loopCost += cost / calls.length;
			}
			if (run.tool > s.maxToolStreak) {
				s.maxToolStreak = run.tool;
				s.maxToolDesc = `${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 90)}`;
			}
		} else {
			run.hash = hash;
			run.tool = 1;
		}
	}
}
