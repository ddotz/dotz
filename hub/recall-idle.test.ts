import { describe, expect, test } from "bun:test";
import { createRecallIdle, type Child, type IdleDeps } from "./recall-idle.ts";

const MIN = 60_000;

function rig(busy: string[] = []) {
	const state = { now: 1_000_000, busy, logs: [] as string[], spawned: [] as { argv: string[]; env: Record<string, string>; killAfter: number }[], niced: [] as [number, number][], children: [] as ((code: number) => void)[] };
	const deps: IdleDeps = {
		busy: () => state.busy,
		now: () => state.now,
		log: line => void state.logs.push(line),
		nice: (pid, level) => void state.niced.push([pid, level]),
		argv: ["bun", "recall-cli.ts", "refresh", "--budget-ms", "20000"],
		dataDir: "/data",
		spawn: (argv, env, killAfter) => {
			state.spawned.push({ argv, env, killAfter });
			let end: (code: number) => void = () => {};
			const exited = new Promise<number>(r => (end = r));
			state.children.push(end);
			return { pid: 100 + state.spawned.length, exited } satisfies Child;
		},
	};
	const idle = createRecallIdle(deps);
	// A child ends, and its exit handler has run once the returned promise settles.
	const finish = async (code = 0) => {
		const end = state.children.at(-1);
		end?.(code);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { state, idle, finish, deps };
}

describe("idle indexing gate", () => {
	test("starts one refresh with the budget, the data dir, low priority and a 15-minute hard kill", () => {
		const { state, idle } = rig();
		expect(idle.tick()).toBe("started");
		expect(state.spawned).toEqual([{ argv: ["bun", "recall-cli.ts", "refresh", "--budget-ms", "20000"], env: { DOTZ_DIR: "/data" }, killAfter: 15 * MIN }]);
		expect(state.niced).toEqual([[101, 15]]);
	});

	test("a run still going is never doubled", async () => {
		const { state, idle, finish } = rig();
		idle.tick();
		state.now += 5 * MIN;
		expect(idle.tick()).toBe("running");
		expect(state.spawned.length).toBe(1);
		await finish();
		expect(idle.tick()).toBe("started");
		expect(state.spawned.length).toBe(2);
	});

	test("a busy session skips the run, until the last run is over an hour old", () => {
		const { state, idle } = rig(["orchestrator turn"]);
		state.now += 5 * MIN;
		expect(idle.tick()).toBe("busy");
		state.now += 55 * MIN;
		expect(idle.tick()).toBe("busy");
		state.now += 1;
		expect(idle.tick()).toBe("started");
	});

	test("the hour counts from the end of the last run", async () => {
		const { state, idle, finish } = rig();
		idle.tick();
		state.now += 10 * MIN;
		await finish();
		state.busy = ["lane x"];
		state.now += 30 * MIN;
		expect(idle.tick()).toBe("busy");
		state.now += 31 * MIN;
		expect(idle.tick()).toBe("started");
	});

	test("a failing child logs one line and the next tick starts again", async () => {
		const { state, idle, finish } = rig();
		idle.tick();
		await finish(3);
		expect(state.logs).toEqual(["recall indexing: refresh exited 3"]);
		expect(idle.tick()).toBe("started");
		await finish(0);
		expect(state.logs.length).toBe(1);
	});

	test("a child that cannot start, or whose exit promise rejects, is logged and does not wedge the gate", async () => {
		const { state, deps } = rig();
		let throwing = true;
		const idle = createRecallIdle({ ...deps, spawn: (argv, env, k) => { if (throwing) throw new Error("no bun"); return deps.spawn(argv, env, k); } }, state.now);
		idle.tick();
		expect(state.logs[0]).toContain("could not start refresh: Error: no bun");
		throwing = false;
		expect(idle.tick()).toBe("started");
	});

	test("a priority change that fails is logged and the run goes on", () => {
		const { state, deps } = rig();
		const idle = createRecallIdle({ ...deps, nice: () => { throw new Error("EPERM"); } }, state.now);
		expect(idle.tick()).toBe("started");
		expect(state.logs[0]).toContain("could not lower priority");
		expect(state.spawned.length).toBe(1);
	});
});
