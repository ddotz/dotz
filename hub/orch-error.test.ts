import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseChoices } from "./choices.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { cfg } from "./config.ts";
import { ERROR_ASK_HOLD_MS, ERROR_ASK_REPEAT_HOLD_MS, errorAnswer, errorAsk, errorAskFile, type OrchError, plainError, startErrorWatch } from "./orch-error.ts";
import { createPrompts } from "./prompts.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode } from "./runtime/types.ts";
import { parseTone } from "./tone.ts";

const o: typeof Orchestrator = await import("./orchestrator.ts?orch-error");

class FakeAgent implements AgentProcess {
	pid = 7300;
	sent: { text: string; mode: SendMode }[] = [];
	private buf: AgentEvent[] = [];
	private wake?: () => void;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (self: FakeAgent): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (self.buf.length) yield self.buf.shift()!;
			await new Promise<void>(r => (self.wake = r));
		}
	})(this);
	push(e: AgentEvent): void {
		this.buf.push(e);
		this.wake?.();
	}
	send(text: string, mode: SendMode): void {
		this.sent.push({ text, mode });
	}
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start: () => {
		const a = new FakeAgent();
		started.push(a);
		return a;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => undefined,
};
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

const failed = (text: string): AgentEvent => ({ type: "assistant", text: "", stop: "error", error: { text, kind: "transient", compaction: false } });

test("plain Korean reasons for the raw errors", () => {
	expect(plainError("stream start timed out after 300s")).toMatchObject({ kind: "timeout", text: "모델 연결이 계속 시간 초과로 끊겨요" });
	expect(plainError("getaddrinfo ENOTFOUND api.anthropic.com")).toMatchObject({ kind: "dns", text: "네트워크(DNS)가 안 돼요" });
	expect(plainError("something odd").kind).toBe("other");
});

test("the ask is one [ask] with the restart option recommended first, and its answers are read", () => {
	const e: OrchError = { since: "2026-10-23T03:05:00.000Z", ...plainError("timed out"), raw: "timed out" };
	const text = errorAsk("dotz", e);
	expect(parseTone(text).tone).toBe("ask");
	expect(parseChoices(text).options.map(x => [x.n, x.label, x.recommended])).toEqual([[1, "다시 시작", true], [2, "기다리기", false]]);
	expect(errorAnswer("1) 다시 시작")).toBe("restart");
	expect(errorAnswer("2) 기다리기")).toBe("wait");
	expect(errorAnswer("다시 시작")).toBeUndefined();
});

test("five failed turns in a row give up once: the error is marked at once, the ask goes out once after the hold", async () => {
	rmSync(errorAskFile(), { force: true });
	const asked: OrchError[] = [];
	o.setErrorHandler(e => asked.push(e));
	o.start();
	const agent = started.at(-1)!;
	for (let i = 0; i < 6; i++) {
		agent.push(failed("stream start timed out"));
		await flush();
	}
	expect(o.orch.error).toBeDefined();
	expect(asked).toHaveLength(0);
	await advance(ERROR_ASK_HOLD_MS);
	expect(asked).toHaveLength(1);
	expect(o.orch.error).toMatchObject({ kind: "timeout", text: "모델 연결이 계속 시간 초과로 끊겨요" });
	expect(Date.parse(o.orch.error!.since)).toBeGreaterThan(0);
	expect(asked[0]).toBe(o.orch.error!);
});

test("a restart starts only the orchestrator and replays the open prompts once; a resume with nothing to replay sends one tiny probe", async () => {
	let replays = 0;
	let replayed = 2;
	o.setRestartedHandler(() => (replays++, { replayed, texts: [] }));
	const before = started.length;
	o.restart();
	await flush();
	expect(started.length).toBe(before + 1);
	expect(replays).toBe(1);

	replayed = 1;
	o.resumeAfterError();
	await flush();
	expect(replays).toBe(2);
	expect(started.at(-1)!.sent.some(s => s.text === o.PROBE_TEXT)).toBe(false);

	replayed = 0;
	o.resumeAfterError();
	await flush();
	expect(started.at(-1)!.sent.filter(s => s.text === o.PROBE_TEXT)).toHaveLength(1);

	started.at(-1)!.push({ type: "assistant", text: "-", stop: "stop" });
	await flush();
	expect(o.orch.error).toBeUndefined();
});

test("an episode over inside the hold goes to the worklog with no ask and no recovery alert; a repeat within the cooldown waits longer", async () => {
	const asked: OrchError[] = [];
	const alerts: string[] = [];
	const notices: string[] = [];
	o.setErrorHandler(e => asked.push(e));
	o.setAlertHandler(t => alerts.push(t));
	o.setNoticeHandler(t => notices.push(t));
	const episode = async () => {
		for (let i = 0; i < 6; i++) {
			started.at(-1)!.push(failed("stream start timed out"));
			await flush();
		}
		expect(o.orch.error).toBeDefined();
	};
	const recover = async () => {
		started.at(-1)!.push({ type: "assistant", text: "-", stop: "stop" });
		await flush();
		expect(o.orch.error).toBeUndefined();
	};

	// the ask of the first test was sent moments ago: past the normal hold, still quiet, and over before the longer one
	await episode();
	await advance(ERROR_ASK_HOLD_MS + 60_000);
	expect(asked).toHaveLength(0);
	await recover();
	await advance(ERROR_ASK_REPEAT_HOLD_MS);
	expect(asked).toHaveLength(0);
	expect(alerts).toEqual([]);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("스스로 다시 연결됐어요");

	// no ask in the cooldown: a lasting episode is asked after the normal hold, and its end is told
	rmSync(errorAskFile(), { force: true });
	await episode();
	await advance(ERROR_ASK_HOLD_MS);
	expect(asked).toHaveLength(1);
	await recover();
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toContain("다시 연결됐어요");
	expect(notices).toHaveLength(1);
});

test("the watch resumes once per episode, only after the model host answers", async () => {
	const e: OrchError = { since: new Date().toISOString(), ...plainError("timed out"), raw: "timed out" };
	let reachable = false;
	let resumed = 0;
	const t = startErrorWatch({ error: () => e, reachable: async () => reachable, resume: () => resumed++, log: () => {}, every: 1 });
	await advance(3);
	await flush();
	expect(resumed).toBe(0);
	reachable = true;
	await advance(3);
	await flush();
	await advance(3);
	await flush();
	clearInterval(t);
	expect(resumed).toBe(1);
	expect(e.probed).toBe(true);
});

function queue() {
	const delivered: string[] = [];
	const answered: string[] = [];
	const q = createPrompts({
		deliver: text => delivered.push(text),
		steer: () => false,
		working: () => false,
		note: (_t, _r, text) => text,
		isNote: () => false,
		post: async () => ({ delivered: true }),
		clearProgress: () => {},
		persist: () => {},
		log: () => {},
		answered,
	});
	return { q, delivered };
}

test("open prompts replay once after a restart, oldest first, without the answered ones", () => {
	const { q, delivered } = queue();
	const wrap = (t: string) => (t.startsWith("[gateway restarted]") ? t : `[gateway restarted] ${t}`);
	q.deliver("second", { target: "chat", replyTo: "m2" });
	q.deliver("first", { target: "chat", replyTo: "m1" });
	q.deliver("done", { target: "chat", replyTo: "m3" });
	q.markAnswered("m3");
	delivered.length = 0;
	expect(q.reopen(wrap).replayed).toBe(2);
	expect(delivered).toEqual(["[gateway restarted] second", "[gateway restarted] first"]);
	delivered.length = 0;
	q.markAnswered("m1");
	expect(q.reopen(wrap).replayed).toBe(1);
	expect(delivered).toEqual(["[gateway restarted] second"]);
});

test("the banner shows with the reason, since when and the restart button, and clears when the error is gone", async () => {
	const src = readFileSync(join(import.meta.dir, "..", "web", "js", "40-orch-error.js"), "utf8");
	const els: Record<string, { hidden: boolean; innerHTML: string; title: string; onclick?: (ev: unknown) => Promise<void> }> = {};
	const $ = (s: string) => (els[s] ??= { hidden: true, innerHTML: "", title: "" });
	const calls: string[] = [];
	const env = {
		S: { orchestrator: { error: { text: "네트워크(DNS)가 안 돼요", since: "2026-10-23T03:36:00.000Z", raw: "ENOTFOUND" } } as { error?: unknown } },
		$,
		kstHM: () => "12:36",
		busy: (_b: unknown, fn: () => Promise<void>) => fn(),
		api: async (path: string, method: string) => void calls.push(`${method} ${path}`),
		toast: () => {},
		refreshState: () => {},
	};
	const { paintOrchError } = new Function(...Object.keys(env), `${src}\nreturn { paintOrchError };`)(...Object.values(env));
	paintOrchError();
	expect($("#oerr").hidden).toBe(false);
	expect($("#oerr-tx").innerHTML).toContain("네트워크(DNS)가 안 돼요");
	expect($("#oerr-tx").innerHTML).toContain("12:36부터");
	await $("#oerr-btn").onclick!({ currentTarget: {} });
	expect(calls).toEqual(["POST /api/orchestrator/resume"]);
	env.S.orchestrator.error = undefined;
	paintOrchError();
	expect($("#oerr").hidden).toBe(true);
});
