import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installWorkerGate } from "./worker-gate.ts";

const GATE = `export function registerDoneGate(api) {
	for (const name of ["before_agent_start", "assistant_message", "session_stop"]) api.on(name, async () => undefined);
	return { async sessionChanges(ctx) { return [{ repo: ctx.cwd, base: "HEAD", files: ["a.ts"] }]; }, waive: () => false };
}
`;

const bootstrap = (dir: string): string => `import { writeFileSync } from "node:fs";
export const needsBootstrap = async () => true;
if (import.meta.main) writeFileSync(${JSON.stringify(join(dir, "bootstrap-ran"))}, process.env.HARNESS_AGENT_HOME ?? "unset");
`;

const decoyGate = (dir: string): string => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "decoy-imported"))}, "yes");
${GATE}`;

const FINAL = { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };
const ENV = ["HARNESS_AGENT_HOME", "PI_CODING_AGENT_DIR"] as const;

let root: string;
let payload: string;
let decoy: string;
let repo: string;
let saved: Record<string, string | undefined>;

const put = (file: string, text: string): void => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dotz-worker-gate-coding-")));
	payload = join(root, "payload");
	decoy = join(root, "decoy");
	repo = join(root, "repo");
	put(join(payload, "extensions", "done-gate.ts"), GATE);
	put(join(payload, "harness", "gate", "bootstrap.ts"), bootstrap(payload));
	put(join(decoy, "extensions", "done-gate.ts"), decoyGate(decoy));
	put(join(decoy, "harness", "gate", "bootstrap.ts"), bootstrap(decoy));
	mkdirSync(repo, { recursive: true });
	for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one"]]) {
		const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		expect(r.exitCode, r.stderr.toString()).toBe(0);
	}
	saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
});

afterEach(() => {
	for (const name of ENV) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
	rmSync(root, { recursive: true, force: true });
});

test("a payload dir given as the agent dir runs its own gate and bootstrap, the child sees the payload as HARNESS_AGENT_HOME, and a decoy in PI_CODING_AGENT_DIR is never loaded", async () => {
	process.env.HARNESS_AGENT_HOME = payload;
	process.env.PI_CODING_AGENT_DIR = decoy;
	const err = spyOn(console, "error").mockImplementation(() => {});
	try {
		const hooks: { name: string; hook: (event: unknown, ctx: unknown) => unknown }[] = [];
		const pi = { zod: {}, on: (name: string, hook: (event: unknown, ctx: unknown) => unknown) => void hooks.push({ name, hook }), registerTool: () => {}, registerCommand: () => {}, sendMessage: () => {} };
		await installWorkerGate(pi, { agentDir: payload, first: false });
		expect(hooks.length).toBeGreaterThan(0);
		const ctx = { agent: { kind: "sub", id: "w1", depth: 1 }, cwd: repo, hasUI: true, sessionManager: { getSessionId: () => "s-w1" } };
		for (const name of ["before_agent_start", "assistant_message"]) {
			for (const h of hooks.filter(o => o.name === name)) await h.hook(name === "assistant_message" ? FINAL : { reason: "prompt", prompt: "go" }, ctx);
		}
		expect(readFileSync(join(payload, "bootstrap-ran"), "utf8")).toBe(payload);
		expect(existsSync(join(decoy, "decoy-imported"))).toBe(false);
		expect(existsSync(join(decoy, "bootstrap-ran"))).toBe(false);
		expect(err.mock.calls.map(args => String(args[0]))).toEqual([]);
	} finally {
		err.mockRestore();
	}
});
