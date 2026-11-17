import { afterEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgWork, DEAD_WORK_MS, deadOmoWork, OMP_SOURCE, quietOmpWork, STALL_ERROR_MS } from "./bgwork.ts";
import { ompDeadWork, ompFailedWork } from "./omp-deadwork.ts";
import { ompTree } from "./runtime/test-omp-session.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tree = (name: string, ageMs?: number) => {
	const dir = mkdtempSync(join(tmpdir(), "omp-deadwork-"));
	dirs.push(dir);
	return ompTree(name, dir, ageMs);
};
const dead = (file: string, live?: number) => ompDeadWork(file, live, { now: Date.now(), maxAgeMs: DEAD_WORK_MS });
const failed = (file: string, quietMs = STALL_ERROR_MS) => ompFailedWork(file, { now: Date.now(), maxAgeMs: DEAD_WORK_MS, quietMs });
const names = (workers: { name: string }[]) => workers.map(w => w.name);

const DEAD: [string, string][] = [
	["killed", "Dozer"],
	["termed", "Trapper"],
	["revived", "Reviver"],
	["failed-dead", "Failer3"],
	["torn", "Failer"],
];
const NOT_DEAD = ["finished", "waited", "failed-settled"];

test.each(DEAD)("a real omp session whose process died with a worker (%s) names %s dead", (fixture, worker) => {
	const { file } = tree(fixture);
	expect(names(dead(file))).toEqual([worker]);
	expect(dead(file)[0].description.startsWith(`${worker}: `)).toBe(true);
});

test.each(NOT_DEAD)("a worker whose result came back or was waited for (%s) is not dead", fixture => {
	expect(dead(tree(fixture).file)).toEqual([]);
});

test("a process started after the worker never owned it; one started before it did", () => {
	const { file } = tree("killed");
	const [w] = dead(file);
	expect(dead(file, w.started_at + 1)).toHaveLength(1);
	expect(dead(file, w.started_at)).toEqual([]);
	expect(dead(file, w.started_at - 60_000)).toEqual([]);
});

test("a death older than the dead-work window is history", () => {
	expect(dead(tree("killed", DEAD_WORK_MS + HOUR).file)).toEqual([]);
	expect(names(dead(tree("killed", DEAD_WORK_MS - HOUR).file))).toEqual(["Dozer"]);
});

test("a result appended after the spawn closes the worker, and a rewritten file is read afresh", () => {
	const { file } = tree("killed");
	expect(names(dead(file))).toEqual(["Dozer"]);
	const result = { type: "custom_message", customType: "async-result", timestamp: new Date(Date.now()).toISOString(), details: { jobs: [{ jobId: "Dozer", type: "task", status: "completed", agentId: "Dozer" }] } };
	appendFileSync(file, `${JSON.stringify(result)}\n`);
	expect(dead(file)).toEqual([]);
	cpSync(tree("termed").file, file);
	expect(names(dead(file))).toEqual(["Trapper"]);
});

test("a torn last line of the session file does not hide the workers before it", () => {
	const { file } = tree("killed");
	appendFileSync(file, '{"type":"message","message":{"role":"toolRes');
	expect(names(dead(file))).toEqual(["Dozer"]);
	appendFileSync(file, 'ult"}}\n');
	expect(names(dead(file))).toEqual(["Dozer"]);
});

test("a file that is not omp's has no dead workers and no failed ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-deadwork-"));
	dirs.push(dir);
	const file = join(dir, "2026-11-04T14-58-11-507Z_01a1a711-4db3-7aa6-8fd6-bd53b48fb0f0.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: new Date().toISOString() })}\n`);
	expect(dead(file)).toEqual([]);
	expect(failed(file)).toEqual([]);
	expect(deadOmoWork(file)).toEqual([]);
	expect(dead(join(dir, "missing.jsonl"))).toEqual([]);
});

test.each([
	["failed-dead", "Failer3", /Couldn't reach/],
	["failed-settled", "Failer2", /Couldn't reach/],
	["torn", "Failer", /connection refused/],
])("a worker whose transcript ends on a failed model request (%s) is failed with the provider's text", (fixture, worker, text) => {
	const [w] = failed(tree(fixture).file);
	expect(w.name).toBe(worker);
	expect(w.error).toMatch(text);
});

test.each(["killed", "termed", "finished", "waited", "revived"])("a worker that did not fail on a model request (%s) is not failed", fixture => {
	expect(failed(tree(fixture).file)).toEqual([]);
});

test("a failed worker is failed only once its transcript went quiet", () => {
	const { file } = tree("failed-dead");
	expect(failed(file, 10 * HOUR)).toEqual([]);
	expect(failed(file, 1)).toHaveLength(1);
});

test("the work rows: dead omp workers fail, quiet failed ones stall, with the provider's reason, and OmO's rows are unchanged", () => {
	const { file } = tree("failed-dead");
	const [row] = createBgWork({ sessionFile: () => file, deferred: () => [] }).deadWork(file);
	expect(row).toMatchObject({ id: expect.stringMatching(/^Failer3~/), status: "failed", source: OMP_SOURCE });
	expect(row.description).toStartWith("Failer3: ");
	expect(deadOmoWork(file, undefined).map(w => w.id)).toEqual([row.id]);
	expect(deadOmoWork(file, row.started_at)).toEqual([]);
	const [quiet] = quietOmpWork(file);
	expect(quiet).toMatchObject({ id: row.id, status: "stalled", source: OMP_SOURCE });
	expect(quiet.error).toMatch(/Couldn't reach/);
	expect(quiet.reason).toBeTruthy();
	expect(quietOmpWork(tree("killed").file)).toEqual([]);
	expect(quietOmpWork(undefined)).toEqual([]);
});
