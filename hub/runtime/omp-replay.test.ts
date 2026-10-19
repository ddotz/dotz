// Golden replay: a recorded stream of omp RPC frames (fixtures/omp-rpc.jsonl, every frame kind the hub reads plus malformed
// and unknown ones) goes through the omp adapter and the hub-side consumers, frame by frame. After each frame the terminal
// rows, subagent list, context numbers, requests sent to the process and the per-frame meaning must equal
// fixtures/omp-rpc.golden.json, which was captured from the pre-adapter code (activityFromFrame + the orchestrator/lane
// frame handlers) on the same fixture.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { emitEventActivity, runningSubagents, subagentLists } from "../activity.ts";
import { newCtx, noteEvent } from "../context.ts";
import { activityItems } from "../events.ts";
import { clock, flush } from "./test-clock.ts";
import { omp } from "./omp.ts";
import type { AgentEvent } from "./types.ts";

// Bun's namespace is read-only in the types; the test swaps its spawn for a scripted process.
const patchable = Bun as unknown as { spawn: unknown };

const BASE = 1_800_000_000_000;
const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();

// What the pre-adapter handlers derived from one frame, restated from the events.
function derive(events: AgentEvent[]): Record<string, unknown> {
	const d: Record<string, unknown> = {};
	for (const ev of events) {
		if (ev.type === "turn_start") d.turn = "start";
		else if (ev.type === "turn_end") d.turn = "end";
		else if (ev.type === "user") d.user = ev.text;
		else if (ev.type === "session") d.session = ev.ref;
		else if (ev.type === "assistant") d.assistant = { text: ev.text, answer: Boolean(ev.text && (ev.stop === "stop" || ev.stop === "length")), stop: ev.stop, error: ev.stop === "error" ? { text: ev.error.text, kind: ev.error.kind ?? null, compaction: ev.error.compaction } : null };
	}
	return d;
}

test("omp frames replayed through the adapter match the pre-adapter golden", async () => {
	const lines = (await fixture("omp-rpc.jsonl")).split("\n").filter(Boolean);
	const golden = JSON.parse(await fixture("omp-rpc.golden.json"));

	let out!: ReadableStreamDefaultController<Uint8Array>;
	const realSpawn = Bun.spawn;
	patchable.spawn = () => ({ pid: 4242, stdout: new ReadableStream<Uint8Array>({ start: c => void (out = c) }), stdin: { write: () => 0, flush: () => 0 }, exited: Promise.withResolvers<number>().promise, kill() {} });
	const proc = omp.start({ role: "orchestrator", cwd: process.env.DOTZ_DIR!, model: "test:low", env: {} });
	patchable.spawn = realSpawn;

	const arrived: AgentEvent[] = [];
	void (async () => {
		for await (const ev of proc.events) arrived.push(ev);
	})();

	const ctx = newCtx();
	const result: unknown[] = [];
	for (const [i, line] of lines.entries()) {
		clock.now = BASE + (i + 1) * 1000;
		const rowsBefore = activityItems("orchestrator", 300).length;
		out.enqueue(new TextEncoder().encode(`${line}\n`));
		await flush();
		const events = arrived.splice(0);
		if (!events.length) {
			result.push({ line: i, skipped: true });
			continue;
		}
		const sends: string[] = [];
		const port = { idle: () => true, compact: () => void sends.push("compact"), refreshUsage: () => void sends.push("get_session_stats") };
		for (const ev of events) {
			emitEventActivity("orchestrator", ev);
			noteEvent(ctx, ev, port);
		}
		const failed = events.find(ev => ev.type === "compaction" && ev.state === "error");
		result.push({
			line: i,
			rows: activityItems("orchestrator", 300).slice(rowsBefore).map(({ ts: _ts, ...row }) => row),
			subagents: subagentLists().orchestrator ?? [],
			running: runningSubagents("orchestrator"),
			ctx: [ctx.tokens, ctx.window, ctx.compaction.state ?? null, ctx.compaction.tokensBefore ?? null, ctx.compaction.error ?? null],
			sends,
			compactionError: failed?.type === "compaction" && failed.state === "error" ? failed.error : null,
			derived: derive(events),
		});
	}
	expect(JSON.parse(JSON.stringify(result))).toEqual(golden);
});
