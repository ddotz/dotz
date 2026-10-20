import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotz, { shellText } from "../../extension/index.ts";
import { jsonZod, params } from "../../extension/schema.ts";
import { eventsFromFrame } from "./omp.ts";
import { hostsOf, listHosts } from "./omo-hosts.ts";
import { omoArgs, omoSelector, translateFrame, WORKER_CATEGORIES, WORKER_RULE, writeWorkerProfile } from "./omo.ts";

test("a lane's worker model becomes a dotz profile of omo.json: every category on it, then its fallbacks; other keys stay", () => {
	const file = join(mkdtempSync(join(tmpdir(), "omo-home-")), "omo.json");
	writeFileSync(file, JSON.stringify({ categories: { quick: { model: "x/y" } }, profiles: { mine: { categories: {} } } }));
	const name = writeWorkerProfile({ workerModel: "anthropic/claude-sonnet-5-5:high", workerFallback: ["anthropic/claude-opus-5-5:medium"] }, file);
	expect(name).toBe("dotz-workers-anthropic-claude-sonnet-5-5-high");
	const doc = JSON.parse(readFileSync(file, "utf8"));
	expect(doc.categories).toEqual({ quick: { model: "x/y" } });
	expect(doc.profiles.mine).toEqual({ categories: {} });
	expect(Object.keys(doc.profiles[name!].categories)).toEqual(WORKER_CATEGORIES);
	expect(doc.profiles[name!].categories.quick.models).toEqual([
		{ model: "anthropic-subscription/claude-sonnet-5-5", reasoning: "high" },
		{ model: "anthropic-subscription/claude-opus-5-5", reasoning: "medium" },
	]);
	writeFileSync(`${file}c`, "// commented\n{}");
	expect(doc.profiles[name!].task).toEqual({ max_depth: 2 });
	for (const c of WORKER_CATEGORIES) expect(doc.profiles[name!].categories[c].prompt_append).toBe(WORKER_RULE);
	expect(WORKER_RULE).toContain("[fail]");
	expect(writeWorkerProfile({ workerModel: "anthropic/claude-sonnet-5-5:high" }, file)).toBeUndefined();
});

test("omp's anthropic provider maps to OmO's subscription provider; others and the thinking level pass through", () => {
	expect(omoSelector("anthropic/claude-opus-5-5:medium")).toBe("anthropic-subscription/claude-opus-5-5:medium");
	expect(omoSelector("openai-codex/gpt-5.5:high")).toBe("openai-codex/gpt-5.5:high");
});

test("spawn arguments: rpc mode, mapped model, dotz extension, no OmO fallback chain, --session to resume", () => {
	const args = omoArgs({ role: "orchestrator", cwd: "/tmp", model: "anthropic/claude-opus-5-5:medium", env: {}, resume: "/s/a.jsonl" });
	expect(args.slice(1, 5)).toEqual(["--mode", "rpc", "--model", "anthropic-subscription/claude-opus-5-5:medium"]);
	expect(args).toContain("--no-model-fallback");
	expect(args).toContain("--omo-senpi-memory-disabled");
	expect(args).toContain("--no-ask-user");
	expect(args[args.indexOf("--extension") + 1]).toEndWith("extension/index.ts");
	expect(args.slice(-2)).toEqual(["--session", "/s/a.jsonl"]);
});

test("OmO compaction frames become the hub's compaction events; a requested one is reported once (by the compact response)", () => {
	const kinds = (f: Parameters<typeof translateFrame>[0]) => eventsFromFrame(translateFrame(f), new Map()).filter(e => e.type === "compaction");
	expect(kinds({ type: "compaction_end", reason: "threshold", result: {} } as never)).toEqual([{ type: "compaction", state: "done" }]);
	expect(kinds({ type: "compaction_end", reason: "threshold", errorMessage: "Compaction failed: x" } as never)).toEqual([{ type: "compaction", state: "error", error: "Compaction failed: x", requested: false }]);
	expect(kinds({ type: "compaction_end", reason: "manual", result: {} } as never)).toEqual([]);
	expect(kinds({ type: "response", command: "compact", success: true, data: {} })).toEqual([{ type: "compaction", state: "done", tokensBefore: undefined }]);
});

test("rpc hosts are matched to the dotz-started omo process by pid and start time, never a reused pid", () => {
	const root = mkdtempSync(join(tmpdir(), "omo-hosts-"));
	const host = (shard: string, pid: number, start: string) => {
		mkdirSync(join(root, shard, "generations", "g"), { recursive: true });
		writeFileSync(join(root, shard, "endpoint.json"), JSON.stringify({ socket: `/s/${shard}.sock` }));
		writeFileSync(join(root, shard, "generations", "g", "owner.json"), JSON.stringify({ owner: { pid, startTime: start } }));
	};
	const at = Date.parse("2026-10-19T14:00:39Z");
	host("a", 4242, "Mon Oct 19 14:00:39 2026 UTC");
	host("b", 4242, "Mon Oct 19 18:00:00 2026 UTC");
	host("c", 777, "Mon Oct 19 14:00:39 2026 UTC");
	expect(hostsOf({ pid: 4242, at }, listHosts(root)).map(h => h.socket)).toEqual(["/s/a.sock"]);
});

test("deny lines see OmO's eval cells as shell text, and an eval's summary becomes the call's intent", () => {
	expect(shellText({ toolName: "eval", input: { code: "await Bun.$`agent-discord send x`" } })).toContain("agent-discord");
	expect(shellText({ toolName: "bash", input: { command: "ls" } })).toBe("ls");
	expect(shellText({ toolName: "read", input: { path: "x" } })).toBeUndefined();
	expect(translateFrame({ type: "tool_execution_start", toolName: "eval", toolCallId: "t", args: { summary: "run tests" } } as never).intent).toBe("run tests");
});

test("tool parameters without zod are plain JSON Schema with required keys", () => {
	const z = jsonZod;
	const schema = params(z.object({ action: z.enum(["add", "list"]), est: z.number().min(0).max(100).optional(), tags: z.array(z.string()).optional() }));
	expect(schema).toEqual({
		type: "object",
		properties: { action: { type: "string", enum: ["add", "list"] }, est: { type: "number", minimum: 0, maximum: 100 }, tags: { type: "array", items: { type: "string" } } },
		required: ["action"],
		additionalProperties: false,
	});
});

test("on a host without zod (OmO) every orchestrator and lane tool registers: a missing schema builder drops them all", async () => {
	const load = async (role: "DOTZ_ORCHESTRATOR" | "DOTZ_LANE") => {
		const names: string[] = [];
		const host = new Proxy({ registerTool: (t: { name: string; parameters: unknown }) => names.push(t.name) } as Record<string, unknown>, {
			get: (o, k) => (k in o ? o[k as string] : k === "then" || k === "zod" ? undefined : () => undefined),
		});
		const saved = { ...process.env };
		process.env[role] = role === "DOTZ_LANE" ? "probe" : "1";
		try {
			await dotz(host);
		} finally {
			process.env = saved;
		}
		return names;
	};
	expect(await load("DOTZ_ORCHESTRATOR")).toEqual(expect.arrayContaining(["dotz_send", "dotz_lane", "dotz_schedule", "dotz_watch", "dotz_verify"]));
	expect(await load("DOTZ_LANE")).toContain("dotz_verify");
});

test("light profile: tools dotz never uses are left out (goal loop, html viewer; the orchestrator also lsp, workpool, pty resize); every tool dotz relies on stays", () => {
	const excluded = (role: "orchestrator" | "lane") => {
		const args = omoArgs({ role, cwd: "/tmp", model: "anthropic/claude-opus-5-5:medium", env: {} });
		return args.includes("--exclude-tools") ? args[args.indexOf("--exclude-tools") + 1]!.split(",") : [];
	};
	expect(excluded("lane")).toEqual(["create_goal", "get_goal", "update_goal", "show_html_page"]);
	expect(excluded("orchestrator")).toEqual(["create_goal", "get_goal", "update_goal", "show_html_page", "lsp_diagnostics", "lsp_find_references", "lsp_goto_definition", "lsp_prepare_rename", "lsp_rename", "lsp_symbols", "workpool", "bash_resize"]);
	for (const role of ["orchestrator", "lane"] as const)
		for (const kept of ["task", "task_output", "task_send", "task_cancel", "memory", "eval", "edit", "write", "Read", "todo", "web_search", "webfetch", "tool_search", "bash_output", "bash_input", "kill_bash"]) expect(excluded(role)).not.toContain(kept);
	expect(excluded("lane")).not.toContain("lsp_diagnostics");
	expect(excluded("lane")).not.toContain("workpool");
});

