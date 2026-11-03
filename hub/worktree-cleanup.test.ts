// The hourly worktree cleanup asks omp for its worktrees; on an install whose agents run on OmO (no omp binary) it must skip instead of failing.
import { afterEach, expect, test } from "bun:test";
import { cfg } from "./config.ts";
import { runWorktreeCleanup, worktreeCleanupApplies } from "./hygiene.ts";

const saved = { runtime: cfg.runtime, orchestrator: cfg.orchestrator, lanes: cfg.lanes };
afterEach(() => Object.assign(cfg, saved));

const use = (runtime: string, roles: { orchestrator?: string; lanes?: string } = {}) => {
	cfg.runtime = runtime;
	cfg.orchestrator = { ...saved.orchestrator, runtime: roles.orchestrator } as typeof cfg.orchestrator;
	cfg.lanes = { ...saved.lanes, runtime: roles.lanes } as typeof cfg.lanes;
};

test("applies only when a role runs on omp", () => {
	use("omo");
	expect(worktreeCleanupApplies()).toBe(false);
	use("omp");
	expect(worktreeCleanupApplies()).toBe(true);
	use("omo", { lanes: "omp" });
	expect(worktreeCleanupApplies()).toBe(true);
	use("claude");
	expect(worktreeCleanupApplies()).toBe(false);
});

test("an OmO install skips the pass without spawning omp", async () => {
	use("omo");
	expect(await runWorktreeCleanup()).toBe("skipped");
});
