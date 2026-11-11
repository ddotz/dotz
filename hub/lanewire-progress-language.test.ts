// A lane's mid-turn progress line is replaced by the next one, so the owner reads the original at once and the rewrite takes its place
// (hub/lanewire.ts, hub/outlang.ts `early`). The model call is a fake process held open by the test; events are awaited, not timed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cfg } from "./config.ts";
import { type HubEvent, onEmit } from "./events.ts";
import { hooks, type Lane } from "./lanestate.ts";
import { installLaneHandlers } from "./lanewire.ts";
import { modelDeps } from "./outlang.ts";

const EN = "The prototype build passes now and all twelve tests are green.";
const KO = "시제품 빌드가 이제 통과해요. 테스트 12개가 모두 초록이에요.";
const saved = { spawn: modelDeps.spawn, identity: cfg.identity, runtime: Reflect.get(cfg, "runtime"), outlang: Reflect.get(cfg, "output_language") };
let calls = 0;
let release: () => void = () => {};
let spawned: () => void = () => {};
const outs: HubEvent[] = [];
const waiters: { n: number; resolve: () => void }[] = [];
const outsReach = (n: number) => (outs.length >= n ? Promise.resolve() : new Promise<void>(resolve => waiters.push({ n, resolve })));

beforeAll(() => {
	cfg.identity = { ...cfg.identity, language: "ko" };
	Reflect.set(cfg, "runtime", "omp");
	Reflect.set(cfg, "output_language", "rewrite");
	modelDeps.spawn = (() => {
		calls++;
		spawned();
		const gate = new Promise<void>(resolve => (release = resolve));
		const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: KO }], usage: { input: 10, output: 5 } } });
		const stdout = new ReadableStream<Uint8Array>({
			async start(c) {
				await gate;
				c.enqueue(new TextEncoder().encode(`${line}\n`));
				c.close();
			},
		});
		return { stdout, exited: gate.then(() => 0) };
	}) as unknown as typeof modelDeps.spawn;
	onEmit(e => {
		if (e.kind !== "out" || e.target !== "lane:lw-prog") return;
		outs.push(e);
		for (const w of waiters.filter(w => outs.length >= w.n)) w.resolve();
	});
	installLaneHandlers();
});
afterAll(() => {
	modelDeps.spawn = saved.spawn;
	cfg.identity = saved.identity;
	Reflect.set(cfg, "runtime", saved.runtime);
	Reflect.set(cfg, "output_language", saved.outlang);
});

test("an English progress line is posted as it is before the rewrite starts, then the rewrite takes its place", async () => {
	const started = new Promise<void>(resolve => (spawned = resolve));
	hooks.progress({ name: "lw-prog" } as Lane, EN);
	await started;
	// The model has been called and not answered: the owner already has the original, as the progress line.
	expect(calls).toBe(1);
	expect(outs.length).toBe(1);
	expect(outs[0]!.text).toContain(EN);
	expect(outs[0]!.update_key).toBe("progress");
	release();
	await outsReach(2);
	expect(outs.length).toBe(2);
	expect(outs[1]!.text).toContain(KO);
	expect(outs[1]!.update_key).toBe("progress");
});

test("a progress line already in the owner's language is posted once with no model call", async () => {
	const before = { outs: outs.length, calls };
	hooks.progress({ name: "lw-prog" } as Lane, "테스트 12개를 모두 돌려 봤어요. 초록이에요.");
	await outsReach(before.outs + 1);
	expect(outs.length).toBe(before.outs + 1);
	expect(calls).toBe(before.calls);
});
