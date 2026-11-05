// A whole-suite `bun test` takes the machine-wide heavy slot (hub/heavyslot.ts) before it starts, from the test preload, so a plain
// `bun test`, `bun test --parallel=4` or `bun run test` from any session waits its turn instead of fighting the other sessions' runs for
// CPU and the macOS daemons every WebView wakes. It waits, it does not refuse: the caller just sees the run start later. A run of a few
// named files stays free. Only node builtins and heavyslot.ts, and it must run before the preload installs the fake clock.
// The preload does not run in the process that got the command line: a plain run loads it in that one process, a --parallel run loads
// it in each worker (BUN_TEST_WORKER_ID) and not in the coordinator, whose command line is read from the process table.
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireHeavySlot } from "../heavyslot.ts";

// Flags whose value is the next argument (the others take --flag=value or none).
const VALUE_FLAGS = new Set(["-t", "--test-name-pattern", "--timeout", "--rerun-each", "--retry", "--seed", "--reporter", "--reporter-outfile", "--max-concurrency", "--path-ignore-patterns", "--shard", "--timings", "--changed", "--coverage-reporter", "--coverage-dir", "--bail", "--parallel-delay", "--preload", "-r", "--config", "-c"]);
const FEW_FILES = 20;
// A wait stays shorter than a caller's own timeout: a run killed while waiting would only be started again. Past it the run goes ahead.
const WAIT_MS = 5 * 60_000;

// True when the command line (["bun", "test", ...args]) starts a run of many files: no file argument at all, a directory or name filter, or many files.
export function isFullSuite(words: string[]): boolean {
	const args = words.slice(1);
	if (args[0] !== "test" || args.includes("--test-worker")) return false;
	const named: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--") continue;
		if (a.startsWith("-")) {
			if (VALUE_FLAGS.has(a)) i++;
			continue;
		}
		named.push(a);
	}
	return named.length === 0 || named.length > FEW_FILES || named.some(n => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(n));
}

const commandLine = (pid: number): string[] => Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)]).stdout.toString().trim().split(/\s+/);

// Takes the slot for a whole-suite run. The run is one holder, named by the pid of the process that was started (the coordinator for the
// workers of a --parallel run), so every worker of that run counts as the holder and a killed run leaves a slot the next waiter reclaims.
// `env.DOTZ_HEAVY_HELD` is set by hub/receipts.ts, which already holds a slot for the command it runs.
export async function takeSuiteSlot(env: Record<string, string | undefined>): Promise<void> {
	const worker = env.BUN_TEST_WORKER_ID !== undefined;
	const run = worker ? process.ppid : process.pid;
	// Decided once per run: a --isolate worker loads the preload again for every file. The run's pid is part of the value, so a
	// `bun test` that a test starts (which inherits the variable) decides for itself.
	const decided = env.TEST_SLOT_DECISION?.split(":");
	if (decided?.[0] !== String(run)) env.TEST_SLOT_DECISION = `${run}:${!env.DOTZ_HEAVY_HELD && isFullSuite(commandLine(run)) ? "full" : "free"}`;
	if (env.TEST_SLOT_DECISION!.split(":")[1] !== "full") return;
	const slot = await acquireHeavySlot({
		dir: join(env.DOTZ_DIR ?? join(homedir(), ".dotz"), "heavy"),
		label: `${process.cwd()}: ${commandLine(run).join(" ")}`.slice(0, 120),
		slots: 1,
		timeoutMs: WAIT_MS,
		pid: run,
		onWait: heldBy => console.error(`[dotz] another full test run holds the heavy slot (${heldBy.slice(0, 80)}); waiting for it before starting`),
	});
	// A --isolate worker comes back here for every file, and the wait must not repeat.
	if (slot.note) {
		env.TEST_SLOT_DECISION = `${run}:free`;
		console.error(`[dotz] ${slot.note}`);
	}
	if (!worker) process.on("exit", slot.release);
}
