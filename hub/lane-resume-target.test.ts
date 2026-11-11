// lane:<name> keeps its place across stop -> resume (and a gateway restart in between, which reloads the lane from lane.json):
// a thread lane posts to its thread again, a lane started from the web posts to its web conversation instead of being dropped
// as an unknown Discord target (notify-relay-cleanup 2026-11-02, aside-focus 2026-10-19). Fake Discord REST server and agent.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./config.ts";
import * as discord from "./discord.ts";
import { setWebLane } from "./discord-post.ts";
import { lanes, launch, restoreLanes, resumeByName, stopLane } from "./lanes.ts";
import { dir, keepHome, laneSpot, persist, rememberSpot, resetLaneStateForTest } from "./lanestate.ts";
import { send } from "./outbound.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7600;
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
let spawned = 0;
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start() {
		spawned++;
		return new FakeAgent();
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};

const posts: { channel: string; content: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/api\/v10/, "");
			const m = /^\/channels\/([^/]+)\/messages$/.exec(path);
			if (req.method === "POST" && m) posts.push({ channel: m[1]!, content: (await req.json()).content });
			return Response.json({ id: `m${posts.length}` });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	// What main.ts installs: lane:<name> reads the lane record, and a web lane is one whose record says so.
	discord.setLaneRecords({ read: laneSpot, remember: rememberSpot });
	setWebLane(name => laneSpot(name)?.web === true);
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});
beforeEach(() => {
	posts.length = 0;
	discord.status.enabled = true;
	Object.assign(discord.channels, { worklog: "worklog", lanes: {}, homes: {}, work: { proj: "proj" }, threads: {} });
});

function launched(name: string): void {
	const cwd = join(DATA, `${name}-work`);
	mkdirSync(cwd, { recursive: true });
	const lane = launch(name, cwd, "Tidy the notices.\nDone when: owner approves");
	const session = join(DATA, `${name}.jsonl`);
	writeFileSync(session, "");
	lane.sessionFile = session;
	persist(lane);
}

// The owner's stop (control.ts /stop), then a gateway restart that reloads the lane from disk, then a message that resumes it.
async function stopRestartResume(name: string): Promise<void> {
	stopLane(name);
	keepHome(lanes.get(name), discord.homeOf(name));
	await discord.releaseLane(name, lanes.get(name));
	await flush();
	lanes.delete(name);
	restoreLanes();
	const before = spawned;
	resumeByName(name, "이어서 해 주세요");
	expect(spawned).toBe(before + 1);
	posts.length = 0;
}

test("a web lane launched without a Discord home is delivered to its web conversation after stop, restart and resume", async () => {
	launched("webby");
	// routes-lanes.ts: started from the web, no Discord place.
	const lane = lanes.get("webby")!;
	lane.web = true;
	persist(lane);
	expect((await send("lane:webby", "시작했어요")).delivered).toBe(true);
	await stopRestartResume("webby");
	expect(JSON.parse(readFileSync(join(dir("webby"), "lane.json"), "utf8")).web).toBe(true);
	expect(lanes.get("webby")!.web).toBe(true);
	const r = await send("lane:webby", "한도가 풀려서 이어서 할게요");
	expect(r).toEqual({ delivered: true });
	expect(posts).toEqual([]);
});

test("a thread lane gets its thread back when it is resumed after a stop dropped the channel mapping", async () => {
	launched("thready");
	discord.channels.lanes.thready = "thr1";
	discord.channels.homes.thready = "proj";
	rememberSpot("thready", "thr1", "proj");
	await stopRestartResume("thready");
	expect(discord.channels.lanes.thready).toBeUndefined();
	const r = await send("lane:thready", "다시 시작했어요");
	expect(r.delivered).toBe(true);
	expect(posts).toEqual([{ channel: "thr1", content: "다시 시작했어요" }]);
});
