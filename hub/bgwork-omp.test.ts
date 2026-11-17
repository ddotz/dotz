import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentFile } from "./activity.ts";
import { cfg } from "./config.ts";
import { type BgWork, createBgWork, FINISHED_KEEP_MS } from "./bgwork.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createPrompts } from "./prompts.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import type { AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const T0 = Date.parse("2026-11-17T03:00:00.000Z");
const sub = (over: Partial<SubagentFile> = {}): SubagentFile => ({ id: "AuthLoader", status: "running", description: "로그인 화면 고치기", started_at: T0, updated_at: T0 + 5_000, ...over });
const bgOf = (subagents: () => SubagentFile[], extra: { now?: () => number; log?: (line: string) => void; cancelOmpWorker?: (id: string) => Promise<{ cancelled: boolean }> | undefined } = {}) =>
	createBgWork({ sessionFile: () => "", deferred: () => [], now: () => T0 + 60_000, ompWorkers: subagents, ...extra });

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-bgwork-omp-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a running omp subagent is a running worker with its description, start and the model it resolved to, with no OmO session at all", () => {
	const work = bgOf(() => [sub({ model: "anthropic/claude-sonnet-5-5:low", thinking: "low" })]);
	expect(work.list()).toEqual([{ id: "AuthLoader", description: "로그인 화면 고치기", status: "running", started_at: T0, model: "Sonnet 5.5 low" }]);
	expect(work.running()).toBe(1);
	expect(work.runningWork().map(w => w.id)).toEqual(["AuthLoader"]);
	expect(work.quietWork("")).toEqual([]);
	expect(work.queuedWork()).toEqual([]);
});

test("a model with an upstream pin or only a level in its selector still reads as the model and its effort", () => {
	const label = (over: Partial<SubagentFile>) => bgOf(() => [sub(over)]).list()[0]!.model;
	expect(label({ model: "openrouter/anthropic/claude-opus-5-5@bedrock:high" })).toBe("Opus 5.5 high");
	expect(label({ model: "anthropic/claude-opus-5-5", thinking: "medium" })).toBe("Opus 5.5 medium");
	expect(label({ model: "anthropic/claude-opus-5-5" })).toBe("Opus 5.5");
	expect(label({})).toBeUndefined();
});

test("completed, failed and aborted subagents are done, failed and cut-off workers ended at their last frame, newest first after the running ones", () => {
	const subs = [
		sub({ id: "Killed", status: "aborted", updated_at: T0 + 10_000 }),
		sub({ id: "Broke", status: "failed", updated_at: T0 + 20_000 }),
		sub({ id: "Done", status: "done", updated_at: T0 + 30_000 }),
		sub({ id: "Busy", started_at: T0 + 1_000 }),
	];
	const work = bgOf(() => subs);
	expect(work.list().map(w => [w.id, w.status, w.ended_at])).toEqual([["Busy", "running", undefined], ["Done", "done", T0 + 30_000], ["Broke", "failed", T0 + 20_000], ["Killed", "failed", T0 + 10_000]]);
	expect(work.list().find(w => w.id === "Broke")).toMatchObject({ reason: "이유가 기록되지 않았어요" });
	expect(work.running()).toBe(1);
	expect(["Done", "Broke", "Killed", "Busy"].map(id => work.byId(id, [])?.raw)).toEqual(["completed", "failed", "cancelled", "running"]);
});

test("a finished omp worker leaves the list after an hour like an OmO one", () => {
	const subs = [sub({ status: "done", updated_at: T0 })];
	expect(bgOf(() => subs, { now: () => T0 + FINISHED_KEEP_MS }).list()).toHaveLength(1);
	expect(bgOf(() => subs, { now: () => T0 + FINISHED_KEEP_MS + 1 }).list()).toEqual([]);
});

test("a worker is found by its id with how it is stored, its start and its raw status; an id nothing runs is not found", () => {
	const work = bgOf(() => [sub({ model: "anthropic/claude-sonnet-5-5:low" })]);
	expect(work.byId("AuthLoader", [])).toMatchObject({ raw: "running", created: T0, work: { id: "AuthLoader", status: "running", model: "Sonnet 5.5 low" } });
	expect(work.byId("Nobody", [])).toBeUndefined();
	expect(createBgWork({ sessionFile: () => "", deferred: () => [] }).byId("AuthLoader", [])).toBeUndefined();
});

test("a finished worker's output file is its report: [file] lines become result files and a [fail] line turns it into a failure", () => {
	const out = join(dir, "out");
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "정리.md"), "# 정리\n");
	writeFileSync(join(dir, "Napper.md"), `[done] 정리했어요\n[file] ${join(out, "정리.md")}\n`);
	writeFileSync(join(dir, "Scout.md"), "[fail] 빌드가 안 돼요\n");
	const subs = [
		sub({ id: "Napper", status: "done", transcript: join(dir, "Napper.jsonl") }),
		sub({ id: "Scout", status: "done", transcript: join(dir, "Scout.jsonl") }),
		sub({ id: "Quiet", status: "done", transcript: join(dir, "Quiet.jsonl") }),
		sub({ id: "Nameless", status: "done" }),
	];
	const list = bgOf(() => subs).list();
	expect(list.find(w => w.id === "Napper")).toMatchObject({ status: "done", files: [{ path: join(out, "정리.md"), name: "정리.md", size: 9 }] });
	expect(list.find(w => w.id === "Scout")).toMatchObject({ status: "failed", reason: "빌드가 안 돼요" });
	expect(list.find(w => w.id === "Quiet")).toMatchObject({ status: "done" });
	expect(list.find(w => w.id === "Quiet")?.files).toBeUndefined();
	expect(list.find(w => w.id === "Nameless")).toMatchObject({ status: "done" });
});

test("a worker revived after a finished run reads its new output, not the one it had", () => {
	writeFileSync(join(dir, "Again.md"), "[done] 첫 번째");
	const subs = [sub({ id: "Again", status: "done", transcript: join(dir, "Again.jsonl") })];
	const work = bgOf(() => subs);
	expect(work.list()[0]).toMatchObject({ status: "done" });
	writeFileSync(join(dir, "Again.md"), "[fail] 두 번째 실행은 실패했어요");
	expect(work.list()[0]).toMatchObject({ status: "failed", reason: "두 번째 실행은 실패했어요" });
});

test("a worker is never the OmO report path: its short report is not cached by id across runs", () => {
	writeFileSync(join(dir, "Brief.md"), "[done] 짧음");
	const subs = [sub({ id: "Brief", status: "done", transcript: join(dir, "Brief.jsonl") })];
	const work = bgOf(() => subs);
	expect(work.list()[0]).toMatchObject({ status: "done" });
	writeFileSync(join(dir, "Brief.md"), "[fail] 이번엔 실패");
	expect(work.list()[0]).toMatchObject({ status: "failed" });
	expect(work.reportOf("Brief")).toBeUndefined();
});

test("중단 asks the process that runs the worker and lists the worker as stopped once it says it ended it", async () => {
	const asked: string[] = [];
	const lines: string[] = [];
	const work = bgOf(() => [sub()], { cancelOmpWorker: id => (asked.push(id), Promise.resolve({ cancelled: true })), log: m => lines.push(m) });
	expect(await work.cancel("AuthLoader")).toEqual({ ok: true });
	expect(asked).toEqual(["AuthLoader"]);
	expect(work.list()[0]).toMatchObject({ id: "AuthLoader", status: "failed", cancelled: true, reason: "직접 중단했어요", ended_at: T0 + 60_000 });
	expect(work.running()).toBe(0);
	expect(lines).toEqual(["background work AuthLoader stopped by the owner"]);
});

test("중단 says plainly what it cannot do: no such worker, a finished one, no process, a process that was not running it, a process that fails", async () => {
	const asked: string[] = [];
	const answer = (id: string) => {
		asked.push(id);
		return id === "NotRunning" ? Promise.resolve({ cancelled: false }) : id === "Broken" ? Promise.reject(new Error("pipe closed")) : undefined;
	};
	const subs = [sub({ id: "Gone", status: "done" }), sub({ id: "NoProcess" }), sub({ id: "NotRunning" }), sub({ id: "Broken" })];
	const work = bgOf(() => subs, { cancelOmpWorker: answer });
	expect(await work.cancel("Nobody")).toMatchObject({ ok: false, status: 404, error: "이 작업을 찾을 수 없어요" });
	expect(await work.cancel("Gone")).toMatchObject({ ok: false, status: 409, error: "이미 끝난 작업이에요" });
	expect(await work.cancel("NoProcess")).toMatchObject({ ok: false, status: 409 });
	expect(await work.cancel("NotRunning")).toMatchObject({ ok: false, status: 409 });
	expect(await work.cancel("Broken")).toEqual({ ok: false, status: 500, error: "작업을 멈추지 못했어요: pipe closed" });
	expect(asked).toEqual(["NoProcess", "NotRunning", "Broken"]);
	expect(work.running()).toBe(3);
	expect(work.list().some(w => w.cancelled)).toBe(false);
	expect(await bgOf(() => subs).cancel("NoProcess")).toMatchObject({ ok: false, status: 409 });
});

function wiredSession(workers: () => SubagentFile[]) {
	const state = { working: false, delivered: [] as string[], posts: [] as { target: string; text: string; replyTo?: string }[], announced: [] as { target: string; text: string; worker?: string }[] };
	let bg: { list(): BgWork[] } | undefined;
	const q = createPrompts({
		deliver: text => state.delivered.push(text),
		steer: () => true,
		working: () => state.working,
		note: (_target, _replyTo, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: (target, text, replyTo) => (state.posts.push({ target, text, replyTo }), Promise.resolve({ delivered: true })),
		announce: (target, text, worker) => void state.announced.push({ target, text, worker }),
		clearProgress: () => {},
		persist: () => {},
		log: () => {},
		answered: [],
		recent: () => [],
		work: () => (bg?.list() ?? []).map(w => ({ id: w.id, description: w.description, status: w.status, ...(w.target ? { target: w.target } : {}), ...(w.reply_to ? { replyTo: w.reply_to } : {}), startedAt: w.started_at, ...(w.ended_at !== undefined ? { endedAt: w.ended_at } : {}) })),
		workFor: target => {
			const w = bg?.list().find(x => x.status === "running" && x.target === target);
			return w && { id: w.id, description: w.description };
		},
	});
	bg = createBgWork({ sessionFile: () => "", deferred: q.deferredOpen, turn: q.turnAt, linkOf: q.linkOf, link: (id, to, description) => void q.link(id, to, description), ompWorkers: workers });
	return { q, bg, state };
}

test("a turn that started an omp worker and ended [later] waits on it by its name, and the worker's wake answers the request", async () => {
	let workers: SubagentFile[] = [];
	const { q, bg, state } = wiredSession(() => workers);
	q.deliver("로그인 고쳐줘", { target: "web", replyTo: "m1" });
	state.working = true;
	q.onPrompt("로그인 고쳐줘");
	workers = [sub({ started_at: Date.now(), updated_at: Date.now() })];
	q.workersSpawned([{ id: "AuthLoader", description: "로그인 화면 고치기" }]);
	q.onAnswer("[later]");
	state.working = false;
	q.settleTurn();

	expect(state.delivered).toEqual(["로그인 고쳐줘"]);
	expect(q.deferredOpen().map(d => d.replyTo)).toEqual(["m1"]);
	expect(state.announced).toEqual([{ target: "web", text: "백그라운드 작업으로 맡겼어요: 로그인 화면 고치기", worker: "AuthLoader" }]);
	expect(bg.list()).toMatchObject([{ id: "AuthLoader", status: "running", target: "web", reply_to: "m1" }]);

	workers = [sub({ status: "done", started_at: workers[0]!.started_at, updated_at: Date.now() })];
	q.workersDone(["AuthLoader"]);
	q.onAnswer("로그인 고쳤어요");
	await Promise.resolve();
	q.settleTurn();
	expect(state.posts).toEqual([{ target: "web", text: "로그인 고쳤어요", replyTo: "m1" }]);
	expect(q.deferredOpen()).toEqual([]);
	expect(bg.list()).toMatchObject([{ id: "AuthLoader", status: "done", target: "web", reply_to: "m1" }]);
});

test("a bare [later] is taken while an omp worker of the conversation runs, with no spawn event of the turn, and refused once when none runs", () => {
	let workers: SubagentFile[] = [];
	const { q, state } = wiredSession(() => workers);
	q.deliver("A 고쳐줘", { target: "ch:A", replyTo: "a1" });
	state.working = true;
	q.onPrompt("A 고쳐줘");
	q.onAnswer("[later]");
	state.working = false;
	q.settleTurn();
	expect(state.delivered).toHaveLength(2);
	expect(q.deferredOpen()).toEqual([]);

	workers = [sub({ id: "Scout", started_at: Date.now(), updated_at: Date.now() })];
	q.deliver("B 고쳐줘", { target: "ch:B", replyTo: "b1" });
	state.working = true;
	q.onPrompt("B 고쳐줘");
	q.onAnswer("[later]");
	state.working = false;
	q.settleTurn();
	expect(state.delivered).toHaveLength(3);
	expect(q.deferredOpen().map(d => d.replyTo)).toEqual(["b1"]);
});

class FakeAgent implements AgentProcess {
	pid = 9400;
	cancelled: string[] = [];
	readonly exited = Promise.withResolvers<number>().promise;
	readonly events: AsyncIterable<never> = (async function* () {
		await new Promise<never>(() => {});
	})();
	send = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => {};
	cancelWorker = (id: string) => (this.cancelled.push(id), Promise.resolve({ cancelled: true }));
}

test("an orchestrator hands a worker's cancel to its running process, and to none when it has no process", async () => {
	const started: FakeAgent[] = [];
	const fake: RuntimeAdapter = {
		id: "omp",
		caps: { steer: "native", subagents: "live", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
		start: (_opts: SpawnOpts) => {
			const agent = new FakeAgent();
			started.push(agent);
			return agent;
		},
		classifyError: omp.classifyError,
		recentExchanges: () => "",
	};
	const saved = cfg.orchestrator;
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
	try {
		const o = createOrchestrator({ key: "omp-cancel", stateFile: join(dir, "omp-cancel.json"), source: "omp-cancel:conv", keepalive: false });
		expect(o.cancelWorker("Scout")).toBeUndefined();
		o.deliver("hello", true);
		expect(await o.cancelWorker("Scout")).toEqual({ cancelled: true });
		expect(started.at(-1)!.cancelled).toEqual(["Scout"]);
	} finally {
		delete adapters.fake;
		cfg.orchestrator = saved;
	}
});
