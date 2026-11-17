import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import { type Lane, laneWorkers, lanes } from "./lanes.ts";
import { makeRoute } from "./routes.ts";
import { emitEventActivity } from "./activity.ts";
import { newCtx } from "./context.ts";

const DATA = process.env.DOTZ_DIR!;
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const todoLine = JSON.stringify({ type: "message", id: "t", timestamp: "2026-11-01T00:00:00.000Z", message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: "Remaining items" }], details: { phases: [{ name: "build", tasks: [{ content: "ship it", status: "pending" }] }] } } });
let tick = 0;

function ompLane(awaiting: { now: boolean }): Lane {
	const name = `rw-${++tick}`;
	mkdirSync(DATA, { recursive: true });
	const sessionFile = join(DATA, `${name}.jsonl`);
	writeFileSync(sessionFile, `${todoLine}\n`);
	const lane = { name, cwd: "/tmp", model: "m", status: "idle", startedAt: "", reports: 0, lastText: "", ctx: newCtx(), runtime: "omp", sessionFile, proc: { awaitingAsync: () => awaiting.now } } as unknown as Lane;
	lanes.set(name, lane);
	return lane;
}
const runOf = async (name: string) => {
	const res = await route(new Request("http://127.0.0.1/api/state", { headers: { "x-dotz-token": HUB_TOKEN } }));
	return ((await res.json()) as { runs: Record<string, { kind: string; reason?: string }> }).runs[`lane:${name}`];
};
afterAll(() => lanes.clear());

test("L-09: an omp lane with plan tasks left that waits on its own background job reads as waiting, not as resting with work unfinished", async () => {
	const awaiting = { now: true };
	const lane = ompLane(awaiting);
	expect(await runOf(lane.name)).toMatchObject({ kind: "waiting", reason: "work" });
	awaiting.now = false;
	expect(await runOf(lane.name)).toMatchObject({ kind: "idle" });
});

test("L-18: the restart wait counts an omp lane's running subagents like OmO's background workers", () => {
	const lane = ompLane({ now: false });
	expect(laneWorkers(lane)).toBe(0);
	emitEventActivity(`lane:${lane.name}`, { type: "subagent", update: { id: "Scout", description: "survey", status: "running" } });
	emitEventActivity(`lane:${lane.name}`, { type: "subagent", update: { id: "Mapper", description: "map", status: "running" } });
	expect(laneWorkers(lane)).toBe(2);
});
