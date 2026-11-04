import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { omoWorkById } from "./bgwork.ts";
import { createWorkRows, type WorkRow } from "./workrows.ts";

const T0 = Date.parse("2026-11-04T06:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let dir: string, tasks: string, pushed: WorkRow[][], t: number;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dz-workrows-"));
	tasks = join(dir, "projects", ".p1", "senpi-task", "tasks");
	mkdirSync(tasks, { recursive: true });
	pushed = [];
	t = T0 + 60_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const record = (id: string, over: Record<string, unknown> = {}) =>
	writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ task_id: id, status: "running", root_session_id: "another-session", created_at: iso(T0), updated_at: iso(T0), pid: process.pid, description: "일", ...over }));
const make = (answer: Parameters<typeof createWorkRows>[0]["answer"] = () => undefined) =>
	createWorkRows({ find: id => omoWorkById(id, [join(dir, "projects")]), answer, replyOf: () => undefined, push: items => pushed.push(items), now: () => t });
const row = (worker: string) => ({ ts: iso(T0), kind: "out", source: "gateway", target: "web", text: "백그라운드 작업으로 맡겼어요: 일", system: "deferred", worker });

test("a followed job is pushed once per change, in any session's store, with its result link", () => {
	record("st_a1");
	const rows = make(() => ({ at: iso(T0 + 90_000), conv: "main", exact: true }));
	rows.seen(row("st_a1"));
	rows.sweep();
	rows.sweep();
	expect(pushed.map(p => p.map(r => r.status))).toEqual([["running"]]);
	record("st_a1", { status: "completed", terminal_at: iso(T0 + 80_000) });
	rows.sweep();
	rows.sweep();
	expect(pushed.at(-1)).toEqual([{ id: "st_a1", status: "done", created_at: T0, ended_at: T0 + 80_000, result_at: iso(T0 + 90_000), result_conv: "main", at: t }]);
	expect(pushed).toHaveLength(2);
});

test("a load reconciles what ended while the gateway was down: a new instance says it from the store alone", () => {
	record("st_b1", { status: "error", terminal_at: iso(T0 + 1000), error_message: "boom" });
	record("st_b2", { status: "cancelled", terminal_at: iso(T0 + 1000) });
	record("st_b3", { status: "interrupted", terminal_at: iso(T0 + 1000) });
	const stamped = make().stamp([row("st_b1"), row("st_b2"), row("st_b3"), row("st_gone"), { ...row("x"), system: undefined, worker: undefined }]);
	expect(stamped.map(e => e.work && [e.work.status, e.work.cancelled ?? false])).toEqual([["failed", false], ["failed", true], ["failed", true], ["gone", false], undefined]);
});

test("a stamped running job is followed, so its end is pushed without any row being written after the restart", () => {
	record("st_c1");
	const rows = make();
	rows.stamp([row("st_c1")]);
	record("st_c1", { status: "completed", terminal_at: iso(T0 + 1000) });
	rows.sweep();
	expect(pushed.at(-1)?.map(r => r.status)).toEqual(["done"]);
});

test("a job the owner stopped is 중단됨 even while its record still says running", () => {
	record("st_d1");
	const rows = make();
	rows.seen(row("st_d1"));
	rows.stopped("st_d1");
	expect(pushed.at(-1)).toEqual([{ id: "st_d1", status: "failed", created_at: T0, cancelled: true, ended_at: t, at: t }]);
});

test("a new row on a settled id follows the job that took the id over", () => {
	record("st_e1", { status: "cancelled", terminal_at: iso(T0 + 1000) });
	const rows = make();
	expect(rows.stamp([row("st_e1")])[0]?.work?.cancelled).toBe(true);
	record("st_e1", { created_at: iso(T0 + 50_000) });
	rows.seen(row("st_e1"));
	rows.sweep();
	expect(pushed.at(-1)).toEqual([{ id: "st_e1", status: "running", created_at: T0 + 50_000, at: t }]);
});

test("nothing is claimed when no store can be read", () => {
	const rows = createWorkRows({ find: () => null, answer: () => undefined, replyOf: () => undefined, push: items => pushed.push(items) });
	expect(rows.stamp([row("st_f1")])[0]).toEqual(row("st_f1"));
	rows.sweep();
	expect(pushed).toEqual([]);
});
