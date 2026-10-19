// End-to-end state-machine scenarios for the orchestrator and lanes, driven through a mocked Bun.spawn: a scripted
// "omp" whose stdout the scenario feeds frame by frame and whose stdin it records. The trace (spawn args, every frame the
// hub wrote, status after each step, every callback) is compared against scenario.golden.json, which was captured from the
// pre-adapter code (commit 5d9f817), so the refactor is checked for identical behavior down to the frames on the wire.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { featurePrompt } from "../featuredirs.ts";
import { activityItems } from "../events.ts";
import { modeFile } from "../i18n.ts";
import { advance, flush } from "./test-clock.ts";

const DATA = process.env.DOTZ_DIR!;
const REPO = join(import.meta.dir, "..", "..");
const norm = (s: string) => s.split(DATA).join("<DATA>").split(REPO).join("<REPO>");
// Long prompts (recall, footer) are compared by shape: paths normalised, digits blanked (the footer carries machine-sized slot counts).
// Repo text that other work legitimately edits (MODE.md, the shipped feature catalog) is blanked first so only prompt structure is compared.
const volatile = () => [readFileSync(modeFile(), "utf8"), featurePrompt(DATA, "orchestrator", () => {}), featurePrompt(DATA, "lanes", () => {})].filter(Boolean);
const short = (s: string) => {
	let t = norm(s);
	for (const v of volatile()) t = t.split(norm(v)).join("<volatile>");
	return t.length <= 140 ? t : `#${Bun.hash(t.replace(/\d+/g, "#")).toString(36)} ${t.slice(0, 60).replace(/\d+/g, "#")}…`;
};

type Trace = unknown[][];
let trace: Trace = [];
const T = (...entry: unknown[]) => void trace.push(entry);

class FakeProc {
	static all: FakeProc[] = [];
	pid = 9000 + FakeProc.all.length;
	n = FakeProc.all.length;
	private ctl!: ReadableStreamDefaultController<Uint8Array>;
	stdout = new ReadableStream<Uint8Array>({ start: c => void (this.ctl = c) });
	stderr = new ReadableStream<Uint8Array>();
	private done!: (code: number) => void;
	exited = new Promise<number>(r => void (this.done = r));
	stdin = {
		write: (s: string) => {
			for (const line of s.split("\n").filter(Boolean)) {
				const { id: _id, ...f } = JSON.parse(line);
				if (typeof f.message === "string") f.message = short(f.message);
				T("stdin", this.n, f);
			}
			return s.length;
		},
		flush: () => 0,
	};
	constructor(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) {
		FakeProc.all.push(this);
		const dotz = Object.fromEntries(Object.entries(opts.env ?? {}).filter(([k]) => k.startsWith("DOTZ_") && !["DOTZ_DIR", "DOTZ_OMP", "DOTZ_OMO", "DOTZ_TEST_DIR"].includes(k)));
		T("spawn", this.n, args.slice(1).map(a => norm(a)), norm(opts.cwd ?? ""), dotz);
	}
	kill(sig?: number) {
		T("kill", this.n, sig ?? "TERM");
	}
	async push(f: unknown) {
		this.ctl.enqueue(new TextEncoder().encode(`${typeof f === "string" ? f : JSON.stringify(f)}\n`));
		await flush();
	}
	async exit(code: number) {
		T("exit", this.n, code);
		this.ctl.close();
		this.done(code);
		await flush();
	}
}
// Moves time in steps until `done` holds (a tick of an interval whose phase the scenario does not know).
async function advanceUntil(done: () => boolean, step: number, max = 10_000): Promise<void> {
	for (let i = 0; i < max && !done(); i++) await advance(step);
}
const proc = (n = -1) => FakeProc.all.at(n)!;

function mockSpawn(): () => void {
	const real = Bun.spawn;
	(Bun as any).spawn = (args: string[], opts: any) => {
		if (args.includes("rpc")) return new FakeProc(args, opts);
		if (args[1] === "usage") return { stdout: new Response('{"reports":[]}').body, exited: Promise.resolve(0), kill() {} };
		throw new Error(`unexpected spawn in a test: ${args.join(" ")}`);
	};
	return () => void ((Bun as any).spawn = real);
}

// Frames as omp sends them.
const agentStart = { type: "agent_start" };
const agentEnd = { type: "agent_end" };
const userEnd = (content: unknown) => ({ type: "message_end", message: { role: "user", content } });
const asstEnd = (text: string, stopReason = "stop", extra: Record<string, unknown> = {}) => ({ type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, usage: { input: 100, cacheRead: 1000, cacheWrite: 0, output: 20 }, ...extra } });
const stateResp = (sessionFile: string, tokens = 1500, contextWindow = 200_000) => ({ type: "response", command: "get_state", success: true, data: { sessionFile, contextUsage: { tokens, contextWindow } } });
const statsResp = (tokens: number, contextWindow = 200_000) => ({ type: "response", command: "get_session_stats", success: true, data: { contextUsage: { tokens, contextWindow } } });
const compactResp = { type: "response", command: "compact", success: true, data: { tokensBefore: 99_000 } };
const delta = { type: "message_update", message: { role: "assistant", content: [] } };

const ctxOf = (c: { tokens: number; window: number; compaction: { state?: string; tokensBefore?: number; error?: string } }) => [c.tokens, c.window, c.compaction.state ?? null, c.compaction.tokensBefore ?? null, c.compaction.error ?? null];
// Alerts carry a local-time restart date: weekday, am/pm and digits depend on the machine's time zone.
const digits = (s: string) => s.replace(/\([월화수목금토일]\)|오전|오후/g, "~").replace(/\d+/g, "#");

function sessionFile(name: string, lines: unknown[]): string {
	const file = join(DATA, `${name}.jsonl`);
	writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
	return file;
}
const history = (n: number) => [
	...Array.from({ length: n }, (_, i) => [{ type: "message", message: { role: "user", content: `question ${i}` } }, { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `answer ${i}` }] } }]).flat(),
	{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "mid-turn monologue" }] } },
	{ type: "message", message: { role: "user", content: "[keepalive] ping" } },
];

export async function orchestratorScenario(): Promise<Trace> {
	trace = [];
	FakeProc.all = [];
	const restore = mockSpawn();
	rmSync(join(DATA, "orchestrator.json"), { force: true });
	// The activity buffer is shared by everything running in this process; only rows added by this scenario count.
	const rowsBefore = activityItems("orchestrator", 300).length;
	const o = await import("../orchestrator.ts");
	o.setAlertHandler(t => T("alert", digits(t)));
	o.setIdleHandler(() => T("idle"));
	o.setAnswerHandlers(
		t => T("prompt", short(t)),
		t => T("answer", t),
	);
	const snap = (label: string) => T("snap", label, o.orch.status, o.orch.pauseKind, norm(o.orch.sessionFile), o.orch.lastText, ctxOf(o.orch.ctx), o.orch.rateLimitedUntil ? "until" : "");
	const saved = () => (existsSync(join(DATA, "orchestrator.json")) ? JSON.parse(readFileSync(join(DATA, "orchestrator.json"), "utf8")) : null);
	const session = sessionFile("orch-session", history(3));

	// 1 start: recall prompt, subscription, get_state after 4s, which makes it idle.
	o.start();
	snap("started");
	await advance(4000);
	await proc().push(stateResp(session));
	snap("known");
	T("saved", { ...saved(), sessionFile: norm(saved().sessionFile) }, o.orchestratorPid() === proc().pid);

	// 2 a turn: delivery arms the watchdog, agent_start disarms it, the answer is routed, agent_end -> stats + idle.
	o.deliver("hello there");
	await advance(60_000);
	await proc().push(agentStart);
	snap("working");
	await proc().push(userEnd("hello there"));
	await proc().push(userEnd([{ type: "text", text: "[dotz gateway] You are the resident" }]));
	await proc().push(asstEnd("checking", "toolUse"));
	await proc().push({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "date" } });
	await proc().push({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "now" }] } });
	await proc().push(asstEnd("hi, here is the answer"));
	await proc().push(agentEnd);
	snap("turn done");
	await advance(300);
	await proc().push(statsResp(4000));

	// 3 steer is ignored while idle; abort/steer/queued compaction while working.
	o.steer("ignored: idle");
	o.deliver("second request");
	await proc().push(agentStart);
	o.steer("mid-turn note");
	const queued = o.compact();
	T("compact", queued.state);
	o.abort();
	await proc().push(asstEnd("", "aborted"));
	await proc().push(agentEnd);
	snap("after abort, compaction flushed");
	await proc().push(compactResp);
	await proc().push(statsResp(1200));
	snap("compacted");
	T("compact again", o.compact().state);
	await proc().push({ type: "response", command: "compact", success: false, error: "compaction failed: boom" });
	snap("compaction failed");

	// 4 usage limit: pause, hold, resume at the delay, flush held after the next success.
	o.deliver("before limit");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "429 usage limit reached" }));
	await proc().push(agentEnd);
	snap("rate limited");
	o.deliver("held one");
	o.deliver("held two");
	await advance(11 * 60_000 + 1000);
	snap("probing");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "429 usage limit reached" }));
	await proc().push(agentEnd);
	snap("limited again");
	await advance(11 * 60_000 + 1000);
	await proc().push(agentStart);
	await proc().push(asstEnd("back again"));
	await proc().push(agentEnd);
	snap("resumed, held flushed");
	await advance(300);

	// 5 transient errors: bounded backoff retries, a success resets the counter.
	o.deliver("flaky provider");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "overloaded_error" }));
	await proc().push(agentEnd);
	await advance(5000);
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "503 service unavailable" }));
	await proc().push(agentEnd);
	await advance(15_000);
	await proc().push(agentStart);
	await proc().push(asstEnd("recovered"));
	await proc().push(agentEnd);
	snap("transient recovered");
	await advance(300);

	// 6 billing/auth error pauses like a limit but probes on a fixed interval and tells the owner once.
	o.deliver("needs credit");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "Your credit balance is too low" }));
	await proc().push(agentEnd);
	snap("owner pause");
	await advance(31 * 60_000);
	await proc().push(agentStart);
	await proc().push(asstEnd("fixed"));
	await proc().push(agentEnd);
	snap("owner resolved");
	await advance(300);

	// 7 keepalive 50-58 minutes after the last turn.
	await advanceUntil(() => trace.some(e => e[0] === "stdin" && String((e[2] as { message?: string }).message).startsWith("[keepalive]")), 30_000);
	await proc().push(agentStart);
	await proc().push(asstEnd("ok"));
	await proc().push(agentEnd);
	snap("keepalive done");
	await advance(300);

	// 8 a hung process: no turn after a delivery -> SIGTERM, SIGKILL 10s later, exit -> restart after 10s resuming the session.
	o.deliver("are you there");
	await advance(121_000);
	await advance(10_000);
	await proc().exit(137);
	snap("exited");
	await advance(10_000);
	snap("restarted");
	await advance(4000);
	await proc().push(stateResp(session, 2000));

	// 9 model change mid-turn waits for the turn, then restarts (a changed model starts a fresh session with a handover).
	o.deliver("long job");
	await proc().push(agentStart);
	T("applyModelChange", o.applyModelChange());
	await proc().push(asstEnd("done long job"));
	await proc().push(agentEnd);
	await advance(10_000);
	await proc().exit(0);
	await advance(1000);
	await advance(4000);
	snap("after pending restart");

	// 10 rotation: past ROTATE_TOKENS at the second idle turn the process is replaced by a fresh session with a handover.
	await proc().push(stateResp(session, 2000));
	await proc().push(agentStart);
	await proc().push(asstEnd("one", "stop", { usage: { input: 10, cacheRead: 300_000, cacheWrite: 0, output: 20 } }));
	await proc().push(agentEnd);
	await proc().push(agentStart);
	await proc().push(asstEnd("two", "stop", { usage: { input: 10, cacheRead: 300_000, cacheWrite: 0, output: 20 } }));
	await proc().push(agentEnd);
	await advance(300);
	await proc().exit(0);
	await advance(1000);
	snap("rotated");

	// 11 stop and the activity the web UI saw.
	o.stop();
	await proc().exit(0);
	await advance(11_000);
	snap("stopped");
	T("activity", activityItems("orchestrator", 300).slice(rowsBefore).map(({ ts: _ts, ...a }) => a));
	restore();
	return trace;
}

export async function laneScenario(): Promise<Trace> {
	trace = [];
	FakeProc.all = [];
	const restore = mockSpawn();
	const l = await import("../lanes.ts");
	for (const name of [...l.lanes.keys()]) l.lanes.delete(name);
	rmSync(join(DATA, "lanes"), { recursive: true, force: true });
	mkdirSync(join(DATA, "lanes"), { recursive: true });
	l.setReportHandler((lane, text) => T("report", lane.name, digits(text)));
	l.setProgressHandler((lane, text) => T("progress", lane.name, digits(text)));
	l.setIdleHandler(name => T("idle", name));
	const cwd = join(DATA, "work");
	mkdirSync(cwd, { recursive: true });
	const lane = () => l.lanes.get("alpha")!;
	const snap = (label: string) => T("snap", label, lane().status, norm(lane().sessionFile ?? ""), lane().lastText, ctxOf(lane().ctx), Boolean(lane().proc), lane().held ?? null, lane().reports, lane().pauseKind ?? null);
	const session = sessionFile("lane-session", history(2));

	// 1 launch: spawn args + overlay, subscription, brief prompt, get_state after 3s.
	l.launch("alpha", cwd, "Build the thing.\nDone when: tests pass", undefined, undefined, true);
	T("overlay", norm(readFileSync(join(DATA, "lanes", "alpha", "omp-overlay.yml"), "utf8")));
	snap("launched");
	await advance(3000);
	await proc().push(stateResp(session));
	snap("session known");
	T("persisted", norm(readFileSync(join(DATA, "lanes", "alpha", "lane.json"), "utf8")).replace(/"startedAt": "[^"]+"/, '"startedAt": "<t>"'));

	// 2 a turn with a report; progress frames of every kind count as life signs.
	await proc().push(agentStart);
	await proc().push(asstEnd("working on it", "toolUse"));
	await proc().push(delta);
	await proc().push({ type: "subagent_lifecycle", payload: { id: "w1", agent: "task", description: "impl", status: "running" } });
	await advance(1000);
	T("busy while worker runs", l.laneBusy(lane()));
	await proc().push(asstEnd("finished: all green"));
	await proc().push(agentEnd);
	snap("turn ended");
	await advance(500);
	await proc().push(statsResp(5000));
	snap("stats");

	// 3 owner messages: prompt when idle, steer while working, abort, queued compaction.
	l.sendToLane("alpha", "next please");
	await proc().push(agentStart);
	l.sendToLane("alpha", "also this");
	l.abortLane("alpha");
	T("compact", l.compactLane("alpha").state);
	await proc().push(asstEnd("", "aborted"));
	await proc().push(agentEnd);
	snap("aborted, compaction flushed");
	await proc().push(compactResp);
	await proc().push(statsResp(1800));
	snap("compacted");
	l.refreshLaneStats("alpha");
	await advance(500);

	// 4 usage limit: report once, hold owner messages, resume with them.
	l.sendToLane("alpha", "go on");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "429 usage limit reached" }));
	await proc().push(agentEnd);
	snap("rate limited");
	l.sendToLane("alpha", "while paused");
	snap("held");
	await advance(11 * 60_000 + 1000);
	snap("resumed");
	await proc().push(agentStart);
	await proc().push(asstEnd("after the pause"));
	await proc().push(agentEnd);
	snap("after pause");
	await advance(500);

	// 5 transient errors retry then report as a lane error when spent.
	l.sendToLane("alpha", "flaky");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "overloaded_error" }));
	await proc().push(agentEnd);
	await advance(5000);
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "fetch failed" }));
	await proc().push(agentEnd);
	await advance(15_000);
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "ETIMEDOUT" }));
	await proc().push(agentEnd);
	await advance(45_000);
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "overloaded again" }));
	await proc().push(agentEnd);
	await advance(135_000);
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "overloaded one more time" }));
	await proc().push(agentEnd);
	await advance(500);
	snap("transient spent");

	// 6 a failed compaction recovers the lane: kill -9, exit, resume the same session with the stopped note.
	l.sendToLane("alpha", "compaction trouble");
	await proc().push(agentStart);
	await proc().push({ type: "auto_compaction_end", errorMessage: "auto compaction failed: provider error" });
	snap("recovering");
	await proc().exit(137);
	snap("revived");
	await advance(3000);
	await proc().push(stateResp(session, 900));

	// 7 stall detection: frames of any kind keep a working turn alive, silence past 20 minutes recovers it.
	await proc().push(agentStart);
	for (let i = 0; i < 5; i++) {
		await advance(8 * 60_000);
		await proc().push(delta);
	}
	snap("kept alive by deltas");
	await advance(21 * 60_000);
	snap("stall recovered");
	await proc().exit(137);
	await advance(3000);
	await proc().push(stateResp(session, 900));
	await proc().push(agentStart);
	await proc().push(asstEnd("worked again"));
	await proc().push(agentEnd);
	await advance(500);

	// 8 restart (idle), rotate with a handover, a compaction message error, stop.
	const restarted = l.restartLane("alpha");
	await proc().exit(0);
	await restarted;
	snap("restarted idle");
	await advance(3000);
	await proc().push(stateResp(session, 700));
	const rotated = l.rotateLane("alpha", "nightly test");
	await proc().exit(0);
	await rotated;
	snap("rotated");
	await advance(3000);
	await proc().push(agentStart);
	await proc().push(asstEnd("reloaded", "stop"));
	await proc().push(agentEnd);
	await advance(500);
	snap("silent handover turn");
	await proc().push(agentStart);
	await proc().push(asstEnd("", "error", { errorMessage: "Compaction failed while summarising" }));
	snap("compaction message error");
	await proc().exit(137);
	await advance(3000);
	l.stopLane("alpha");
	await proc().exit(0);
	await advance(500);
	snap("stopped");
	T("summary", l.laneSummary().map(({ startedAt: _s, cwd: c, sessionFile: sf, ...rest }) => ({ ...rest, cwd: norm(String(c)), sessionFile: norm(String(sf)) })));
	T("activity", activityItems("lane:alpha", 300).map(({ ts: _ts, text, ...a }) => ({ ...a, text: norm(text) })));
	restore();
	return trace;
}
