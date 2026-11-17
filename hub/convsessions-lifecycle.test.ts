import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConvSessions, type BgWork, type Conv, type Prompts } from "./convsessions.ts";
import type { OrchOpts, Orchestrator } from "./orchestrator.ts";
import { advance } from "./runtime/test-clock.ts";
import { MAIN } from "./session-key.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Fake = { o: Orchestrator; held: string[]; sent: string[]; starts: number; stops: number; exit: () => void; alive: () => boolean };

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "convs-life-"));
	dirs.push(dir);
	const fakes = new Map<string, Fake>();
	const log: string[] = [];
	function fake(key: string): Fake {
		let pid: number | undefined;
		let leaving = false;
		const f: Fake = {
			held: [],
			sent: [],
			starts: 0,
			stops: 0,
			exit: () => {
				pid = undefined;
				leaving = false;
			},
			alive: () => pid !== undefined,
			o: {
				orch: { status: "idle", error: undefined, activeModel: "m", ctx: { tokens: 0, compaction: { state: "idle" } }, rateLimitedUntil: "", stoppedBy: "", startedAt: "" },
				orchestratorPid: () => pid,
				park: () => {
					if (pid === undefined) return false;
					leaving = true;
					return true;
				},
				stop: () => {
					f.stops++;
					leaving = true;
				},
				start: () => {
					pid ??= 4242;
					f.starts++;
					f.sent.push(...f.held.splice(0));
				},
				deliver: (text: string) => {
					if (pid === undefined) f.o.start();
					if (leaving) f.held.push(text);
					else f.sent.push(text);
				},
				heldCount: () => f.held.length,
				liveWorkers: () => 0,
				lastTurnEndAt: () => 0,
			} as unknown as Orchestrator,
		};
		fakes.set(key, f);
		return f;
	}
	const queue = (key: string) =>
		({
			deliver: (text: string) => (fakes.get(key)!.o.deliver(text), false),
			deferredOpen: () => [],
			queued: () => [],
			current: () => undefined,
		}) as unknown as Prompts;
	const registry = createConvSessions({
		on: () => true,
		kinds: () => undefined,
		maxLive: () => 3,
		idleMin: () => 20,
		mailOf: () => undefined,
		make: (o: OrchOpts) => fake(o.key).o,
		wire: (c: Conv) => ({ queue: queue(c.key), bg: { list: () => [], running: () => 0 } as unknown as BgWork }),
		dataDir: dir,
		history: () => [],
		workers: () => 0,
		workerPin: () => "pin",
		log: line => void log.push(line),
	});
	const mainFake = fake(MAIN);
	registry.setMain({ key: MAIN, o: mainFake.o, queue: queue(MAIN), bg: { list: () => [], running: () => 0 } as unknown as BgWork } as unknown as Parameters<typeof registry.setMain>[0]);
	return { registry, fakes, dir, log };
}

const reply = { target: "ch:1", owner: true };

test("a message sent between the park and the exit of the process starts the session again, not left held", async () => {
	const { registry, fakes } = setup();
	registry.deliverTo("ch:1", "first", reply);
	const f = fakes.get("ch:1")!;
	registry.park("ch:1");
	registry.deliverTo("ch:1", "while leaving", reply);
	expect(f.held).toEqual(["while leaving"]);
	f.exit();
	await advance(500);
	expect(f.starts).toBe(2);
	expect(f.held).toEqual([]);
	expect(f.sent).toEqual(["first", "while leaving"]);
	expect(registry.stateOf("ch:1")).toBe("live");
});

test("a parked session that holds a prompt with no process is started by the next sweep", () => {
	const { registry, fakes } = setup();
	registry.deliverTo("ch:1", "first", reply);
	const f = fakes.get("ch:1")!;
	registry.park("ch:1");
	f.exit();
	f.held.push("stranded");
	registry.sweep();
	expect(f.starts).toBe(2);
	expect(f.sent).toContain("stranded");
});

test("a session parked with nothing held stays parked after the exit", async () => {
	const { registry, fakes } = setup();
	registry.deliverTo("ch:1", "first", reply);
	const f = fakes.get("ch:1")!;
	registry.park("ch:1");
	f.exit();
	await advance(500);
	registry.sweep();
	expect(f.starts).toBe(1);
	expect(registry.stateOf("ch:1")).toBe("parked");
});

test("deleting a conversation stops its process, waits for the exit, and removes its state and registry entry", async () => {
	const { registry, fakes, dir } = setup();
	registry.deliverTo("ch:1", "first", reply);
	const f = fakes.get("ch:1")!;
	const state = join(dir, "conv-sessions", "ch_1");
	expect(existsSync(state)).toBe(true);
	let done = false;
	const removing = registry.remove("ch:1").then(r => ((done = true), r));
	await advance(300);
	expect(f.stops).toBe(1);
	expect(done).toBe(false);
	expect(existsSync(state)).toBe(true);
	f.exit();
	await advance(300);
	expect(await removing).toBe(true);
	expect(existsSync(state)).toBe(false);
	expect(registry.get("ch:1")).toBeUndefined();
	expect(registry.stateOf("ch:1")).toBe("new");
});

test("deleting a conversation that has no session, or main, deletes nothing", async () => {
	const { registry } = setup();
	expect(await registry.remove("ch:none")).toBe(false);
	expect(await registry.remove(MAIN)).toBe(false);
	expect(registry.get(MAIN)).toBeDefined();
});
