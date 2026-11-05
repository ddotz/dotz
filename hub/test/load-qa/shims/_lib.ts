// Shared helpers of the load-qa fake CLIs (hub/test/load-qa/shims). Every shim calls begin() first: one line in
// $LOAD_QA_RUN/shim-calls.jsonl {ts, tool, argv} and a start/end pair in $LOAD_QA_RUN/shim-concurrency.jsonl
// {ts, tool, pid, event}. Only generated fake values are ever printed.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUN = process.env.LOAD_QA_RUN;
const put = (file: string, rec: object): void => {
	if (RUN) appendFileSync(join(RUN, file), `${JSON.stringify(rec)}\n`);
};

/** Records the invocation; `extra` is merged into the shim-calls line (e.g. `would_send`). The end event is written on exit. */
export function begin(tool: string, argv: string[], extra: Record<string, unknown> = {}): void {
	put("shim-calls.jsonl", { ts: new Date().toISOString(), tool, argv, ...extra });
	put("shim-concurrency.jsonl", { ts: Date.now(), tool, pid: process.pid, event: "start" });
	process.on("exit", () => put("shim-concurrency.jsonl", { ts: Date.now(), tool, pid: process.pid, event: "end" }));
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(143));
}

/** One line per fake model call: {ts, kind, chars_in, est_tokens, item}. */
export const recordModel = (rec: { kind: string; chars_in: number; est_tokens: number; item: string }): void => put("model-calls.jsonl", { ts: new Date().toISOString(), ...rec });

/** Rough token estimate: ~4 ASCII chars or ~1.5 non-ASCII chars (Hangul) per token. */
export function estTokens(text: string): number {
	let ascii = 0;
	for (const ch of text) if (ch.charCodeAt(0) < 128) ascii++;
	return Math.ceil(ascii / 4 + ([...text].length - ascii) / 1.5);
}

export const modelLatencyMs = (): number => Math.max(0, Number(process.env.LOAD_QA_MODEL_LATENCY_MS ?? 0) || 0);

/** Peak number of shim processes alive at once, per tool and in total, from shim-concurrency.jsonl (lines are in event order). */
export function shimConcurrency(runDir: string): { total: { max: number; starts: number }; tools: Record<string, { max: number; starts: number }> } {
	const file = join(runDir, "shim-concurrency.jsonl");
	const out = { total: { max: 0, starts: 0 }, tools: {} as Record<string, { max: number; starts: number }> };
	if (!existsSync(file)) return out;
	const live = new Map<string, number>();
	let all = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const e = JSON.parse(line) as { tool: string; event: "start" | "end" };
		const t = (out.tools[e.tool] ??= { max: 0, starts: 0 });
		const d = e.event === "start" ? 1 : -1;
		live.set(e.tool, (live.get(e.tool) ?? 0) + d);
		all += d;
		if (d > 0) (t.starts++, out.total.starts++);
		t.max = Math.max(t.max, live.get(e.tool)!);
		out.total.max = Math.max(out.total.max, all);
	}
	return out;
}
