// A running lane's task-worker model can change (2026-11-03: the owner moved prototype-to-product's workers to Sonnet, but
// the chip and the settings card's "사용 중" kept the launch-time DeepSeek because nothing could change it after launch).
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_TOKEN, workerModel } from "./config.ts";
import { modelsView } from "./control.ts";
import { emit } from "./events.ts";
import { dir, lanes, type Lane } from "./lanestate.ts";
import { laneModels, laneSummary } from "./laneviews.ts";
import { makeRoute } from "./routes.ts";

const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);
afterAll(() => spy.mockRestore());

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-ultrafast:high", SONNET = "anthropic/claude-sonnet-5-5:high";
let sent: [string, string][] = [];
const lane = (name: string, status: Lane["status"]): Lane => ({ name, cwd: "/tmp", model: "anthropic/claude-opus-5-5:high", workerModel: DEEPSEEK, activeWorkerModel: DEEPSEEK, status, startedAt: "", reports: 0, ctx: {} as Lane["ctx"], lastText: "", proc: { send: (t: string, how: string) => sent.push([t, how]) } as unknown as Lane["proc"] });
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
// A token request changes a model only on an owner message that says so (hub/model-guard.ts): the owner asks in the target's own conversation.
let asks = 0;
const ownerAsk = (body: Record<string, unknown>): string => {
	const mid = `ask-${++asks}`, lane = String(body.target).startsWith("lane:") ? String(body.target).slice(5) : undefined;
	emit("inbox", { ts: new Date(Date.now()).toISOString(), kind: lane ? "lane_message" : "message", source: "web", mid, text: `워커 모델은 ${body.worker_model}로`, ...(lane ? { lane } : {}) });
	return mid;
};
const put = async (body: Record<string, unknown>) => {
	const res = await route(new Request("http://127.0.0.1/api/target", { method: "PUT", headers: { "x-dotz-token": HUB_TOKEN }, body: JSON.stringify({ ...body, owner_message: ownerAsk(body) }) }));
	return { status: res.status, body: (await res.json()) as { applied?: string; worker_model?: string; error?: string } };
};
const view = (name: string) => ({ chip: laneSummary().find(l => l.name === name)!.worker_model, active: laneModels().find(l => l.name === name)!.active_worker_model });
const onDisk = (name: string) => JSON.parse(readFileSync(join(dir(name), "lane.json"), "utf8")).workerModel;

beforeEach(() => {
	lanes.clear();
	sent = [];
});
afterEach(() => lanes.clear());

test("PUT /api/target worker_model moves a running lane's workers: lane view, lane.json and the lane's next prompt", async () => {
	lanes.set("p2p", lane("p2p", "idle"));
	const r = await put({ target: "lane:p2p", worker_model: SONNET });
	expect(r.status).toBe(200);
	expect(r.body).toMatchObject({ applied: "live", worker_model: SONNET });
	expect(view("p2p")).toEqual({ chip: SONNET, active: SONNET });
	expect(onDisk("p2p")).toBe(SONNET);
	expect((await modelsView()).fallbacks.workers.active).toEqual(["anthropic/claude-sonnet-5-5"]);
	// idle: no extra turn, the note rides on its next prompt
	expect(sent).toEqual([]);
	expect(lanes.get("p2p")!.workerNext).toContain(SONNET);
});

test("a working lane is steered at once; a switch the lane records itself is not echoed back", async () => {
	lanes.set("busy", lane("busy", "working"));
	await put({ target: "lane:busy", worker_model: SONNET });
	expect(sent.length).toBe(1);
	expect(sent[0]![1]).toBe("steer");
	lanes.set("self", lane("self", "idle"));
	const r = await put({ target: "lane:self", worker_model: "anthropic/claude-sonnet-5-5", by: "lane" });
	expect(r.body.worker_model).toBe(SONNET);
	expect(view("self").chip).toBe(SONNET);
	expect(lanes.get("self")!.workerNext).toBeUndefined();
	expect(sent.length).toBe(1);
});

test("a global worker-model change wins over a running lane's launch-time value", async () => {
	lanes.set("p2p", lane("p2p", "idle"));
	const before = workerModel();
	try {
		const r = await put({ target: "workers", worker_model: SONNET });
		expect(r.status).toBe(200);
		expect(view("p2p")).toEqual({ chip: SONNET, active: SONNET });
		expect(onDisk("p2p")).toBeUndefined();
		expect((await modelsView()).fallbacks.workers.active).toEqual(["anthropic/claude-sonnet-5-5"]);
	} finally {
		await put({ target: "workers", worker_model: before });
	}
});

test("worker_model needs a lane or the workers target", async () => {
	const r = await put({ target: "lane:nope", worker_model: SONNET });
	expect(r.status).toBe(400);
});
