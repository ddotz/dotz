import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, paths } from "./config.ts";
import { changeTarget, targetView } from "./control.ts";
import { convs } from "./convsessions.ts";
import * as l from "./lanes.ts";
import { ownerGate, readModelPicks } from "./model-guard.ts";
import "./outbound.ts";
import { adapters } from "./runtime/index.ts";
import { omoArgs, omoSelector } from "./runtime/omo.ts";
import { omp, ompArgv } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const spy = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);

class FakeAgent implements AgentProcess {
	pid = 7800;
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	send = () => {};
	setModel = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}
const spawns: SpawnOpts[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(opts) {
		spawns.push(opts);
		return new FakeAgent();
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "",
	detect: async () => ({ installed: true }),
};

const OPUS = "anthropic/claude-opus-5-5", SONNET = "anthropic/claude-sonnet-5-5";
const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes };
beforeAll(() => {
	adapters.fakepick = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fakepick" };
	cfg.lanes = { ...cfg.lanes, runtime: "fakepick" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fakepick;
	Object.assign(cfg, savedCfg);
	spy.mockRestore();
});

const argModel = (argv: string[]) => argv[argv.indexOf("--model") + 1];

test("a project's picked level stays through a model pick and is the --model of its omp and OmO process", async () => {
	const CONV = "ch:7801";
	await changeTarget(CONV, { model: OPUS, thinking: "max" });
	await changeTarget(CONV, { model: SONNET });
	expect(await targetView(CONV)).toMatchObject({ model: SONNET, thinking: "max", own: true });
	const conv = convs.get(CONV)!.o;
	conv.start();
	try {
		const opts = spawns.at(-1)!;
		expect(opts.model).toBe(`${SONNET}:max`);
		expect(argModel(ompArgv(opts))).toBe(`${SONNET}:max`);
		expect(argModel(omoArgs(opts))).toBe(omoSelector(`${SONNET}:max`));
	} finally {
		conv.stop();
		await advance(1000);
	}
});

test("a session's picked level and worker pick reach its process, its overlay's worker ceiling and the owner's picks", async () => {
	const cwd = join(DATA_DIR, "pick-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch("pick-lane", cwd, "Polish the theme.\nDone when: owner approves", `${SONNET}:medium`);
	l.stopLane("pick-lane");
	await advance(300);
	await flush();
	await changeTarget("lane:pick-lane", { thinking: "xhigh" });
	await changeTarget("lane:pick-lane", { model: OPUS });
	await changeTarget("lane:pick-lane", { workerModel: `${OPUS}:max` });
	expect(readModelPicks()["lane:pick-lane:workers"]).toMatchObject({ model: OPUS, thinking: "max", by: "owner" });
	const sessions = join(DATA_DIR, "home", ".omp", "agent", "sessions", "--pick--");
	mkdirSync(sessions, { recursive: true });
	lane.sessionFile = join(sessions, "pick.jsonl");
	writeFileSync(lane.sessionFile, "");
	l.sendToLane("pick-lane", "[owner via web] go on");
	await flush();
	try {
		const opts = spawns.at(-1)!;
		expect(opts.model).toBe(`${OPUS}:xhigh`);
		expect(opts.lane?.workerModel).toBe(`${OPUS}:max`);
		const argv = ompArgv(opts);
		expect(argModel(argv)).toBe(`${OPUS}:xhigh`);
		const overlay = readFileSync(argv.find(a => a.startsWith("--config="))!.slice("--config=".length), "utf8");
		expect(overlay).toContain("maxEffort: max");
		expect(argModel(omoArgs(opts))).toBe(omoSelector(`${OPUS}:xhigh`));
	} finally {
		l.stopLane("pick-lane");
		await advance(300);
	}
});

test("the owner's Korean words for a level name it for a session's model change", () => {
	const now = Date.now();
	const say = (mid: string, text: string) => appendFileSync(paths.inbox, `${JSON.stringify({ ts: new Date(now).toISOString(), kind: "message", source: "web", channel: "ch:7802", author: "owner", text, mid })}\n`);
	say("kmax1", "이 대화 추론 최고로 올려줘");
	say("kxh1", "추론 강도 매우 높음으로");
	expect(ownerGate(true, { conv: "ch:7802", thinking: "max" }, "kmax1", now)).toEqual({ by: "owner-message:kmax1" });
	expect(ownerGate(true, { conv: "ch:7802", thinking: "xhigh" }, "kxh1", now)).toEqual({ by: "owner-message:kxh1" });
	expect(ownerGate(true, { conv: "ch:7802", thinking: "high" }, "kxh1", now)).toHaveProperty("denied");
});
