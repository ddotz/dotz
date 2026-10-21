import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as l from "./lanes.ts";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { parkIdleLanes, shouldPark } from "./laneidle.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

class FakeAgent implements AgentProcess {
	pid = 7400;
	sent: string[] = [];
	killed = 0;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {
		this.killed++;
		this.exit.resolve(0);
	};
}
const spawns: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		spawns.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});

const MIN = 60_000;

test("shouldPark: only an idle lane with a process and a session, quiet for the whole period, and never with minutes 0", () => {
	const idle = { name: "x", status: "idle", proc: {} as AgentProcess, sessionFile: "/s.jsonl", lastFrameAt: 1_000 } as const;
	const at = 1_000 + 20 * MIN;
	expect(shouldPark(idle, false, 20, at)).toBe(true);
	expect(shouldPark(idle, false, 20, at - 1)).toBe(false);
	expect(shouldPark(idle, false, 0, at)).toBe(false);
	expect(shouldPark(idle, true, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, status: "working" }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, status: "rate-limited" }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, proc: undefined }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, revive: {} }, false, 20, at)).toBe(false);
	expect(shouldPark({ ...idle, sessionFile: undefined }, false, 20, at)).toBe(false);
});

async function idleLane(name: string): Promise<Lanes.Lane> {
	const cwd = join(DATA, "idle-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	const session = join(DATA, "idle-sessions", `${name}.jsonl`);
	mkdirSync(join(DATA, "idle-sessions"), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	lane.status = "idle";
	lane.lastFrameAt = 1_000_000;
	return lane;
}

test("an idle lane past the period is stopped but stays idle and live; the next message resumes the same session file", async () => {
	const lane = await idleLane("idle-park");
	const agent = lane.proc as unknown as FakeAgent;
	expect(parkIdleLanes(1_000_000 + 19 * MIN, 20)).toEqual([]);
	expect(agent.killed).toBe(0);
	expect(parkIdleLanes(1_000_000 + 20 * MIN, 20)).toContain("idle-park");
	await advance(300);
	await flush();
	expect(agent.killed).toBe(1);
	expect(lane.proc).toBeUndefined();
	expect(lane.status).toBe("idle");
	expect(l.laneRunning(lane)).toBe(true);
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "idle-park", "lane.json"), "utf8"))).toMatchObject({ status: "idle", parked: true, sessionFile: lane.sessionFile });
	const before = spawns.length;
	expect(l.sendToLane("idle-park", "[owner via web] one more tweak")).toBe("resumed");
	expect(spawns.length).toBe(before + 1);
	expect(spawns.at(-1)!.opts.resume).toBe(lane.sessionFile);
	expect(lane.parked).toBeUndefined();
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "idle-park", "lane.json"), "utf8")).parked).toBeUndefined();
	l.stopLane("idle-park");
	await advance(300);
});

test("a working lane is never parked, however long since its last frame", async () => {
	const lane = await idleLane("idle-busy");
	lane.status = "working";
	const agent = lane.proc as unknown as FakeAgent;
	expect(parkIdleLanes(1_000_000 + 600 * MIN, 20)).not.toContain("idle-busy");
	expect(agent.killed).toBe(0);
	l.stopLane("idle-busy");
	await advance(300);
});

test("a gateway restart leaves a parked lane stopped instead of respawning it idle", async () => {
	const lane = await idleLane("idle-restore");
	expect(parkIdleLanes(1_000_000 + 30 * MIN, 20)).toContain("idle-restore");
	await advance(300);
	await flush();
	l.lanes.delete("idle-restore");
	const before = spawns.length;
	l.restoreLanes();
	const back = l.lanes.get("idle-restore")!;
	expect(back.status).toBe("idle");
	expect(back.proc).toBeUndefined();
	expect(spawns.length).toBe(before);
	expect(l.sendToLane("idle-restore", "[owner via web] hi")).toBe("resumed");
	expect(spawns.at(-1)!.opts.resume).toBe(lane.sessionFile);
	l.stopLane("idle-restore");
	await advance(300);
});
