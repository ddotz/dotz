// A lane launch moves only the launching session's own owner turn into the lane's thread (incident 2026-11-11 22:18 UTC): a
// conversation session handed main a list of fixes, main started a lane in that turn, and the handed turn was moved to
// the lane, so its workers and its answer went into the lane's conversation instead of back to the session.
// Real launch route, real prompt queues; a fake lane runtime and a fake Discord REST server stand in for the outside.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import { convs } from "./convsessions.ts";
import * as discord from "./discord.ts";
import { queue } from "./outbound.ts";
import { routeLanes } from "./routes-lanes.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const WORK = "1000000000000000001";
const OTHER = "1000000000000000002";

class FakeAgent implements AgentProcess {
	pid = 7700;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events: AsyncIterable<AgentEvent> = { [Symbol.asyncIterator]: async function* () {} };
	send = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(143);
}
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start: () => new FakeAgent(),
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};

let server: ReturnType<typeof Bun.serve>;
const savedLanes = cfg.lanes;
beforeAll(() => {
	process.env.DOTZ_NO_ORCHESTRATOR = "1";
	server = Bun.serve({ port: 0, fetch: () => Response.json({ id: "m1" }) });
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
	delete process.env.DOTZ_NO_ORCHESTRATOR;
	delete adapters.fakeomo;
	cfg.lanes = savedLanes;
});
beforeEach(() => {
	queue.settleTurn();
	discord.status.enabled = true;
	Object.assign(discord.channels, { category: "cat", worklog: "worklog", lanes: {}, homes: {}, work: { [WORK]: "big-bath", [OTHER]: "usage" }, threads: {} });
});

// The lane's thread already exists, so the launch needs no Discord call to have a channel (discord.ts laneChannel).
async function startLane(name: string, session?: string): Promise<Response> {
	const cwd = join(DATA, `${name}-work`);
	mkdirSync(cwd, { recursive: true });
	discord.channels.lanes[name] = `thr-${name}`;
	const body = { name, cwd, title: "사용량 화면 개선", brief: "사용량 화면을 고쳐요.\nDone when: 화면이 맞게 나와요", why: "the owner asked for a multi-hour usage screen rework", owner_asked_for_lane: true, force: true, ...(session ? { session } : {}) };
	const url = new URL("http://hub/api/lanes");
	return (await routeLanes(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, ["api", "lanes"]))!;
}

test("work a conversation session handed to main keeps its target when main starts a lane in that turn", async () => {
	const text = `[conversation ch:${WORK}] 점검에서 메인이 맡을 것만 추려요`;
	queue.deliver(text, { target: `ch:${WORK}`, from: `ch:${WORK}` });
	queue.onPrompt(text);
	expect((await startLane("handed-lane")).status).toBe(200);
	expect(queue.current()).toMatchObject({ target: `ch:${WORK}`, from: `ch:${WORK}` });
});

test("the owner's own turn in a work channel still moves into the new lane's thread", async () => {
	const text = "owner message 1000000000000090999";
	queue.deliver(text, { target: `ch:${WORK}`, replyTo: "1000000000000090999", owner: true });
	queue.onPrompt(text);
	expect((await startLane("usage-owner")).status).toBe(200);
	expect(queue.current()?.target).toBe("lane:usage-owner");
});

test("an owner request replayed without its owner mark (restart, re-ask, wake) still moves into the new lane's thread", async () => {
	const text = "owner message 1000000000000090998";
	queue.deliver(text, { target: `ch:${WORK}`, replyTo: "1000000000000090998" });
	queue.onPrompt(text);
	expect((await startLane("usage-replayed")).status).toBe(200);
	expect(queue.current()?.target).toBe("lane:usage-replayed");
});

test("a launch naming a session the gateway does not hold never takes main's running turn", async () => {
	const text = "owner message 1000000000000090997";
	queue.deliver(text, { target: `ch:${WORK}`, replyTo: "1000000000000090997", owner: true });
	queue.onPrompt(text);
	expect((await startLane("usage-stranger", "ch:1000000000000099999")).status).toBe(200);
	expect(queue.current()?.target).toBe(`ch:${WORK}`);
});

test("a lane a conversation session starts moves that session's owner turn, never main's", async () => {
	const conv = convs.ensure(`ch:${OTHER}`);
	const mainText = "owner message 1000000000000091000";
	queue.deliver(mainText, { target: `ch:${WORK}`, replyTo: "1000000000000091000", owner: true });
	queue.onPrompt(mainText);
	const convText = "owner message 1000000000000091001";
	conv.queue.deliver(convText, { target: `ch:${OTHER}`, replyTo: "1000000000000091001", owner: true });
	conv.queue.onPrompt(convText);
	expect((await startLane("usage-conv", conv.key)).status).toBe(200);
	expect(conv.queue.current()?.target).toBe("lane:usage-conv");
	expect(queue.current()?.target).toBe(`ch:${WORK}`);
});
