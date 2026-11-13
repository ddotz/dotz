// One session per conversation (hub/convsessions.ts): a message goes to the session of its own conversation, never into another
// conversation's turn; a session over the live cap or idle past the stop time is parked and resumed by its next message. The
// orchestrator is a fake: this file tests the registry's routing and lifecycle, not the agent.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConvSessions, type BgWork, type Conv, type ConvDeps, type Prompts } from "./convsessions.ts";
import type { HubEvent } from "./events.ts";
import { createPrompts } from "./prompts.ts";
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

type Fake = { o: Orchestrator; delivered: string[]; parked: number; applied: number; cancels: number; started(): boolean };

function setup(opts: { on?: boolean; maxLive?: number; idleMin?: number; dir?: string; history?: HubEvent[]; log?: string[]; queue?: Prompts; kindModel?: (key: string) => string | undefined } = {}) {
	const dir = opts.dir ?? tmp();
	let clock = 1_000_000;
	const fakes = new Map<string, Fake>();
	const created: string[] = [];
	const makes = new Map<string, OrchOpts>();
	const delivered: { key: string; text: string; target?: string }[] = [];
	const open = new Map<string, { text: string; replyTo?: string; done?: boolean; cancelled?: boolean }[]>();

	function fake(key: string): Fake {
		let pid: number | undefined;
		const born = clock - 60_000;
		const delivered: string[] = [];
		const f: Fake = {
			delivered,
			parked: 0,
			applied: 0,
			cancels: 0,
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
				cancelByOwner: () => {
					f.cancels++;
					return { running: true, request: true, working: () => false };
				},
				applyModelChange: () => {
					f.applied++;
					return "next-start";
				},
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
			queued: () => open.get(key) ?? [],
			isAnswered: () => false,
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
			makes.set(o.key, o);
			return fake(o.key).o;
		},
		wire: (c: Conv) => ({ queue: opts.queue ?? queue(c.key), bg: { list: () => [], running: () => 0 } as unknown as BgWork }),
		dataDir: dir,
		history: () => opts.history ?? [],
		workers: () => 0,
		workerPin: () => "main-pin",
		kindModel: key => opts.kindModel?.(key),
		log: line => void opts.log?.push(line),
		now: () => clock,
	});
	main();
	function main(): void {
		const f = fake(MAIN);
		registry.setMain({ key: MAIN, o: f.o, queue: queue(MAIN), bg: { list: () => [], running: () => 0 } as unknown as BgWork } as unknown as Parameters<typeof registry.setMain>[0]);
	}
	return { registry, delivered, created, makes, dir, tick: (ms: number) => (clock += ms), now: () => clock, fakes, open };
}

test("an owner message in a mail conversation goes to that conversation's own session, never into main", () => {
	const { registry, delivered, created } = setup();
	expect(registry.keyOf("mail:k1")).toBe("mail:k1");
	registry.deliverTo("mail:k1", "이거 파일 어디감?", { target: "mail:k1", replyTo: "m1", owner: true });
	expect(created).toEqual(["mail:k1"]);
	expect(delivered).toEqual([{ key: "mail:k1", text: "이거 파일 어디감?", target: "mail:k1" }]);
	expect(delivered.some(d => d.key === MAIN)).toBe(false);
});

test("the owner's stop in a conversation with no session reaches no session, never main's; with one it reaches only that one", () => {
	const log: string[] = [];
	const { registry, fakes } = setup({ log });
	expect(registry.cancelFor("mail:k1")).toBeUndefined();
	expect(fakes.get(MAIN)!.cancels).toBe(0);
	registry.deliverTo("mail:k1", "hello", { target: "mail:k1", replyTo: "m1", owner: true });
	expect(registry.cancelFor("mail:k1")?.running).toBe(true);
	expect([fakes.get("mail:k1")!.cancels, fakes.get(MAIN)!.cancels]).toEqual([1, 0]);
	expect(log.filter(line => line.includes("owner stop"))).toHaveLength(1);
});

test("the message that starts a new session stays out of its starting history: its own turn carries it, once", () => {
	const event = (kind: string, text: string, mid?: string): HubEvent => ({ ts: "2026-11-05T06:01:12.336Z", kind, source: "web", text, ...(mid ? { mid } : {}) });
	const history = [event("message", "지난 질문", "m0"), event("out", "지난 답"), event("message", "앞 조각", "m1"), event("message", "한계 부분 수정해", "m2")];
	let startSeed: string | undefined;
	// A real start() reads the seed inside the delivery that spawns the session.
	const q = createPrompts({ deliver: () => (startSeed ??= seed()), steer: () => true, working: () => false, note: (_t, _r, text) => text, isNote: () => false, post: async () => ({ delivered: true }), clearProgress: () => {}, persist: () => {}, log: () => {} });
	const { registry, makes } = setup({ history, queue: q as unknown as Prompts });
	const key = registry.keyOf("web:worklog");
	const seed = () => makes.get(key)!.seed!();
	const inbox = "[dotz inbox] web:worklog msg=m2\n앞 조각\n한계 부분 수정해";
	registry.deliverTo(key, inbox, { target: "web:worklog", replyTo: "m2", refs: ["m1", "m2"], owner: true });
	expect(startSeed).toContain("지난 질문");
	expect(startSeed).not.toContain("앞 조각");
	expect(startSeed).not.toContain("한계 부분 수정해");
	// A fresh session started after a crash mid-turn: the replay carries the message the lost turn was answering.
	q.onPrompt(inbox);
	expect(seed()).not.toContain("한계 부분 수정해");
	q.onAnswer("고쳤어요");
	expect(seed()).toContain("한계 부분 수정해");
});

test("a mail's Discord thread answers in the mail's session, and main keeps the main conversation", () => {
	const { registry } = setup();
	expect(registry.keyOf("th:777")).toBe("mail:k1");
	expect(registry.keyOf("web")).toBe(MAIN);
	expect(registry.keyOf("chat")).toBe(MAIN);
	expect(registry.keyOf("ch:5")).toBe("ch:5");
});

// Owner 2026-11-03: a conversation window answered out of another one's context. What main may be handed (the lane questions
// waiting elsewhere) stays out of a conversation's session, which answers here and nowhere else.
test("a conversation's session is built without the lane questions main carries", () => {
	const { registry, makes } = setup();
	registry.deliverTo("mail:k1", "메일 질문", { target: "mail:k1", replyTo: "m1", owner: true });
	expect(makes.get("mail:k1")!.asks).toBe(false);
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

// 2026-10-28 13:46Z (Mac mini): the alert session hit the account's usage limit with the owner's message still open, and the idle sweep
// parked it 4 minutes before the limit lifted, so nothing ever retried the message.
test("a session that still owes a request, or is paused on a usage limit, is not parked by the idle sweep", () => {
	const { registry, fakes, tick, now, open } = setup({ idleMin: 20 });
	registry.deliverTo("alert", "B 확인이라고만 답해 줘", { target: "web:alert", replyTo: "b1", owner: true });
	const c = registry.get("alert")!;
	open.set("alert", [{ text: "B 확인이라고만 답해 줘", replyTo: "b1" }]);
	fakes.get("alert")!.o.orch.rateLimitedUntil = new Date(now() + 30 * 60_000).toISOString();
	tick(21 * 60_000);
	registry.sweep();
	expect(registry.live(c)).toBe(true);
	open.set("alert", []);
	registry.sweep();
	expect(registry.live(c)).toBe(true);
	tick(10 * 60_000);
	registry.sweep();
	expect(registry.live(c)).toBe(false);
});

// Mac mini 2026-10-29: short of memory, resting sessions held their memory for the whole 20-minute idle time.
test("when the memory cap falls below what runs, the longest-resting sessions are parked at once; one that just answered stays", () => {
	const o = { maxLive: 3 };
	const { registry, tick } = setup(o);
	registry.deliverTo("ch:1", "a", { target: "ch:1", owner: true });
	tick(120_000);
	registry.deliverTo("ch:2", "b", { target: "ch:2", owner: true });
	tick(120_000);
	registry.deliverTo("ch:3", "c", { target: "ch:3", owner: true });
	registry.sweep();
	expect(["ch:1", "ch:2", "ch:3"].map(k => registry.live(registry.get(k)!))).toEqual([true, true, true]);
	o.maxLive = 1;
	registry.sweep();
	expect(["ch:1", "ch:2", "ch:3"].map(k => registry.live(registry.get(k)!))).toEqual([false, false, true]);
});

test("a conversation's own model stays its own, reaches its session alone, and survives a reload", () => {
	const first = setup();
	first.registry.ensure("ch:1");
	first.registry.ensure("ch:2");
	first.registry.setOwnModel("ch:1", "m/own:low");
	expect(first.makes.get("ch:1")!.model!()).toBe("m/own:low");
	expect(first.makes.get("ch:2")!.model!()).toBeUndefined();
	expect(first.fakes.get("ch:1")!.applied).toBe(1);
	expect(first.fakes.get("ch:2")!.applied).toBe(0);
	const pin = join(first.dir, "conv-sessions", "ch_1", "worker-pin");
	expect(readFileSync(pin, "utf8").trim()).toBe("main-pin");
	expect(first.makes.get("ch:1")!.env!.DOTZ_WORKER_PIN_FILE).toBe(pin);
	// Main moved: the one that inherits follows it, the one with its own model does not.
	first.registry.followMain();
	expect(first.fakes.get("ch:1")!.applied).toBe(1);
	expect(first.fakes.get("ch:2")!.applied).toBe(1);

	const again = setup({ dir: first.dir });
	again.registry.restore();
	expect(again.registry.get("ch:1")!.meta.ownModel).toBe("m/own:low");
	expect(again.makes.get("ch:1")!.model!()).toBe("m/own:low");
	expect(again.registry.get("ch:2")!.meta.ownModel).toBeUndefined();
	expect(again.fakes.get("ch:1")!.started()).toBe(false);
	again.registry.setOwnModel("ch:1", undefined);
	expect(existsSync(pin)).toBe(false);
});

// A kind's default model (the mail app's 이 메일에서 쓸 모델): a conversation of that kind starts on it and stays off main's model; its own pick still wins.
test("a mail conversation runs on the mail default, not on main's model; without one it inherits main's; its own pick wins", () => {
	const kind: { mail?: string } = { mail: "m/mail:low" };
	const t = setup({ kindModel: key => (key.startsWith("mail:") ? kind.mail : undefined) });
	for (const key of ["mail:k1", "mail:k2", "ch:1"]) t.registry.ensure(key);
	expect(t.makes.get("mail:k1")!.model!()).toBe("m/mail:low");
	expect(t.makes.get("ch:1")!.model!()).toBeUndefined();
	const pin = (key: string) => join(t.dir, "conv-sessions", key.replace(":", "_"), "worker-pin");
	expect(readFileSync(pin("mail:k1"), "utf8").trim()).toBe("main-pin");
	// Main moved: the mail conversation does not follow, the one with no default does.
	t.registry.followMain();
	expect(t.fakes.get("mail:k1")!.applied).toBe(0);
	expect(t.fakes.get("ch:1")!.applied).toBe(1);
	// A conversation's own pick wins over the default, and a later change of the default leaves it alone.
	t.registry.setOwnModel("mail:k2", "m/own:high");
	kind.mail = "m/other:medium";
	t.registry.followKind("mail");
	expect(t.makes.get("mail:k2")!.model!()).toBe("m/own:high");
	expect(t.fakes.get("mail:k2")!.applied).toBe(1);
	// The inheriting one follows the new default (now, after its turn, or at its next start), and keeps its workers on main's.
	expect(t.makes.get("mail:k1")!.model!()).toBe("m/other:medium");
	expect(t.fakes.get("mail:k1")!.applied).toBe(1);
	// No default any more: it inherits main's again, and the worker pin goes.
	kind.mail = undefined;
	t.registry.followKind("mail");
	expect(t.makes.get("mail:k1")!.model!()).toBeUndefined();
	expect(t.fakes.get("mail:k1")!.applied).toBe(2);
	expect(existsSync(pin("mail:k1"))).toBe(false);
	expect(t.fakes.get("ch:1")!.applied).toBe(1);
});

test("a prompt that names no target goes to the conversation session's own conversation with one log line, main's stays as it is", () => {
	const log: string[] = [];
	const { registry, delivered } = setup({ log });
	registry.deliverTo("mail:k1", "[main session] 이거 확인해 줘", undefined);
	expect(delivered).toEqual([{ key: "mail:k1", text: "[main session] 이거 확인해 줘", target: "mail:k1" }]);
	expect(log.filter(l => l.includes("named no target"))).toEqual(["prompt for mail:k1 named no target; its answer goes to mail:k1"]);
	registry.deliverTo(MAIN, "hello", undefined);
	expect(delivered.at(-1)).toEqual({ key: MAIN, text: "hello", target: undefined });
	expect(log).toHaveLength(1);
});
