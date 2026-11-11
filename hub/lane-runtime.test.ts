// A lane's session is only resumed by the runtime that wrote it (2026-10-20 17:16: gateway-ui's omp session handed to OmO
// died at once and the owner's question was lost). Any other runtime refuses with a handover offer; "인계"/"handover"
// starts the same lane in a fresh session with the refused message.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7300;
	sent: string[] = [];
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {})();
	send = (text: string) => void this.sent.push(text);
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}
const spawns: { opts: SpawnOpts; agent: FakeAgent }[] = [];
const fake: RuntimeAdapter = {
	id: "omo",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: true, promptCacheKeepalive: false },
	start(opts) {
		const agent = new FakeAgent();
		spawns.push({ opts, agent });
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => "owner: is this light theme the best?",
	detect: async () => ({ installed: true }),
};
const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fakeomo = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fakeomo" };
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
});
afterAll(() => {
	delete adapters.fakeomo;
	Object.assign(cfg, savedCfg);
});

async function stopped(name: string): Promise<Lanes.Lane> {
	const cwd = join(DATA, "rt-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch(name, cwd, "Polish the theme.\nDone when: owner approves");
	l.stopLane(name);
	await advance(300);
	await flush();
	expect(lane.proc).toBeUndefined();
	return lane;
}

test("the runtime that wrote a session is recorded, and read from the session's place for older lanes", async () => {
	const lane = await stopped("rt-rec");
	expect(lane.runtime).toBe("omo");
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "rt-rec", "lane.json"), "utf8")).runtime).toBe("omo");
	expect(l.sessionRuntime({ sessionFile: "/Users/x/.omp/agent/sessions/--w--/a.jsonl" })).toBe("omp");
	expect(l.sessionRuntime({ sessionFile: "/Users/x/.omo/agent/sessions/--w--/a.jsonl" })).toBe("omo");
	expect(l.sessionRuntime({ sessionFile: "3f1c-uuid" })).toBe("claude");
	expect(l.sessionRuntime({ sessionFile: "/tmp/elsewhere/a.jsonl" })).toBeUndefined();
	expect(l.sessionRuntime({ runtime: "omp", sessionFile: "/Users/x/.omo/agent/sessions/a.jsonl" })).toBe("omp");
});

test("a session of the same runtime resumes as before", async () => {
	const lane = await stopped("rt-same");
	const session = join(DATA, "omo-agent", "sessions", "rt-same.jsonl");
	mkdirSync(join(DATA, "omo-agent", "sessions"), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	const before = spawns.length;
	l.sendToLane("rt-same", "[owner via Discord] one more tweak");
	expect(spawns.length).toBe(before + 1);
	expect(spawns.at(-1)!.opts.resume).toBe(session);
	l.stopLane("rt-same");
	await advance(300);
});

test("an omp session is never resumed by OmO: refused with a handover offer, and 'handover' starts a fresh session with the message", async () => {
	const lane = await stopped("rt-omp");
	const home = join(DATA, "home", ".omp", "agent", "sessions", "--w--");
	mkdirSync(home, { recursive: true });
	const old = join(home, "2026-10-20T08-00-00-000Z_old.jsonl");
	writeFileSync(old, "");
	// A lane saved by the omp-era gateway: no runtime field, an omp session.
	lane.runtime = undefined;
	lane.sessionFile = old;
	const before = spawns.length;

	let refused: unknown;
	try {
		l.sendToLane("rt-omp", "[owner via Discord] is this light theme the best?");
	} catch (e) {
		refused = e;
	}
	expect(refused).toBeInstanceOf(l.LaneRuntimeMismatch);
	expect((refused as Error).message).toContain("omp");
	expect((refused as Error).message).toContain("handover");
	expect(() => l.resumeByName("rt-omp")).toThrow(l.LaneRuntimeMismatch);
	expect(spawns.length).toBe(before);
	expect(lane.proc).toBeUndefined();

	l.sendToLane("rt-omp", "[owner via Discord] 인계");
	expect(spawns.length).toBe(before + 1);
	const { opts, agent } = spawns.at(-1)!;
	expect(opts.resume).toBeUndefined();
	expect(lane.runtime).toBe("omo");
	expect(lane.sessionFile).toBeUndefined();
	const prompt = agent.sent.at(-1)!;
	expect(prompt).toContain("was made by omp");
	expect(prompt).toContain(old);
	expect(prompt).toContain("owner: is this light theme the best?");
	expect(prompt).toContain("[owner via Discord] is this light theme the best?");
	expect(prompt).not.toContain("인계");
	l.stopLane("rt-omp");
	await advance(300);
});

test("a restart never moves a running lane's session to a runtime switched in config since it started", async () => {
	const cwd = join(DATA, "rt-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch("rt-run", cwd, "Run.\nDone when: done");
	const session = join(DATA, "omo-agent", "sessions", "rt-run.jsonl");
	mkdirSync(join(DATA, "omo-agent", "sessions"), { recursive: true });
	writeFileSync(session, "");
	lane.sessionFile = session;
	lane.runtime = "omp";
	const before = spawns.length;
	await expect(l.restartLane("rt-run")).rejects.toBeInstanceOf(l.LaneRuntimeMismatch);
	expect(spawns.length).toBe(before);
	l.stopLane("rt-run");
	await advance(300);
});

test("titleProblem rejects the key, a folder or repo name and codename-shaped titles, and accepts plain words", () => {
	const ctx = { key: "discord-fix", cwd: "/Users/h/Code/dotz/", repo: "/Users/h/Code/gateway-ui" };
	for (const bad of ["discord-fix", "Discord-Fix", "dotz", "gateway-ui", "dotz2", "gw_api.v2", "", "   ", undefined]) expect(l.titleProblem(bad, ctx)).toBeString();
	expect(l.titleProblem("dotz", ctx)).toContain("2-4 plain words");
	for (const good of ["디스코드 설정", "메일 자동답장", "discord setup", "게이트웨이-화면"]) expect(l.titleProblem(good, ctx)).toBeUndefined();
	expect(l.titleProblem("x2", {})).toBeString();
	expect(l.titleProblem("메일", {})).toBeUndefined();
});

test("a launched lane stores its title in lane.json and shows it in the summary; an older lane.json without one still loads", async () => {
	const cwd = join(DATA, "rt-work");
	mkdirSync(cwd, { recursive: true });
	const lane = l.launch("rt-title", cwd, "Polish the theme.\nDone when: owner approves", undefined, undefined, undefined, "디스코드 설정");
	l.stopLane("rt-title");
	await advance(300);
	await flush();
	expect(lane.title).toBe("디스코드 설정");
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "rt-title", "lane.json"), "utf8")).title).toBe("디스코드 설정");
	expect(l.laneSummary().find(s => s.name === "rt-title")?.title).toBe("디스코드 설정");
	mkdirSync(join(DATA, "lanes", "rt-old"), { recursive: true });
	writeFileSync(join(DATA, "lanes", "rt-old", "lane.json"), JSON.stringify({ name: "rt-old", cwd, model: "m", status: "exited", startedAt: "2026-10-01T00:00:00.000Z", reports: 0 }));
	l.restoreLanes();
	const old = l.laneSummary().find(s => s.name === "rt-old");
	expect(old).toBeDefined();
	expect(old).not.toHaveProperty("title");
});
