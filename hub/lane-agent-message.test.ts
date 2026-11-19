import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as l from "./lanes.ts";
import { dir, resetLaneStateForTest } from "./lanestate.ts";
import { routeSend } from "./routes-send.ts";
import { cfg, HUB_TOKEN } from "./config.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7600;
	sent: { text: string; mode: SendMode }[] = [];
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	async push(...events: AgentEvent[]): Promise<void> {
		this.queue.push(...events);
		this.wake.resolve();
		await flush();
	}
	awaitingAsync = () => false;
	send = (text: string, mode: SendMode) => void this.sent.push({ text, mode });
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => void this.exit.resolve(0);
}

const spawns: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "live", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(_opts: SpawnOpts) {
		const agent = new FakeAgent();
		spawns.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};
const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fakeomp = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomp" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
	l.setNoticeHandler(() => {});
});
afterAll(() => {
	delete adapters.fakeomp;
	Object.assign(cfg, savedCfg);
});

const post = (body: object, token: boolean) => {
	const url = new URL("http://hub.test/api/message");
	return routeSend(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-dotz-token": HUB_TOKEN } : {}) }, body: JSON.stringify(body) }), url, ["api", "message"], { peer: "none" }).then(r => r!);
};

async function laneAskingBudget(name: string): Promise<FakeAgent> {
	const cwd = join(DATA, `${name}-work`);
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Build it.\nDone when: it builds");
	const agent = spawns.at(-1)!;
	lane.sessionFile = join(DATA, `${name}.jsonl`);
	writeFileSync(lane.sessionFile, "");
	await agent.push({ type: "turn_start" }, { type: "assistant", text: "ready", stop: "stop" }, { type: "turn_end" });
	expect(lane.status).toBe("idle");
	writeFileSync(join(dir(name), "report.md"), "[wait] 예산 한도예요. /budget-ok 를 보내 주시면 이어서 할게요\n");
	return agent;
}

test("a hub-token yes to a lane that asked for /budget-ok sends no /budget-ok and is not labelled the owner's (RS-3 P2-2)", async () => {
	const agent = await laneAskingBudget("agt-budget");
	expect((await post({ lane: "agt-budget", text: "ㄱㄱ" }, true)).status).toBe(200);
	const texts = agent.sent.map(s => s.text);
	expect(texts).not.toContain("/budget-ok");
	expect(texts.some(t => t.startsWith("[owner via web]"))).toBe(false);
	expect(texts.some(t => t.startsWith("[agent via web] ㄱㄱ"))).toBe(true);
});

test("the owner's own yes to the same ask sends /budget-ok first, under his name", async () => {
	const agent = await laneAskingBudget("own-budget");
	expect((await post({ lane: "own-budget", text: "ㄱㄱ" }, false)).status).toBe(200);
	const texts = agent.sent.map(s => s.text);
	expect(texts.indexOf("/budget-ok")).toBeGreaterThanOrEqual(0);
	expect(texts.findIndex(t => t.startsWith("[owner via web] ㄱㄱ"))).toBeGreaterThan(texts.indexOf("/budget-ok"));
});
