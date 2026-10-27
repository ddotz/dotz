import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgWork, FINISHED_KEEP_MS, type OpenDeferred, workModel } from "./bgwork.ts";

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

test("a worker names the model it runs on, as OmO's record says (Mac mini st_01a17c04, 2026-10-27)", () => {
	const opus = { provider: "anthropic-subscription", model_id: "claude-opus-5-5", display: "Claude Opus 5.5", variant: "medium", reasoning_effort: "medium", source: "category" };
	record("st_m", { model: "anthropic-subscription/claude-opus-5-5", requested_model: { ...opus, display: "anthropic-subscription/claude-opus-5-5" }, resolved_model: opus, effective_model: { provider: "anthropic-subscription", model_id: "claude-opus-5-5", display: "anthropic-subscription/claude-opus-5-5" } });
	expect(make(() => T0 + 60_000).list()[0]!.model).toBe("Opus 5.5 medium");
	expect(workModel({ model: "openai-codex/gpt-5.5" })).toBe("Gpt 5.5");
	expect(workModel({})).toBeUndefined();
});
