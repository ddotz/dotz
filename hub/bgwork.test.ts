import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgWork, FINISHED_KEEP_MS, HANDOVER_AFTER_MS, STALL_ERROR_MS, type OpenDeferred, retryText, runningOmoWork, workConversation, workModel } from "./bgwork.ts";

const ROOT = "01a159d6-b330-71dd-b28a-301dd01d6031";
const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let tasks: string;
let session: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-bgwork-"));
	tasks = join(dir, "projects", "p1", "senpi-task", "tasks");
	mkdirSync(tasks, { recursive: true });
	mkdirSync(join(dir, "sessions", "p1"), { recursive: true });
	session = join(dir, "sessions", "p1", `2026-10-21T05-00-00-000Z_${ROOT}.jsonl`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const record = (id: string, over: Record<string, unknown> = {}) =>
	writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ task_id: id, status: "running", root_session_id: ROOT, created_at: iso(T0), started_at: iso(T0 + 400), updated_at: iso(T0 + 5000), description: "삼성 인터넷 사진첩 업로드 고치기", task_summary: "Web attach", ...over }));

const make = (now: () => number, deferred: OpenDeferred[] = [], alive: (pid: number) => boolean = () => true) => createBgWork({ sessionFile: () => session, deferred: () => deferred, now, alive });

test("a spawned worker is running with its Korean description and start time, then completed with its end time", () => {
	record("st_1");
	let t = T0 + 60_000;
	const work = make(() => t);
	expect(work.list()).toEqual([{ id: "st_1", description: "삼성 인터넷 사진첩 업로드 고치기", status: "running", started_at: T0 + 400 }]);

	record("st_1", { status: "completed", terminal_at: iso(T0 + 180_000) });
	t = T0 + 200_000;
	expect(work.list()).toEqual([{ id: "st_1", description: "삼성 인터넷 사진첩 업로드 고치기", status: "done", started_at: T0 + 400, ended_at: T0 + 180_000 }]);
});

test("a worker OmO calls completed but whose report is [fail] (token cap, st_01a19616) is failed with that line as its reason", () => {
	record("st_cap", { status: "completed", terminal_at: iso(T0 + 30_000), final_response: "[fail] token cap 8,768K. Tools are disabled, so I stopped.\n\n**Done (uncommitted):** x" });
	record("st_ask", { status: "completed", terminal_at: iso(T0 + 20_000), final_response: "Ask: fix it\nFor you: none\n\n**[fail]** 빌드가 안 돼요" });
	record("st_ok", { status: "completed", terminal_at: iso(T0 + 10_000), final_response: "[done] 커밋했어요\n안 된 것: [fail] 없음" });
	const w = make(() => T0 + 60_000).list();
	expect(w.find(x => x.id === "st_cap")).toMatchObject({ status: "failed", reason: "token cap 8,768K. Tools are disabled, so I stopped." });
	expect(w.find(x => x.id === "st_ask")).toMatchObject({ status: "failed", reason: "빌드가 안 돼요" });
	expect(w.find(x => x.id === "st_ok")!.status).toBe("done");
});

test("a finished worker's [file] lines and backticked document paths that name an existing file become its result files, once each; a missing one, code or a failed worker's are left out", () => {
	const out = join(dir, "out");
	mkdirSync(out);
	writeFileSync(join(out, "비교.md"), "# 비교\n");
	writeFileSync(join(out, "표.csv"), "a,b\n");
	writeFileSync(join(out, "a.ts"), "x\n");
	record("st_files", { status: "completed", terminal_at: iso(T0 + 10_000), final_response: `[done] 정리했어요\n[file] ${join(out, "비교.md")}\n[file] ${join(out, "없음.md")}\n[file] ${out}\n표는 \`${join(out, "표.csv")}\`, 같은 파일 \`${join(out, "비교.md")}\`, 코드는 \`${join(out, "a.ts")}\`` });
	record("st_fail", { status: "failed", terminal_at: iso(T0 + 20_000), final_response: `[file] ${join(out, "비교.md")}` });
	const w = make(() => T0 + 60_000).list();
	expect(w.find(x => x.id === "st_files")!.files).toEqual([{ path: join(out, "비교.md"), name: "비교.md", size: 9 }, { path: join(out, "표.csv"), name: "표.csv", size: 4 }]);
	expect(w.find(x => x.id === "st_fail")!.files).toBeUndefined();
});

test("a failed worker is listed as failed, and finished work leaves the list after an hour", () => {
	record("st_2", { status: "failed", terminal_at: iso(T0 + 30_000) });
	record("st_3", { status: "completed", terminal_at: iso(T0 + 10_000) });
	const at = (ms: number) => make(() => ms).list().map(w => [w.id, w.status]);
	expect(at(T0 + 60_000)).toEqual([["st_2", "failed"], ["st_3", "done"]]);
	expect(at(T0 + 30_000 + FINISHED_KEEP_MS + 1)).toEqual([]);
});

test("running work comes first, oldest first, and only the orchestrator's own session is read", () => {
	record("st_new", { started_at: iso(T0 + 50_000) });
	record("st_old", { started_at: iso(T0 + 1_000) });
	record("st_done", { status: "completed", terminal_at: iso(T0 + 20_000) });
	record("st_other", { root_session_id: "01a159d6-0000-0000-0000-000000000000" });
	expect(make(() => T0 + 90_000).list().map(w => w.id)).toEqual(["st_old", "st_new", "st_done"]);
});

test("a worker that failed at spawn still names its conversation and why, and the hub log keeps the reason once", () => {
	// st_01a17c03 (2026-10-27): status error, started_at == terminal_at, a turn of ours had just spawned it.
	record("st_start", { status: "error", terminal_at: iso(T0 + 400), error_message: "child turn produced no assistant output" });
	const lines: string[] = [];
	const turn = (at: number) => (at === T0 + 400 ? { target: "th:1564523279849357364", replyTo: "m-1" } : undefined);
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], turn, now: () => T0 + 60_000, log: m => lines.push(m) });
	for (let i = 0; i < 3; i++) expect(work.list()[0]).toMatchObject({ id: "st_start", status: "failed", target: "th:1564523279849357364", reply_to: "m-1", error: "child turn produced no assistant output" });
	expect(lines).toEqual(["background work st_start failed in th:1564523279849357364: child turn produced no assistant output"]);
});

test("a finished worker carries the message of its result; an unsure one is asked again, a cancelled or running one never", () => {
	record("st_done", { status: "completed", terminal_at: iso(T0 + 20_000) });
	record("st_run");
	const asked: string[] = [];
	let hit: { at: string; conv: string; exact: boolean } | undefined = { at: iso(T0 + 21_000), conv: "main", exact: false };
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => T0 + 60_000, answer: w => (asked.push(w.id), hit) });
	expect(work.list().find(w => w.id === "st_done")).toMatchObject({ result_at: iso(T0 + 21_000), result_conv: "main" });
	hit = { at: iso(T0 + 22_000), conv: "ch:1", exact: true };
	expect(work.list().find(w => w.id === "st_done")).toMatchObject({ result_at: iso(T0 + 22_000), result_conv: "ch:1" });
	hit = undefined;
	expect(work.list().find(w => w.id === "st_done")).toMatchObject({ result_at: iso(T0 + 22_000), result_conv: "ch:1" });
	expect(asked).toEqual(["st_done", "st_done"]);
});

test("a gateway restart rebuilds the same list from the task store alone", () => {
	record("st_a");
	record("st_b", { status: "completed", terminal_at: iso(T0 + 20_000) });
	const before = make(() => T0 + 90_000).list();
	const after = make(() => T0 + 90_000).list();
	expect(after).toEqual(before);
	expect(after.map(w => [w.id, w.status])).toEqual([["st_a", "running"], ["st_b", "done"]]);
});

test("a record that says running while its process is gone counts as failed, unless a recovery is still due", () => {
	record("st_dead", { pid: 4242 });
	record("st_reviving", { pid: 4343, recovery_deadline_at: iso(T0 + 600_000) });
	const w = make(() => T0 + 90_000, [], pid => pid !== 4242 && pid !== 4343).list();
	expect(w.map(x => [x.id, x.status])).toEqual([["st_reviving", "running"], ["st_dead", "failed"]]);
	expect(w.find(x => x.id === "st_dead")?.ended_at).toBe(T0 + 5000);
});

test("a running worker serves the latest open deferred message delivered before it was spawned", () => {
	record("st_1", { started_at: iso(T0 + 100_000) });
	const open: OpenDeferred[] = [
		{ target: "ch:1", replyTo: "m-early", at: T0 + 10_000 },
		{ target: "web", replyTo: "m-web", at: T0 + 60_000 },
		{ target: "web", replyTo: "m-later", at: T0 + 300_000 },
	];
	expect(make(() => T0 + 120_000, open).list()[0]).toMatchObject({ id: "st_1", target: "web", reply_to: "m-web" });
	expect(make(() => T0 + 120_000, []).list()[0]?.target).toBeUndefined();
});

test("no session yet, an unreadable record and a missing store give an empty list", () => {
	expect(createBgWork({ sessionFile: () => "", deferred: () => [] }).list()).toEqual([]);
	writeFileSync(join(tasks, "broken.json"), "{not json");
	expect(make(() => T0).list()).toEqual([]);
});

test("a worker is tied to the folder its brief names (not its isolated copy) and keeps its conversation after it ends", () => {
	record("st_1", { started_at: iso(T0 + 100_000), spawn_spec: { cwd: "/h/.omo/wt/x/m", isolation: { backend: "rcopy" }, prompt: "Repo: /h/Code/proj (main; work in this checkout)\nDo it." } });
	record("st_2", { started_at: iso(T0 + 101_000), spawn_spec: { cwd: "/h/Code/other", prompt: "no repo line" } });
	record("st_3", { started_at: iso(T0 + 102_000), spawn_spec: { cwd: "/h/.omo/wt/y/m", isolation: {}, prompt: "no repo line" } });
	const open: OpenDeferred[] = [{ target: "ch:9", replyTo: "m-9", at: T0 + 60_000 }];
	const work = make(() => T0 + 120_000, open);
	expect(work.list().map(w => [w.id, w.folder])).toEqual([["st_1", "/h/Code/proj"], ["st_2", "/h/Code/other"], ["st_3", undefined]]);
	open.length = 0;
	record("st_1", { status: "completed", terminal_at: iso(T0 + 150_000), started_at: iso(T0 + 100_000), spawn_spec: { cwd: "/h/Code/other", prompt: "x" } });
	const ended = work.list();
	expect(ended.find(w => w.id === "st_1")).toMatchObject({ status: "done", target: "ch:9", reply_to: "m-9" });
});

test("a worker spawned by a turn serves that turn's message even when an older deferred message is the only one open", () => {
	record("st_1", { started_at: iso(T0 + 100_000) });
	record("st_2", { started_at: iso(T0 + 200_000) });
	const open: OpenDeferred[] = [{ target: "web", replyTo: "m-old", at: T0 + 10_000 }];
	const turn = (at: number) => (at < T0 + 150_000 ? { target: "web", replyTo: "m-1" } : at < T0 + 250_000 ? { target: "web", replyTo: "m-2" } : undefined);
	const work = createBgWork({ sessionFile: () => session, deferred: () => open, turn, now: () => T0 + 300_000 });
	expect(work.list().map(w => [w.id, w.reply_to])).toEqual([["st_1", "m-1"], ["st_2", "m-2"]]);
	// A turn with no message id (a schedule) leaves reply_to empty instead of borrowing the old deferred one.
	const bare = createBgWork({ sessionFile: () => session, deferred: () => open, turn: () => ({ target: "web" }), now: () => T0 + 300_000 });
	expect(bare.list().map(w => [w.target, w.reply_to])).toEqual([["web", undefined], ["web", undefined]]);
});

test("a failed worker carries its reason in Korean and stays listed for the hour, so every screen can offer 다시 맡기기", () => {
	record("st_iso", { status: "failed", terminal_at: iso(T0 + 1_000), error_message: "isolation_unavailable: not a git checkout" });
	record("st_raw", { status: "failed", terminal_at: iso(T0 + 2_000) });
	const list = make(() => T0 + FINISHED_KEEP_MS).list();
	expect(list.map(w => [w.id, w.reason])).toEqual([["st_raw", "이유가 기록되지 않았어요"], ["st_iso", "작업 폴더를 git 저장소로 읽지 못해 시작하지 못했어요"]]);
});

test("다시 맡기기 goes to the conversation the request came from, in the owner's own words when known", () => {
	const keyOf = (thread: string) => (thread === "1564523279849357364" ? "kdb-1" : undefined);
	expect([undefined, "web", "terminal"].map(t => workConversation(t, keyOf))).toEqual(["main", "main", "main"]);
	expect(workConversation("th:1564523279849357364", keyOf)).toBe("mail:kdb-1");
	expect(workConversation("th:1564523279849357365", keyOf)).toBe("main");
	expect(["mail:k2", "ch:42", "settings:w:login"].map(t => workConversation(t, keyOf))).toEqual(["mail:k2", "ch:42", "settings:w:login"]);
	const w = { description: "흐름도 그리기", reason: "이유가 기록되지 않았어요" };
	expect(retryText(w, "흐름도를 HTML로 만들어 줘")).toBe("실패한(이유가 기록되지 않았어요) 백그라운드 작업 \"흐름도 그리기\"을 다시 맡아 주세요.\n\n처음 요청:\n흐름도를 HTML로 만들어 줘");
	expect(retryText({ ...w, cancelled: true })).toBe("중단했던 백그라운드 작업 \"흐름도 그리기\"을 다시 맡아 주세요.");
});

test("중단 really ends the worker's process and lists it as stopped from then on", async () => {
	const proc = Bun.spawn(["sleep", "60"]);
	record("st_live", { pid: proc.pid });
	const lines: string[] = [];
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => T0 + 90_000, log: m => lines.push(m) });
	expect(work.list()[0]).toMatchObject({ id: "st_live", status: "running" });
	expect(await work.cancel("st_live")).toEqual({ ok: true });
	await proc.exited;
	expect(proc.signalCode).toBe("SIGTERM");
	// OmO's record still says running; the list says stopped by the owner, and the restart gate no longer counts it.
	expect(work.list()[0]).toMatchObject({ id: "st_live", status: "failed", cancelled: true, reason: "직접 중단했어요", ended_at: T0 + 90_000 });
	expect(work.running()).toBe(0);
	expect(lines).toEqual([`background work st_live stopped by the owner (pid ${proc.pid})`]);
});

test("중단 kills a worker that ignores SIGTERM, and refuses what it cannot stop", async () => {
	const signals: string[] = [];
	let up = true;
	record("st_stubborn", { pid: 4242 });
	record("st_nopid");
	record("st_done", { status: "completed", terminal_at: iso(T0 + 10_000) });
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => T0 + 90_000, alive: () => up, kill: (_pid, sig) => { signals.push(sig); if (sig === "SIGKILL") up = false; } });
	expect(await work.cancel("st_stubborn")).toEqual({ ok: true });
	expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(await work.cancel("st_nopid")).toMatchObject({ ok: false, status: 409 });
	expect(await work.cancel("st_done")).toMatchObject({ ok: false, status: 409 });
	expect(await work.cancel("st_none")).toMatchObject({ ok: false, status: 404 });
}, 10_000);

test("a lane's running workers are real records: description, start and model", () => {
	record("st_lane", { pid: process.pid, started_at: iso(T0 + 1_000), model: "anthropic-subscription/claude-sonnet-5-5" });
	record("st_lane_done", { status: "completed", terminal_at: iso(T0 + 2_000) });
	expect(runningOmoWork(session)).toEqual([{ id: "st_lane", description: "삼성 인터넷 사진첩 업로드 고치기", status: "running", started_at: T0 + 1_000, model: "Sonnet 5.5" }]);
	expect(runningOmoWork(undefined)).toEqual([]);
});

test("a worker names the model it runs on, as OmO's record says (Mac mini st_01a17c04, 2026-10-27)", () => {
	const opus = { provider: "anthropic-subscription", model_id: "claude-opus-5-5", display: "Claude Opus 5.5", variant: "medium", reasoning_effort: "medium", source: "category" };
	record("st_m", { model: "anthropic-subscription/claude-opus-5-5", requested_model: { ...opus, display: "anthropic-subscription/claude-opus-5-5" }, resolved_model: opus, effective_model: { provider: "anthropic-subscription", model_id: "claude-opus-5-5", display: "anthropic-subscription/claude-opus-5-5" } });
	expect(make(() => T0 + 60_000).list()[0]!.model).toBe("Opus 5.5 medium");
	expect(workModel({ model: "openai-codex/gpt-5.5" })).toBe("Gpt 5.5");
	expect(workModel({})).toBeUndefined();
});

// Owner 2026-10-29: "왜 재요청을 나에게 물어보지? 알아서 수정해서 목표 달성해야지" - a failure is the session's to take up.
test("a failure a later turn took up is handled; one no turn took up is handed back once, only after the grace time and only to an idle session", () => {
	record("st_fail", { status: "failed", terminal_at: iso(T0 + 10_000), error_message: "Concurrent turn admission" });
	let t = T0 + 20_000, ended = T0, busy = false;
	const handed: string[] = [];
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => t, turnEndedAt: () => ended, busy: () => busy, handover: w => handed.push(w.id) });
	expect(work.list()[0]!.handled).toBeUndefined();
	expect(handed).toEqual([]);
	t = T0 + 10_000 + HANDOVER_AFTER_MS;
	busy = true;
	work.list();
	expect(handed).toEqual([]);
	busy = false;
	work.list();
	work.list();
	expect(handed).toEqual(["st_fail"]);
	ended = T0 + 10_001 + HANDOVER_AFTER_MS;
	expect(work.list()[0]).toMatchObject({ id: "st_fail", status: "failed", handled: true });
});

// OmO's task log (logs/<id>.jsonl) and a worker transcript, each stamped with the time it was last written.
const activity = (id: string, events: string[], logAt: number, transcriptAt: number) => {
	const store = join(dir, "projects", "p1", "senpi-task");
	const logs = join(store, "logs");
	const sessions = join(store, "children", id, "sessions", id);
	mkdirSync(logs, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	const log = join(logs, `${id}.jsonl`);
	writeFileSync(log, events.map(type => JSON.stringify({ type, payload: type === "child_error" ? { message: "The anthropic-subscription account usage limit has been reached (resets 5:20pm (Asia/Seoul) (rate_limit))." } : {} })).join("\n") + "\n");
	utimesSync(log, logAt / 1000, logAt / 1000);
	const transcript = join(sessions, "2026-10-21T06-00-00-000Z_x.jsonl");
	writeFileSync(transcript, "{}\n");
	utimesSync(transcript, transcriptAt / 1000, transcriptAt / 1000);
};

test("a worker whose run ended on a usage limit but stays running (st_01a19af7) is stalled: not counted, its session woken once", () => {
	record("st_lim", { spawn_spec: { cwd: "/tmp/wt-x", isolation: true } });
	activity("st_lim", ["tool_execution", "assistant_message", "child_error"], T0 + 70_000, T0 + 60_000);
	let t = T0 + 70_000 + STALL_ERROR_MS - 1;
	let busy = true;
	const woke: string[] = [];
	const lines: string[] = [];
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => t, log: m => lines.push(m), busy: () => busy, stalled: w => woke.push(w.id) });
	// A retry or fallback may still follow the error for a moment.
	expect(work.running()).toBe(1);
	t += 2;
	expect(work.running()).toBe(0);
	expect(work.list()[0]).toMatchObject({ id: "st_lim", status: "stalled", ended_at: T0 + 70_000, workdir: "/tmp/wt-x", error: expect.stringContaining("usage limit") });
	expect(woke).toEqual([]);
	busy = false;
	for (let i = 0; i < 3; i++) (work.list(), work.running());
	expect(woke).toEqual(["st_lim"]);
	expect(lines.filter(l => l.includes("st_lim stalled"))).toHaveLength(1);
	expect(work.takeStalled()).toEqual([]);
});

test("an active worker is running; one silent for the idle limit is stalled", () => {
	record("st_act");
	record("st_idle");
	const t = T0 + 30 * 60_000;
	activity("st_act", ["child_error", "retry_fallback_applied", "tool_execution"], t - 60_000, t - 30_000);
	activity("st_idle", ["tool_execution"], t - 16 * 60_000, t - 20 * 60_000);
	const woke: string[] = [];
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => t, stallMs: 15 * 60_000, stalled: w => woke.push(w.id) });
	expect(work.list().map(w => [w.id, w.status, w.reason])).toEqual([["st_act", "running", undefined], ["st_idle", "stalled", "16분째 활동이 없어요"]]);
	expect(work.running()).toBe(1);
	expect(woke).toEqual(["st_idle"]);
});

test("while the session is paused on a usage limit no wake goes out; its resume note takes the stalled worker once", () => {
	record("st_lim");
	activity("st_lim", ["child_error"], T0, T0);
	let paused = true;
	const woke: string[] = [];
	const work = createBgWork({ sessionFile: () => session, deferred: () => [], now: () => T0 + STALL_ERROR_MS, paused: () => paused, stalled: w => woke.push(w.id) });
	expect(work.running()).toBe(0);
	expect(work.takeStalled().map(w => w.id)).toEqual(["st_lim"]);
	paused = false;
	work.list();
	expect(woke).toEqual([]);
	expect(work.takeStalled()).toEqual([]);
});

const taskLog = (id: string, events: object[]) => {
	mkdirSync(join(tasks, "..", "logs"), { recursive: true });
	writeFileSync(join(tasks, "..", "logs", id + ".jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
};
const said = (text: string) => ({ type: "assistant_message", payload: { text } });
const ran = (tool: string) => ({ type: "tool_execution", payload: { tool, is_error: false } });
const done = { type: "transition_applied", payload: { status: "completed" } };

test("a line that only closed the todo list does not replace the report before it, for the work row and result files (st_01a1a465)", () => {
	const file = join(dir, "속도측정.md");
	writeFileSync(file, "x");
	const report = "[done] 커밋 6301f32를 올렸어요. " + "측정 결과 ".repeat(40) + "\n[file] " + file;
	const closing = "할 일 목록이 갱신되지 않은 채 남아 있어서 전부 완료로 닫았어요.";
	record("st_1", { status: "completed", terminal_at: iso(T0 + 9000), final_response: closing });
	taskLog("st_1", [ran("eval"), said(report), ran("todo"), ran("todo"), said(closing), done]);
	const bg = make(() => T0 + 60_000);
	expect(bg.list()[0]!.files?.map(f => f.path)).toEqual([file]);
	expect(bg.reportOf("st_1")).toBe(report);
});

test("a trailing line after a [fail] report leaves the worker failed", () => {
	const report = "[fail] 토큰 한도로 멈췄어요. " + "남은 일 ".repeat(60);
	record("st_1", { status: "completed", terminal_at: iso(T0 + 9000), final_response: "할 일만 닫았어요." });
	taskLog("st_1", [said(report), ran("todo"), said("할 일만 닫았어요."), done]);
	expect(make(() => T0 + 60_000).list()[0]!.status).toBe("failed");
});

test("a short last message stays the report when work ran after the long one, it carries a status mark, or it is itself long", () => {
	const long = "중간 계획 ".repeat(60);
	const cases: [string, object[]][] = [
		["커밋 abc를 올렸어요.", [said(long), ran("eval"), said("커밋 abc를 올렸어요."), done]],
		["[done] 올렸어요.", [said(long), ran("todo"), said("[done] 올렸어요."), done]],
		["끝.", [said("짧은 메모"), ran("todo"), said("끝."), done]],
		[long, [said(long + long), ran("todo"), said(long), done]],
	];
	for (const [i, [last, events]] of cases.entries()) {
		record("st_" + i, { status: "completed", terminal_at: iso(T0 + 9000), final_response: last });
		taskLog("st_" + i, events);
	}
	const bg = make(() => T0 + 60_000);
	bg.list();
	for (const i of cases.keys()) expect(bg.reportOf("st_" + i)).toBeUndefined();
});

test("after a restart a worker keeps the request of its stored link, with no turn to ask", () => {
	record("st_1");
	record("st_2", { status: "completed", terminal_at: iso(T0 + 9000) });
	const links = new Map([["st_1", { target: "web", replyTo: "m1" }], ["st_2", { target: "ch:1", replyTo: "m2" }]]);
	const bg = createBgWork({ sessionFile: () => session, deferred: () => [{ target: "other", replyTo: "newer", at: T0 }], now: () => T0 + 60_000, linkOf: id => links.get(id) });
	expect(bg.list().map(w => [w.id, w.target, w.reply_to])).toEqual([["st_1", "web", "m1"], ["st_2", "ch:1", "m2"]]);
});

test("a worker tied to a request by its turn is recorded as a link, so the tie outlives the process", () => {
	record("st_1");
	const seen: unknown[] = [];
	createBgWork({ sessionFile: () => session, deferred: () => [], now: () => T0 + 60_000, turn: () => ({ target: "web", replyTo: "m1" }), link: (id, to) => seen.push([id, to]) }).list();
	expect(seen).toEqual([["st_1", { target: "web", replyTo: "m1" }]]);
});

test("a worker OmO holds is queued, never stalled however long it waits, and stops being queued when it runs", () => {
	record("st_q", { status: "queued", started_at: undefined, updated_at: iso(T0) });
	const t = T0 + 60 * 60_000;
	const work = make(() => t);
	expect(work.list()).toMatchObject([{ id: "st_q", status: "running", queued: true }]);
	expect(work.queuedWork(session).map(w => w.id)).toEqual(["st_q"]);
	record("st_q", { status: "running", pid: 1, updated_at: iso(t) });
	expect(work.queuedWork(session)).toEqual([]);
	expect(work.list()[0]!.queued).toBeUndefined();
});
