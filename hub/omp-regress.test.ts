import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEventActivity, endSubagents } from "./activity.ts";
import { cancelLaneWorker, STALL_IDLE_MS } from "./bgwork.ts";
import { cfg, HUB_TOKEN } from "./config.ts";
import { convWorkers, convs } from "./convsessions.ts";
import { type Lane, laneJobs, lanes } from "./lanes.ts";
import "./outbound.ts";
import { makeRoute } from "./routes.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SubagentUpdate } from "./runtime/types.ts";

type Frame = Record<string, any>;
type Wire = { proc: AgentProcess; written: string[]; feed(frame: Frame): Promise<void> };

const patchable = Bun as unknown as { spawn: unknown };
const lines = (await Bun.file(join(import.meta.dir, "runtime", "fixtures", "omp-rpc.jsonl")).text()).split("\n").filter(Boolean);
const recorded = lines.slice(lines.findIndex(l => l.startsWith('{"type":"ready"'))).map(l => JSON.parse(l) as Frame);

const wires: Wire[] = [];
function openWire(): Wire {
	let out!: ReadableStreamDefaultController<Uint8Array>;
	const written: string[] = [];
	const realSpawn = Bun.spawn;
	patchable.spawn = () => ({ pid: 4300 + wires.length, stdout: new ReadableStream<Uint8Array>({ start: c => void (out = c) }), stdin: { write: (s: string) => written.push(s), flush: () => 0 }, exited: new Promise<number>(() => {}), kill() {} });
	const proc = omp.start({ role: "orchestrator", cwd: process.env.DOTZ_DIR!, model: "test:low", env: {} });
	patchable.spawn = realSpawn;
	return {
		proc,
		written,
		feed: async frame => {
			out.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
			await flush();
		},
	};
}

class ClaudeStub implements AgentProcess {
	static next = 9600;
	pid = ClaudeStub.next++;
	sent: string[] = [];
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	readonly exited = new Promise<number>(() => {});
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	async push(...events: AgentEvent[]): Promise<void> {
		this.queue.push(...events);
		this.wake.resolve();
		await flush();
	}
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {};
}
const claudes: ClaudeStub[] = [];

const caps = { steer: "native", subagents: "live", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false } as const;
const adapter = (id: "omp" | "claude", start: () => AgentProcess): RuntimeAdapter => ({ id, caps: id === "omp" ? omp.caps : caps, start, classifyError: omp.classifyError, recentExchanges: () => "" });
const use = (name: "regress-omp" | "regress-claude") => void (cfg.orchestrator = { ...cfg.orchestrator, runtime: name });

const saved = { orchestrator: cfg.orchestrator, agentDir: process.env.OMO_CODING_AGENT_DIR };
let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-omp-regress-"));
	process.env.OMO_CODING_AGENT_DIR = join(dir, "omo-agent");
	adapters["regress-omp"] = adapter("omp", () => {
		const wire = openWire();
		wires.push(wire);
		return wire.proc;
	});
	adapters["regress-claude"] = adapter("claude", () => {
		const agent = new ClaudeStub();
		claudes.push(agent);
		return agent;
	});
});
afterAll(() => {
	delete adapters["regress-omp"];
	delete adapters["regress-claude"];
	cfg.orchestrator = saved.orchestrator;
	if (saved.agentDir === undefined) delete process.env.OMO_CODING_AGENT_DIR;
	else process.env.OMO_CODING_AGENT_DIR = saved.agentDir;
	rmSync(dir, { recursive: true, force: true });
});

function run(from: "Napper" | "Sleeper", as: string) {
	const pick = (match: (f: Frame) => boolean): Frame => {
		const f = recorded.find(r => JSON.stringify(r).includes(`"${from}"`) && match(r));
		if (!f) throw new Error(`no recorded ${from} frame`);
		return JSON.parse(JSON.stringify(f).replaceAll(from, as));
	};
	return {
		spawn: pick(f => f.type === "tool_execution_end" && f.toolName === "task"),
		started: pick(f => f.type === "subagent_lifecycle" && f.payload.status === "started"),
		ended: pick(f => f.type === "subagent_lifecycle" && f.payload.status !== "started"),
		wake: pick(f => f.type === "message_end" && f.message.customType === "async-result"),
	};
}
const answerFrame = (text: string): Frame => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
const sent = (w: Wire): Frame[] => w.written.map(s => JSON.parse(s));
const lastPrompt = (w: Wire): string => String(sent(w).findLast(f => f.type === "prompt")!.message);

async function turn(w: Wire, text: string, between: Frame[], answer: string, pending = false): Promise<void> {
	const end = pending ? { type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true } : { type: "agent_end", isTerminal: true };
	for (const f of [{ type: "agent_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } }, ...between, answerFrame(answer), end]) await w.feed(f);
	await advance(300);
}
async function boot(key: string, text: string) {
	use("regress-omp");
	convs.deliverTo(key, text, { target: key, replyTo: "m1", owner: true });
	await flush();
	const w = wires.at(-1)!;
	await turn(w, String(sent(w).find(f => f.type === "prompt")!.message), [], "-");
	return { w, c: convs.get(key)! };
}

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const post = (path: string) => route(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN }, body: "{}" }));
const cancelPath = (id: string, source?: string) => `/api/workers/${encodeURIComponent(id)}/cancel${source ? `?source=${encodeURIComponent(source)}` : ""}`;

async function answerCancel(w: Wire, cancelled = true): Promise<Frame> {
	await flush();
	const request = sent(w).findLast(f => f.type === "cancel_subagent")!;
	await w.feed({ type: "response", id: request.id, command: "cancel_subagent", success: true, data: { cancelled } });
	return request;
}

const stubLane = (name: string, runtime: string, proc: object): Lane => ({ name, runtime, cwd: dir, status: "idle", proc }) as unknown as Lane;
const sub = (id: string, status: SubagentUpdate["status"] = "running"): AgentEvent => ({ type: "subagent", update: { id, description: `work of ${id}`, status } });

test("M1: a claude session's Agent subagents are no worker rows, no busy term, no quiet job, and a bare [later] is refused as on main", async () => {
	use("regress-claude");
	convs.deliverTo("ch:m1", "first request", { target: "ch:m1", replyTo: "m1", owner: true });
	await flush();
	const agent = claudes.at(-1)!;
	const c = convs.get("ch:m1")!;
	await agent.push({ type: "turn_start" }, { type: "user", text: agent.sent[0]! }, { type: "assistant", text: "-", stop: "stop" }, { type: "turn_end" });
	await advance(300);

	await agent.push({ type: "turn_start" }, { type: "user", text: "first request" }, sub("agent-1"));
	expect([c.o.liveWorkers(), convWorkers(c), c.o.ompWorkers(), c.bg.list(), c.bg.running()]).toEqual([0, 0, [], [], 0]);
	await agent.push(sub("agent-1", "done"), { type: "assistant", text: "[later]", stop: "stop" }, { type: "turn_end" });
	await advance(300);
	expect(c.bg.list()).toEqual([]);
	expect(c.queue.deferredOpen()).toEqual([]);
	expect(agent.sent.filter(t => t.includes("Your last answer was a bare [later]"))).toHaveLength(1);

	const source = "lane:regress-claude";
	const cancelled: string[] = [];
	const claudeLane = stubLane("regress-claude", "claude", { cancelWorker: (id: string) => (cancelled.push(id), Promise.resolve({ cancelled: true })) });
	emitEventActivity(source, sub("agent-1"));
	await advance(STALL_IDLE_MS);
	expect(laneJobs(claudeLane)).toEqual([]);
	expect(laneJobs(stubLane("regress-claude", "omp", {}))).toHaveLength(1);
	expect(await cancelLaneWorker("agent-1", claudeLane)).toMatchObject({ ok: false, status: 404, error: "이 작업을 찾을 수 없어요" });
	lanes.set("regress-claude", claudeLane);
	const res = await post(cancelPath("agent-1"));
	lanes.delete("regress-claude");
	endSubagents(source);
	expect([res.status, cancelled]).toEqual([404, []]);
});

test("M2: two runs of one worker name are two keys; the owner's stop of the first marks only it, and each [later] link follows its own run", async () => {
	const { w, c } = await boot("ch:m2", "first request");
	const one = run("Napper", "Reviewer"), two = run("Sleeper", "Reviewer");
	await turn(w, lastPrompt(w), [one.spawn, one.started], "[later]", true);
	const [first] = c.bg.list();
	expect(first!.id).toMatch(/^Reviewer~\w+\.1$/);
	expect(first).toMatchObject({ status: "running", reply_to: "m1" });

	const stopping = c.bg.cancel(first!.id);
	await answerCancel(w);
	expect(await stopping).toEqual({ ok: true });
	await w.feed(two.ended);
	convs.deliverTo("ch:m2", "second request", { target: "ch:m2", replyTo: "m2", owner: true });
	await flush();
	await turn(w, lastPrompt(w), [two.spawn, two.started], "[later]", true);

	const [second, stopped] = c.bg.list();
	expect(second!.id).toMatch(/^Reviewer~\w+\.2$/);
	expect(second).toMatchObject({ status: "running", reply_to: "m2" });
	expect(second!.cancelled).toBeUndefined();
	expect(stopped).toMatchObject({ id: first!.id, status: "failed", cancelled: true, reply_to: "m1" });
	expect(c.bg.running()).toBe(1);
	expect([c.queue.linkOf(first!.id)?.replyTo, c.queue.linkOf(second!.id)?.replyTo]).toEqual(["m1", "m2"]);
	expect(c.queue.deferredOpen().map(d => d.replyTo)).toEqual(["m1", "m2"]);

	await w.feed({ type: "agent_start" });
	await w.feed(one.ended);
	await w.feed(two.wake);
	await w.feed(answerFrame("second done"));
	await w.feed({ type: "agent_end", isTerminal: true });
	await advance(300);
	expect(c.bg.list().map(r => [r.id, r.status])).toEqual([[second!.id, "done"], [first!.id, "failed"]]);
	expect(c.queue.linkOf(second!.id)).toMatchObject({ replyTo: "m2" });
});

test("M3: the same worker name in two sessions: a cancel with ?source= reaches only the process that runs it", async () => {
	const calls: string[] = [];
	const proc = (name: string) => ({ cancelWorker: (id: string) => (calls.push(`${name}:${id}`), Promise.resolve({ cancelled: true })), send: () => {} });
	for (const name of ["m3-a", "m3-b"]) {
		lanes.set(name, stubLane(name, "omp", proc(name)));
		emitEventActivity(`lane:${name}`, sub("Explorer"));
	}
	try {
		expect((await post(cancelPath("Explorer", "lane:m3-b"))).status).toBe(200);
		expect(calls).toEqual(["m3-b:Explorer"]);
		expect((await post(cancelPath("Explorer", "lane:m3-a"))).status).toBe(200);
		expect(calls).toEqual(["m3-b:Explorer", "m3-a:Explorer"]);
		const none = await post(cancelPath("Explorer", "lane:m3-none"));
		const refused: { error?: string } = await none.json();
		expect([none.status, refused.error]).toEqual([404, "이 작업을 찾을 수 없어요"]);
		expect(calls).toHaveLength(2);
	} finally {
		for (const name of ["m3-a", "m3-b"]) {
			lanes.delete(name);
			endSubagents(`lane:${name}`);
		}
	}
});

test("lane route: cancelling an omp lane's worker reaches that lane's process, the session told first, with no source named", async () => {
	const calls: string[] = [];
	const lane = stubLane("route-lane", "omp", {
		send: (text: string, mode: string) => calls.push(`${mode}:${/<dotz-owner-stopped task="([^"]+)"/.exec(text)?.[1]}`),
		cancelWorker: (id: string) => (calls.push(`cancel:${id}`), Promise.resolve({ cancelled: true })),
	});
	lanes.set("route-lane", lane);
	emitEventActivity("lane:route-lane", sub("Scout"));
	try {
		const res = await post(cancelPath("Scout"));
		expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
		expect(calls).toEqual(["steer:Scout", "cancel:Scout"]);
		emitEventActivity("lane:route-lane", sub("Scout", "aborted"));
		const again = await post(cancelPath("Scout", "lane:route-lane"));
		expect(again.status).toBe(409);
		expect(calls).toHaveLength(2);
	} finally {
		lanes.delete("route-lane");
		endSubagents("lane:route-lane");
	}
});

test("owner stop: the session gets the ownerStopped note before the cancel, the cancel names omp's own worker name, and a revived worker is a new run", async () => {
	const { w, c } = await boot("ch:m5", "stop me");
	const one = run("Napper", "Reviewer"), two = run("Sleeper", "Reviewer");
	await turn(w, lastPrompt(w), [one.spawn, one.started], "[later]", true);
	const key = c.bg.list()[0]!.id;
	const noted = () => sent(w).filter(f => f.type === "steer" && String(f.message).includes("<dotz-owner-stopped"));

	const stopping = post(cancelPath(key, c.o.source));
	const request = await answerCancel(w);
	expect((await stopping).status).toBe(200);
	const frames = sent(w);
	const note = frames.findIndex(f => f.type === "steer" && String(f.message).includes('<dotz-owner-stopped task="Reviewer">'));
	expect(note).toBeGreaterThan(-1);
	expect(note).toBeLessThan(frames.indexOf(frames.find(f => f.id === request.id)!));
	expect(request).toMatchObject({ type: "cancel_subagent", subagentId: "Reviewer" });
	expect(c.bg.list()[0]).toMatchObject({ id: key, status: "failed", cancelled: true });

	await w.feed(two.ended);
	await w.feed(two.started);
	const [revived, old] = c.bg.list();
	expect(revived).toMatchObject({ status: "running" });
	expect(revived!.id).not.toBe(key);
	expect(revived!.id).toMatch(/^Reviewer~\w+\.2$/);
	expect(old).toMatchObject({ id: key, cancelled: true });
	expect((await post(cancelPath(key, c.o.source))).status).toBe(409);
	expect(noted()).toHaveLength(1);

	const stoppingAgain = post(cancelPath(revived!.id, c.o.source));
	await answerCancel(w);
	expect((await stoppingAgain).status).toBe(200);
	expect(noted()).toHaveLength(2);
	expect(sent(w).findLast(f => f.type === "cancel_subagent")).toMatchObject({ subagentId: "Reviewer" });
});

test("a conversation session with a running subagent is not parkable and rests on nothing; once it is done it is", async () => {
	const { w, c } = await boot("ch:m6", "park me");
	const one = run("Napper", "Reviewer");
	await turn(w, lastPrompt(w), [], "answered");
	await advance(300);
	expect(convs.parkable(c, 0)).toBe(true);

	await w.feed(one.started);
	expect([c.o.liveWorkers(), convWorkers(c), convs.parkable(c, 0)]).toEqual([1, 1, false]);
	convs.sweep();
	expect(convs.live(c)).toBe(true);
	await w.feed(one.ended);
	expect([c.o.liveWorkers(), convWorkers(c), convs.parkable(c, 0)]).toEqual([0, 0, true]);
});
