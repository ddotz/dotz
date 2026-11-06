// Context search, idle indexing (docs: recall-cli.ts refresh). Every 5 minutes the gateway starts `recall-cli.ts refresh` as a child at low
// priority and goes on; the gateway itself loads no ONNX runtime and opens no index. A run is skipped while one is still going, and
// while any session is busy unless the last run ended over an hour ago, so busy sessions cannot starve it. Clock, spawn and busy are injected.
import { setPriority } from "node:os";
import { join } from "node:path";
import { DATA_DIR, log } from "./config.ts";
import { bunBin } from "./recall-embed.ts";
import { trackTimer } from "./shutdown.ts";

const EVERY_MS = 5 * 60_000;
const STARVED_MS = 3600_000;
const BUDGET_MS = 20_000;
const KILL_AFTER_MS = 15 * 60_000;
const NICE = 15;
const CLI = join(import.meta.dir, "recall-cli.ts");

export interface Child { readonly pid: number; readonly exited: Promise<number> }
export interface IdleDeps {
	readonly busy: () => readonly string[];
	readonly spawn: (argv: string[], env: Record<string, string>, killAfterMs: number) => Child;
	readonly now: () => number;
	readonly log: (line: string) => void;
	readonly nice: (pid: number, level: number) => void;
	readonly argv: readonly string[];
	readonly dataDir: string;
}
export type Tick = "started" | "running" | "busy";

export function createRecallIdle(deps: IdleDeps, startedAt: number = deps.now()): { tick(): Tick } {
	let running = false;
	let lastEnd = startedAt;
	return {
		tick() {
			if (running) return "running";
			if (deps.busy().length > 0 && deps.now() - lastEnd <= STARVED_MS) return "busy";
			running = true;
			const finish = (note?: string) => {
				running = false;
				lastEnd = deps.now();
				if (note) deps.log(note);
			};
			try {
				const child = deps.spawn([...deps.argv], { DOTZ_DIR: deps.dataDir }, KILL_AFTER_MS);
				try {
					deps.nice(child.pid, NICE);
				} catch (e) {
					deps.log(`recall indexing: could not lower priority: ${e}`);
				}
				void child.exited.then(code => finish(code === 0 ? undefined : `recall indexing: refresh exited ${code}`), e => finish(`recall indexing: refresh failed: ${e}`));
			} catch (e) {
				finish(`recall indexing: could not start refresh: ${e}`);
			}
			return "started";
		},
	};
}

function realSpawn(argv: string[], env: Record<string, string>, killAfterMs: number): Child {
	const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, ...env }, timeout: killAfterMs });
	return { pid: p.pid, exited: p.exited };
}

export function startRecallIndexing(opts: { busy: () => readonly string[] }): void {
	const idle = createRecallIdle({
		busy: opts.busy, spawn: realSpawn, now: Date.now, log, nice: setPriority, dataDir: DATA_DIR,
		argv: [bunBin(), CLI, "refresh", "--budget-ms", String(BUDGET_MS)],
	});
	trackTimer("recall indexing", setTimeout(() => {
		idle.tick();
		trackTimer("recall indexing", setInterval(() => void idle.tick(), EVERY_MS));
	}, EVERY_MS));
}
