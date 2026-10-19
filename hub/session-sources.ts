// Session files of both runtimes for the token audits (the gateway's nightly hub/token-audit.ts and the /token-audit
// command in extension/token-audit.ts). No config import, so the agent-side extension can load it.
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Runtime = "omp" | "omo";
export type Src = { file: string; label: string; child: boolean; runtime: Runtime; requested?: string };
export type Words = { orchestrator: string; lane: string; worker: string };
export type SourceOptions = { home: string; dataDir: string; roots?: { dir: string; runtime: Runtime }[]; omoStores?: string | false; words?: Words };

const KO: Words = { orchestrator: "오케스트레이터", lane: "레인", worker: "워커" };
const SKIP_DIRS = ["resident-blobs", "extensions", "session-holders"];
// OmO events that start a turn without the owner (a task completion, a monitor line, a goal continuation). Bookkeeping
// entries OmO writes around every turn (todo state, oauth binding, rules scan) do not count as a wake.
export const OMO_WAKE = new Set(["goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-codemode:notification", "senpi-terminal:notification"]);

// OmO keeps task workers outside the session tree, in the task stores this file lists (<store>/children/<id>/sessions/<id>/).
export const defaultRoots = (home: string): { dir: string; runtime: Runtime }[] => [
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
			out.push({ file: p, child, runtime, label: `${child ? `${project} ${words.worker} ${e.name.replace(/\.jsonl$/, "")}` : `${project} ${id}`} [${tag(runtime)}]` });
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
			for (const f of files) out.push({ file: join(dir, f), child: true, runtime: "omo", label: `task:${name} (${tid}) [OmO]`, ...(rq?.model_id ? { requested: `${rq.provider}/${rq.model_id}` } : {}) });
		}
	}
	return out;
}
