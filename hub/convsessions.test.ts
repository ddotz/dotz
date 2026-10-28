// One session per conversation (hub/convsessions.ts): a message goes to the session of its own conversation, never into another
// conversation's turn; a session over the live cap or idle past the stop time is parked and resumed by its next message. The
// orchestrator is a fake: this file tests the registry's routing and lifecycle, not the agent.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConvSessions, type BgWork, type Conv, type ConvDeps, type Prompts } from "./convsessions.ts";
import type { Orchestrator, OrchOpts } from "./orchestrator.ts";
import { MAIN } from "./session-key.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "convs-"));
	dirs.push(d);
	return d;
};

type Fake = { o: Orchestrator; delivered: string[]; parked: number; started(): boolean };

function setup(opts: { on?: boolean; maxLive?: number; idleMin?: number } = {}) {
	const dir = tmp();
	let clock = 1_000_000;
	const fakes = new Map<string, Fake>();
	const created: string[] = [];
	const delivered: { key: string; text: string; target?: string }[] = [];

	function fake(key: string): Fake {
		let pid: number | undefined;
		const born = clock - 60_000;
		const delivered: string[] = [];
		const f: Fake = {
			delivered,
			parked: 0,
			started: () => pid !== undefined,
			o: {
				orch: { status: "idle", error: undefined, activeModel: "m", ctx: { tokens: 0, compaction: { state: "idle" } }, rateLimitedUntil: "", pauseKind: "rate", stoppedAt: "", stoppedBy: "", startedAt: "" },
				orchestratorPid: () => pid,
				park: () => {
					pid = undefined;
					f.parked++;
					return true;
				},
				heldCount: () => 0,
				lastTurnEndAt: () => born,
				deliver: (text: string) => {
					pid ??= 4242;
					delivered.push(text);
					return false;
				},
				steer: () => true,
			} as unknown as Orchestrator,
		};
		fakes.set(key, f);
		return f;
	}

	function queue(key: string): Prompts {
		return {
			deliver: (text: string, reply?: { target: string }) => {
				fakes.get(key)!.o.deliver(text);
				delivered.push({ key, text, target: reply?.target });
				return false;
			},
			deferredOpen: () => [],
			current: () => undefined,
			markAnswered: () => undefined,
			reopen: () => ({ replayed: 0, texts: [] }),
			settleTurn: () => undefined,
			redeliverSteered: () => undefined,
		} as unknown as Prompts;
	}

	const registry = createConvSessions({
		on: () => opts.on ?? true,
		kinds: () => undefined,
		maxLive: () => opts.maxLive ?? 3,
		idleMin: () => opts.idleMin ?? 20,
		mailOf: thread => (thread === "777" ? "k1" : undefined),
		make: (o: OrchOpts) => {
			created.push(o.key);
			return fake(o.key).o;
		},
		wire: (c: Conv) => ({ queue: queue(c.key), bg: { list: () => [], running: () => 0 } as unknown as BgWork }),
		dataDir: dir,
		history: () => [],
		workers: () => 0,
		log: () => {},
		now: () => clock,
	});
	main();
	function main(): void {
		const f = fake(MAIN);
		registry.setMain({ key: MAIN, o: f.o, queue: queue(MAIN), bg: { list: () => [], running: () => 0 } as unknown as BgWork } as unknown as Parameters<typeof registry.setMain>[0]);
	}
	return { registry, delivered, created, dir, tick: (ms: number) => (clock += ms), fakes };
}

test("an owner message in a mail conversation goes to that conversation's own session, never into main", () => {
	const { registry, delivered, created } = setup();
	expect(registry.keyOf("mail:k1")).toBe("mail:k1");
	registry.deliverTo("mail:k1", "이거 파일 어디감?", { target: "mail:k1", replyTo: "m1", owner: true });
	expect(created).toEqual(["mail:k1"]);
	expect(delivered).toEqual([{ key: "mail:k1", text: "이거 파일 어디감?", target: "mail:k1" }]);
	expect(delivered.some(d => d.key === MAIN)).toBe(false);
});

test("a mail's Discord thread answers in the mail's session, and main keeps the main conversation", () => {
	const { registry } = setup();
	expect(registry.keyOf("th:777")).toBe("mail:k1");
	expect(registry.keyOf("web")).toBe(MAIN);
	expect(registry.keyOf("chat")).toBe(MAIN);
	expect(registry.keyOf("ch:5")).toBe("ch:5");
});

test("with the feature off every conversation stays on main and nothing is created", () => {
	const { registry, created } = setup({ on: false });
	for (const t of ["mail:k1", "ch:5", "th:777", "web:alert", "settings:w:x"]) expect(registry.keyOf(t)).toBe(MAIN);
	registry.deliverTo(MAIN, "hello", { target: "mail:k1", owner: true });
	expect(created).toEqual([]);
});

test("an idle session past the stop time is parked, and its next message resumes it", () => {
	const { registry, created, fakes, tick } = setup({ idleMin: 20 });
	registry.deliverTo("ch:5", "first", { target: "ch:5", owner: true });
	const c = registry.get("ch:5")!;
	expect(registry.live(c)).toBe(true);
	registry.sweep();
	expect(registry.live(c)).toBe(true);
	tick(21 * 60_000);
	registry.sweep();
	expect(registry.live(c)).toBe(false);
	expect(c.meta.parked).toBe(true);
	expect(registry.stateOf("ch:5")).toBe("parked");
	registry.deliverTo("ch:5", "again", { target: "ch:5", owner: true });
	expect(registry.stateOf("ch:5")).toBe("live");
	expect(created).toEqual(["ch:5"]);
	expect(fakes.get("ch:5")!.delivered).toEqual(["first", "again"]);
});

test("past the live cap the least recently used session that can stop is parked first", () => {
	const { registry, tick } = setup({ maxLive: 1 });
	registry.deliverTo("ch:1", "a", { target: "ch:1", owner: true });
	const first = registry.get("ch:1")!;
	tick(60_000);
	registry.deliverTo("ch:2", "b", { target: "ch:2", owner: true });
	expect(registry.live(first)).toBe(false);
	expect(registry.live(registry.get("ch:2")!)).toBe(true);
});

test("restoring with the feature off hands every stored session's open prompt to main and clears its file", () => {
	const dir = tmp();
	const sdir = join(dir, "conv-sessions", "mail_k1");
	mkdirSync(sdir, { recursive: true });
	writeFileSync(join(sdir, "state.json"), JSON.stringify({ key: "mail:k1", primary: "mail:k1", aliases: [], createdAt: new Date().toISOString() }));
	writeFileSync(join(sdir, "pending.json"), JSON.stringify([{ text: "open question", at: 1, target: "mail:k1" }]));
	const deps: ConvDeps = {
		on: () => false,
		kinds: () => undefined,
		maxLive: () => 3,
		idleMin: () => 20,
		mailOf: () => undefined,
		make: () => {
			throw new Error("must not create");
		},
		wire: () => {
			throw new Error("must not wire");
		},
		dataDir: dir,
		history: () => [],
		workers: () => 0,
		log: () => {},
		now: () => 1,
	};
	const out = createConvSessions(deps).restore();
	expect(out).toHaveLength(1);
	expect(out[0]!.key).toBe(MAIN);
	expect(out[0]!.pending.map(p => p.text)).toEqual(["open question"]);
	expect(readFileSync(join(sdir, "pending.json"), "utf8").trim()).toBe("[]");
});
