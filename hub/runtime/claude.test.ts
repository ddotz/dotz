// Claude Code adapter: a recorded stream-json transcript (fixtures/claude-stream.jsonl; real runs of claude 2.1.296 on a
// cheap model, scrubbed of paths, hook output and the tool/command lists) goes through the adapter frame by frame and must
// give the events in fixtures/claude-stream.golden.json (reviewed by hand; CAPTURE_GOLDEN=1 rewrites it, as in
// omp-replay.test.ts). Segments: a tool turn, a context report, an interrupted turn, a requested compaction, a turn after
// it | an API error | a model fallback | a background task worker. Around it: spawn arguments, the per-run settings
// with the deny hook, the hook itself, and reading a saved session.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude, claudeModel, recentExchanges } from "./claude.ts";
import { denyReason } from "./claude-deny-hook.ts";
import { detectBinary } from "./detect.ts";
import { flush } from "./test-clock.ts";
import type { AgentEvent, SpawnOpts } from "./types.ts";

// Bun's namespace is read-only in the types; the test swaps its spawn for a scripted process.
const patchable = Bun as unknown as { spawn: unknown };
const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();

type Scripted = { cmd: string[]; env: Record<string, string>; stdin: string[]; out: ReadableStreamDefaultController<Uint8Array> };

function spawnScripted(o: SpawnOpts): { proc: ReturnType<typeof claude.start>; script: Scripted } {
	const script = { cmd: [], env: {}, stdin: [] } as unknown as Scripted;
	const realSpawn = Bun.spawn;
	patchable.spawn = (cmd: string[], opts: { env: Record<string, string> }) => {
		script.cmd = cmd;
		script.env = opts.env;
		return {
			pid: 4243,
			stdout: new ReadableStream<Uint8Array>({ start: c => void (script.out = c) }),
			stderr: new ReadableStream<Uint8Array>({ start() {} }),
			stdin: { write: (s: string) => script.stdin.push(s.trim()), flush: () => 0 },
			exited: Promise.withResolvers<number>().promise,
			kill() {},
		};
	};
	try {
		return { proc: claude.start(o), script };
	} finally {
		patchable.spawn = realSpawn;
	}
}

const summarize = (ev: AgentEvent): string | undefined => {
	switch (ev.type) {
		case "alive":
			return undefined;
		case "user":
			return `user: ${ev.text}`;
		case "assistant":
			return `assistant(${ev.stop}): ${ev.text}${ev.stop === "error" ? ` [kind=${ev.error.kind ?? "none"}]` : ""}`;
		case "activity":
			return `row ${ev.row.type}${ev.row.tool ? ` ${ev.row.tool}` : ""}: ${(ev.row.intent ?? ev.row.text).slice(0, 80)}${ev.row.is_error ? " (error)" : ""}`;
		case "usage":
			return `usage tokens=${ev.tokens ?? "-"} window=${ev.window ?? "-"}`;
		case "compaction":
			return ev.state === "done" ? `compaction done before=${ev.tokensBefore ?? "-"}` : `compaction error requested=${ev.requested}: ${ev.error}`;
		case "subagent":
			return `subagent ${ev.update.id} ${ev.update.status}${ev.update.agent ? ` (${ev.update.agent})` : ""}`;
		case "session":
			return `session ${ev.ref}`;
		case "fallback":
			return `fallback ${ev.from} -> ${ev.to} (${ev.reason})`;
		default:
			return ev.type;
	}
};

test("a recorded Claude Code stream becomes the expected events", async () => {
	const lines = (await fixture("claude-stream.jsonl")).split("\n").filter(Boolean);
	const { proc, script } = spawnScripted({ role: "orchestrator", cwd: process.env.DOTZ_DIR!, model: "anthropic/claude-haiku-5-5:low", env: {} });
	const arrived: AgentEvent[] = [];
	void (async () => {
		for await (const ev of proc.events) arrived.push(ev);
	})();

	const result: Record<string, string[]> = {};
	let segment = "";
	for (const line of lines) {
		const frame = JSON.parse(line);
		if (frame.type === "dotz_fixture_segment") {
			segment = frame.name;
			result[segment] = [];
			if (segment === "session") proc.refreshUsage(); // request usage1 is answered inside this segment
			continue;
		}
		// What the hub did at this point of the recording.
		if (frame.type === "user" && frame.message?.content?.[0]?.text === "[Request interrupted by user]") proc.abort();
		if (frame.type === "system" && frame.status === "compacting") proc.compact();
		script.out.enqueue(new TextEncoder().encode(`${line}\n`));
		await flush();
		for (const ev of arrived.splice(0)) {
			const s = summarize(ev);
			if (s) result[segment].push(s);
		}
	}
	if (process.env.CAPTURE_GOLDEN === "1") return void (await Bun.write(join(import.meta.dir, "fixtures", "claude-stream.golden.json"), `${JSON.stringify(result, null, 1)}\n`));
	expect(result).toEqual(JSON.parse(await fixture("claude-stream.golden.json")));

	// Properties the golden is meant to show, stated on their own.
	const session = result.session;
	expect(session.filter(s => s === "turn_start")).toHaveLength(3); // the requested compaction is not a turn
	expect(session.filter(s => s === "turn_end")).toHaveLength(3);
	expect(session).toContain("assistant(stop): hello\n\ndone");
	expect(session.some(s => s.startsWith("assistant(aborted)"))).toBe(true);
	expect(session).toContain("compaction done before=32984");
	expect(session).toContain("usage tokens=32665 window=1000000"); // get_context_usage answered
	expect(result.error.some(s => s.startsWith("assistant(error)"))).toBe(true);
	expect(result.fallback).toContain("fallback bogus-model-x -> claude-haiku-5-5 (model_not_found)");
	expect(result.agent).toContain("subagent af70bf0abd349996f running (general-purpose)");
	expect(result.agent.at(-1)).toBe("turn_start"); // a finished background worker wakes the agent by itself

	// What the adapter wrote to the process: the usage request, the interrupt, the compaction.
	expect(script.stdin.map(s => JSON.parse(s))).toEqual([
		{ type: "control_request", request_id: "usage1", request: { subtype: "get_context_usage" } },
		{ type: "control_request", request_id: "interrupt2", request: { subtype: "interrupt" } },
		{ type: "user", message: { role: "user", content: "/compact" } },
	]);
});

test("spawn arguments: model, effort, fallback, settings with the deny hook, resume", () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-claude-args-"));
	const sessionId = "6ef33b26-e94f-4b04-9d66-f280e6ab5f90";
	const { script } = spawnScripted({
		role: "lane",
		cwd: dir,
		model: "anthropic/claude-opus-4-5:xhigh",
		resume: sessionId,
		fallback: ["anthropic/claude-sonnet-4-5:high", "openai/gpt-5", "haiku"],
		env: { DOTZ_LANE: "x", DOTZ_DIR: "/data dir's" },
		lane: { name: "x", dir, workerModel: "anthropic/claude-haiku-5-5", compactAt: 300_000, keepRecent: 30_000 },
	});
	const arg = (flag: string) => script.cmd[script.cmd.indexOf(flag) + 1];
	expect(script.cmd.slice(1, 4)).toEqual(["-p", "--input-format", "stream-json"]);
	expect(arg("--model")).toBe("claude-opus-4-5");
	expect(arg("--effort")).toBe("xhigh");
	expect(arg("--fallback-model")).toBe("claude-sonnet-4-5,haiku"); // the openai model cannot run here
	expect(arg("--resume")).toBe(sessionId);
	expect(arg("--autocompact")).toBe("300000");
	expect(arg("--permission-mode")).toBe("bypassPermissions");
	expect(script.env.DOTZ_LANE).toBe("x");

	const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"));
	const hook = settings.hooks.PreToolUse[0];
	expect(hook.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
	expect(hook.hooks[0].command).toContain("DOTZ_DIR='/data dir'\\''s'"); // shell-quoted
	expect(hook.hooks[0].command).toContain("claude-deny-hook.ts");

	// An omp session file or no effort suffix: fresh session, the default thinking level.
	const other = spawnScripted({ role: "orchestrator", cwd: dir, model: "anthropic/claude-haiku-5-5:auto", resume: "/x/session.jsonl", env: {} }).script;
	expect(other.cmd).not.toContain("--resume");
	expect(other.cmd).not.toContain("--effort");
	expect(other.cmd).not.toContain("--autocompact");
	expect(() => claudeModel("openai/gpt-5")).toThrow("Anthropic models only");
	expect(claudeModel("opus")).toBe("opus");
});

test("the deny hook blocks Bash commands with the RULES.md deny lines and the feature deny lists", async () => {
	const data = mkdtempSync(join(tmpdir(), "dotz-claude-deny-"));
	writeFileSync(join(data, "RULES.md"), "## Rules\n- be nice\n\n## Blocked commands\n- deny: git\\s+push | pushing is an external action\n- deny: ( | broken regex is skipped\n\n## Later\n- deny: rm | not in the section\n");
	mkdirSync(join(data, "features", "no-drop"), { recursive: true });
	writeFileSync(join(data, "features", "no-drop", "feature.md"), "---\nname: No drop\nwhat: refuses DROP TABLE\ntrigger: 도구 실행 직전\nstage: tools\ndeny:\n  - DROP\\s+TABLE | tables are not dropped\n---\nbody\n");
	expect(denyReason("git push origin main", data)).toContain("pushing is an external action");
	expect(denyReason("echo ( ok", data)).toBeUndefined();
	expect(denyReason("rm -rf x", data)).toBeUndefined();
	expect(denyReason("psql -c 'drop table users'", data)).toContain("tables are not dropped");

	// The hook as Claude Code runs it: JSON on stdin, exit code 2 and the reason on stderr to block.
	const run = async (payload: unknown) => {
		const proc = Bun.spawn([process.execPath, join(import.meta.dir, "claude-deny-hook.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, DOTZ_DIR: data } });
		proc.stdin.write(JSON.stringify(payload));
		proc.stdin.end();
		return { code: await proc.exited, err: await new Response(proc.stderr).text() };
	};
	const blocked = await run({ tool_name: "Bash", tool_input: { command: "git push" } });
	expect(blocked.code).toBe(2);
	expect(blocked.err).toContain("pushing is an external action");
	expect((await run({ tool_name: "Bash", tool_input: { command: "ls" } })).code).toBe(0);
	expect((await run({ tool_name: "Read", tool_input: { file_path: "git push" } })).code).toBe(0);
	expect((await run("not an object")).code).toBe(0);

	// No answer in time (here: stdin never closes) blocks instead of letting Claude Code run the command after its own hook
	// timeout. A real process and a real (short) deadline: the timeout is the hook process's own behaviour under test.
	const stuck = Bun.spawn([process.execPath, join(import.meta.dir, "claude-deny-hook.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, DOTZ_DIR: data, DOTZ_HOOK_DEADLINE_MS: "200" } });
	expect(await stuck.exited).toBe(2);
	expect((await new Response(stuck.stderr).text()).trim()).not.toBe("");
	stuck.stdin.end();
	// Unreadable input blocks too.
	const bad = Bun.spawn([process.execPath, join(import.meta.dir, "claude-deny-hook.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, DOTZ_DIR: data } });
	bad.stdin.write("{not json");
	bad.stdin.end();
	expect(await bad.exited).toBe(2);
});

test("recentExchanges reads a saved Claude Code session by id, keeping prompts and final answers only", () => {
	const config = mkdtempSync(join(tmpdir(), "dotz-claude-sessions-"));
	const id = "11111111-2222-4333-8444-555555555555";
	mkdirSync(join(config, "projects", "-work-x"), { recursive: true });
	const entry = (type: string, message: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type, message, ...extra });
	writeFileSync(
		join(config, "projects", "-work-x", `${id}.jsonl`),
		[
			JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
			entry("user", { role: "user", content: "first question" }),
			entry("assistant", { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] }),
			entry("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] }),
			entry("assistant", { role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "first answer" }] }),
			entry("user", { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" }),
			entry("user", { role: "user", content: "side question" }, { isSidechain: true }),
			entry("user", { role: "user", content: [{ type: "text", text: "second question" }] }),
			entry("assistant", { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "second answer" }] }),
		].join("\n"),
	);
	const before = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = config;
	try {
		expect(recentExchanges(id)).toBe("IN: first question\n\nYOU: first answer\n\nIN: second question\n\nYOU: second answer");
		expect(recentExchanges(join(config, "projects", "-work-x", `${id}.jsonl`))).toContain("YOU: second answer");
		expect(recentExchanges("99999999-2222-4333-8444-555555555555")).toBeUndefined();
		expect(recentExchanges("not-an-id")).toBeUndefined();
	} finally {
		if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = before;
	}
});

test("detect: a missing binary says why, a present one gives path and version", async () => {
	const missing = await detectBinary("dotz-no-such-binary-xyz");
	expect(missing.installed).toBe(false);
	expect(missing.reason).toBeTruthy();
	const present = await detectBinary(process.execPath);
	expect(present.installed).toBe(true);
	expect(present.version).toMatch(/^\d+\.\d+\.\d+/);
	expect(present.path).toBe(process.execPath);
});
