// Quick chat (a second, cheaper conversation session next to main): the session key, the config switch, the registry's routing, the
// model it runs on and the bound on its context. The orchestrator is a fake, as in convsessions.test.ts. New exports are read through a
// namespace so a missing one fails its own test and not the whole file.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "./config.ts";
import { convKindModel } from "./conv-model.ts";
import { createConvSessions, type BgWork, type Conv, type Prompts } from "./convsessions.ts";
import type { HubEvent } from "./events.ts";
import type { Orchestrator, OrchOpts } from "./orchestrator.ts";
import * as sk from "./session-key.ts";
import { CONV_KINDS, MAIN, convTargetOf, primaryTarget, sessionKeyOf } from "./session-key.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "quick-chat-"));
	dirs.push(d);
	return d;
};

const mailOf = (thread: string) => (thread === "111" ? "acme-1" : undefined);

test("the quick key: web:quick answers on its own session only when the feature and quick chat are on", () => {
	expect((sk as { QUICK?: string }).QUICK).toBe("quick");
	expect(sessionKeyOf("web:quick", { on: true, quick: true } as sk.KeyRules)).toBe("quick");
	expect(sessionKeyOf("web:quick", { on: true, quick: false } as sk.KeyRules)).toBe("main");
	expect(sessionKeyOf("web:quick", { on: true })).toBe("main");
	expect(sessionKeyOf("web:quick", { on: false, quick: true } as sk.KeyRules)).toBe("main");
	expect(primaryTarget("quick")).toBe("web:quick");
});

test("quick chat is off by default and changes no other target's key", () => {
	expect((CONV_KINDS as readonly string[]).includes("quick")).toBe(false);
	const rules = { on: true, mailOf, quick: true } as sk.KeyRules;
	const table: [string, string][] = [
		["web", "main"],
		["terminal", "main"],
		["mail:acme-1", "mail:acme-1"],
		["th:111", "mail:acme-1"],
		["th:222", "th:222"],
		["ch:1", "ch:1"],
		["settings:mail-1", "settings:mail-1"],
		["web:alert", "alert"],
		["web:worklog", "worklog"],
		["lane:ktx", "main"],
	];
	for (const [target, key] of table) expect([target, sessionKeyOf(target, rules)]).toEqual([target, key]);
});

test("work made from the quick chat belongs to no conversation, so main runs it", () => {
	expect(convTargetOf({ session: "quick" })).toBeUndefined();
	expect(convTargetOf({ session: "ch:1" })).toBe("ch:1");
});

test("conversations.quick_chat switches quick chat on, and only with conversation sessions on", () => {
	const quickChatIn = (config as { convQuickChatIn?: (c: unknown) => boolean }).convQuickChatIn;
	expect(typeof quickChatIn).toBe("function");
	expect(quickChatIn!({})).toBe(false);
	expect(quickChatIn!({ conversations: {} })).toBe(false);
	expect(quickChatIn!({ conversations: { quick_chat: true } })).toBe(true);
	expect(quickChatIn!({ conversations: { quick_chat: false } })).toBe(false);
	expect(quickChatIn!({ conversations: { quick_chat: true, sessions: false } })).toBe(false);
});

type Fake = { o: Orchestrator; applied: number; started(): boolean };

function setup(opts: { quick?: boolean; dir?: string; history?: HubEvent[]; kindModel?: (dir: string, key: string) => string | undefined } = {}) {
	const dir = opts.dir ?? tmp();
	const clock = 1_000_000;
	const fakes = new Map<string, Fake>();
	const created: string[] = [];
	const makes = new Map<string, OrchOpts>();
	const delivered: { key: string; text: string; target?: string }[] = [];

	function fake(key: string): Fake {
		let pid: number | undefined;
		const f: Fake = {
			applied: 0,
			started: () => pid !== undefined,
			o: {
				orch: { status: "idle", error: undefined, activeModel: "m", ctx: { tokens: 0, compaction: { state: "idle" } }, rateLimitedUntil: "", pauseKind: "rate", stoppedAt: "", stoppedBy: "", startedAt: "" },
				orchestratorPid: () => pid,
				park: () => {
					pid = undefined;
					return true;
				},
				heldCount: () => 0,
				lastTurnEndAt: () => clock - 60_000,
				deliver: () => {
					pid ??= 4242;
					return false;
				},
				steer: () => true,
				applyModelChange: () => {
					f.applied++;
					return "next-start";
				},
			} as unknown as Orchestrator,
		};
		fakes.set(key, f);
		return f;
	}
	const queue = (key: string): Prompts =>
		({
			deliver: (text: string, reply?: { target: string }) => {
				fakes.get(key)!.o.deliver(text);
				delivered.push({ key, text, target: reply?.target });
				return false;
			},
			deferredOpen: () => [],
			queued: () => [],
			isAnswered: () => false,
			current: () => undefined,
			markAnswered: () => undefined,
		}) as unknown as Prompts;

	const registry = createConvSessions({
		on: () => true,
		quick: () => opts.quick ?? false,
		kinds: () => undefined,
		maxLive: () => 3,
		idleMin: () => 20,
		mailOf,
		make: (o: OrchOpts) => {
			created.push(o.key);
			makes.set(o.key, o);
			return fake(o.key).o;
		},
		wire: (c: Conv) => ({ queue: queue(c.key), bg: { list: () => [], running: () => 0 } as unknown as BgWork }),
		dataDir: dir,
		history: () => opts.history ?? [],
		workers: () => 0,
		workerPin: () => "main-pin",
		kindModel: key => opts.kindModel?.(dir, key),
		log: () => undefined,
		now: () => clock,
	} as Parameters<typeof createConvSessions>[0]);
	const main = fake(MAIN);
	registry.setMain({ key: MAIN, o: main.o, queue: queue(MAIN), bg: { list: () => [], running: () => 0 } as unknown as BgWork } as unknown as Parameters<typeof registry.setMain>[0]);
	return { registry, dir, created, makes, delivered, fakes };
}

test("registry: with quick chat on, web:quick has its own key and kind; prompts the gateway starts still land on main", () => {
	const { registry, created, delivered } = setup({ quick: true });
	expect(registry.keyOf("web:quick")).toBe("quick");
	expect(registry.ownKinds()).toContain("quick");
	registry.deliverTo(registry.keyOf("web"), "스케줄이 깨웠어요", { target: "web" });
	registry.deliverTo(registry.keyOf(undefined), "대상 없는 프롬프트");
	registry.deliverTo(registry.keyOf("lane:ktx"), "레인 보고", { target: "lane:ktx" });
	expect(created).toEqual([]);
	expect(delivered.map(d => d.key)).toEqual([MAIN, MAIN, MAIN]);
	registry.deliverTo(registry.keyOf("web:quick"), "가벼운 질문", { target: "web:quick", owner: true });
	expect(created).toEqual(["quick"]);
	expect(delivered.at(-1)).toEqual({ key: "quick", text: "가벼운 질문", target: "web:quick" });
});

test("registry: with quick chat off, web:quick is main's and nothing is created for it", () => {
	const { registry, created, delivered } = setup({ quick: false });
	expect(registry.keyOf("web:quick")).toBe("main");
	expect(registry.ownKinds()).not.toContain("quick");
	registry.deliverTo(registry.keyOf("web:quick"), "가벼운 질문", { target: "web:quick" });
	expect(created).toEqual([]);
	expect(delivered).toEqual([{ key: MAIN, text: "가벼운 질문", target: "web:quick" }]);
});

test("model: quick chat runs on Sonnet 5.5 at high effort unless the owner picked another, and never follows main", () => {
	const pick = "anthropic/claude-opus-5-5:medium";
	const fresh = tmp();
	expect(convKindModel(fresh, "quick")).toMatch(/claude-sonnet-5-5:high$/);
	expect(convKindModel(fresh, MAIN)).toBeUndefined();
	const { registry, makes, fakes } = setup({ quick: true, kindModel: convKindModel });
	expect(registry.kindModel("quick")).toMatch(/claude-sonnet-5-5:high$/);
	registry.ensure("quick");
	const effective = () => makes.get("quick")!.model?.();
	expect(effective()).toMatch(/claude-sonnet-5-5:high$/);
	// Main's model changed: quick chat is told nothing and keeps its model.
	const applied = fakes.get("quick")!.applied;
	registry.followMain();
	expect(fakes.get("quick")!.applied).toBe(applied);
	expect(effective()).toMatch(/claude-sonnet-5-5:high$/);
	// The owner's own pick wins over the default, and survives main's change.
	registry.setOwnModel("quick", pick);
	expect(effective()).toBe(pick);
	registry.followMain();
	expect(effective()).toBe(pick);
	expect(JSON.parse(readFileSync(join(registry.get("quick")!.dir!, "state.json"), "utf8")).ownModel).toBe(pick);
});

test("context bound: a parked quick chat starts again as a new session with the last events as its seed, never on its old session file", () => {
	const old = join(tmp(), "old-session.jsonl");
	writeFileSync(old, "{}\n");
	const history: HubEvent[] = [{ ts: "2026-11-05T06:01:12.336Z", kind: "message", source: "web", text: "지난 질문 표식", mid: "m0" }];
	const { registry, makes, dir } = setup({ quick: true, history });
	const stored = (key: string) => {
		const file = join(dir, "conv-sessions", sk.safeDir(key), "state.json");
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { sessionFile?: string }).sessionFile : undefined;
	};
	// What a running orchestrator keeps in state.json (hub/orchestrator.ts save): the file its next start resumes.
	const remember = (key: string) => {
		const file = join(dir, "conv-sessions", sk.safeDir(key), "state.json");
		mkdirSync(join(dir, "conv-sessions", sk.safeDir(key)), { recursive: true });
		const now = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
		writeFileSync(file, JSON.stringify({ ...now, sessionFile: old }));
	};
	for (const key of ["quick", "ch:1"]) {
		registry.deliverTo(key, "첫 질문", { target: primaryTarget(key), owner: true });
		remember(key);
		registry.park(key);
		registry.deliverTo(key, "다음 질문", { target: primaryTarget(key), owner: true });
	}
	// An ordinary conversation resumes its file; the quick chat is a new session.
	expect(stored("ch:1")).toBe(old);
	expect(stored("quick")).toBeUndefined();
	expect(makes.get("quick")!.seed?.()).toContain("지난 질문 표식");
});
