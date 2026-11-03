// A lane's report reaches the web chat (the inbox lane_report event) in the owner's language, with one rewrite shared by
// Discord, and its "For <bot>:" line kept as written (2026-11-03: a Korean owner read English reports in the web chat
// while only Discord got the rewrite). The model call is a fake process; the event is awaited, not timed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cfg, NAME, paths } from "./config.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { hooks, type Lane } from "./lanestate.ts";
import { installLaneHandlers } from "./lanewire.ts";
import { modelDeps } from "./outlang.ts";

const KO = "시제품 빌드가 이제 통과해요. 테스트 12개가 모두 초록이에요.";
let calls: string[] = [];
const saved = { spawn: modelDeps.spawn, identity: cfg.identity, runtime: Reflect.get(cfg, "runtime"), outlang: Reflect.get(cfg, "output_language") };
const reports: HubEvent[] = [];
const waiters: ((e: HubEvent) => void)[] = [];
const nextReport = (lane: string) => new Promise<HubEvent>(resolve => waiters.push(e => e.lane === lane && resolve(e)));

beforeAll(() => {
	cfg.identity = { ...cfg.identity, language: "ko" };
	Reflect.set(cfg, "runtime", "omp");
	modelDeps.spawn = ((argv: string[]) => {
		calls.push(argv[argv.length - 1]);
		const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: KO }], usage: { input: 10, output: 5 } } });
		return { stdout: new Response(`${line}\n`).body, exited: Promise.resolve(0) };
	}) as unknown as typeof modelDeps.spawn;
	onEmit(e => {
		if (e.kind !== "lane_report") return;
		reports.push(e);
		for (const w of waiters.splice(0)) w(e);
	});
	installLaneHandlers();
});
afterAll(() => {
	modelDeps.spawn = saved.spawn;
	cfg.identity = saved.identity;
	Reflect.set(cfg, "runtime", saved.runtime);
	Reflect.set(cfg, "output_language", saved.outlang);
});

// Untagged, as an answer in an owner-only exchange: the relay keeps it on disk instead of starting an orchestrator.
const report = (name: string, text: string) => {
	mkdirSync(join(paths.lanes, name), { recursive: true });
	const got = nextReport(name);
	hooks.report({ name, orchAsked: false } as Lane, text, false);
	return got;
};

test("an English lane report is recorded once in the owner's language, its For line as written", async () => {
	Reflect.set(cfg, "output_language", "rewrite");
	calls = [];
	const forLine = `For ${NAME}: nothing to do`;
	const e = await report("lw-en", `The prototype build passes now. All 12 tests are green.\n\n${forLine}`);
	expect(e.text).toBe(`${KO}\n\n${forLine}`);
	// The model saw the owner-visible part only, once (Discord reuses the same text).
	expect(calls).toEqual(["The prototype build passes now. All 12 tests are green."]);
});

test('output_language "off" records the raw report and makes no model call', async () => {
	Reflect.set(cfg, "output_language", "off");
	calls = [];
	const raw = "The prototype build passes now. All 12 tests are green.";
	expect((await report("lw-off", raw)).text).toBe(raw);
	expect(calls).toEqual([]);
});
