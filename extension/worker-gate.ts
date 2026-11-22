import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { BOOTSTRAP_LIMIT_MS, excludeGenerated, harnessFiles, type HarnessGate } from "./harness-gate.ts";
import type { Host } from "./omp-host.ts";
import { findBun } from "./recall-tool.ts";

type Hook = (event: unknown, ctx: unknown) => unknown;
type Change = { repo: string; files: string[] };
type DoneGate = { sessionChanges(ctx: unknown): Promise<Change[]> };
type GateModule = { registerDoneGate: (api: object) => DoneGate };
type BootstrapModule = { needsBootstrap: (repo: string, signal?: AbortSignal) => Promise<boolean> };
type Gate = { files: HarnessGate; hooks: Map<string, Hook[]>; done: DoneGate; needsBootstrap: BootstrapModule["needsBootstrap"] };

const MODULES = Symbol.for("dotz.workerGate.modules");
const BOOTSTRAPS = Symbol.for("dotz.workerGate.bootstraps");
// why(platform): omp imports the extension again (`?mtime`, a fresh module graph) for an isolated task subagent, so what must outlive one run lives on the process (omp@18.22.0)
const shared = globalThis as { [MODULES]?: Map<string, Promise<unknown>>; [BOOTSTRAPS]?: Map<string, Promise<void>> };
const runGit = promisify(execFile);

const note = (what: string, error: unknown): void => console.error(`dotz worker gate: ${what}: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ")}`);
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
const isWorker = (ctx: unknown): ctx is object => field(field(ctx, "agent"), "kind") === "sub";
const isGateModule = (module: unknown): module is GateModule => typeof field(module, "registerDoneGate") === "function";
const isBootstrapModule = (module: unknown): module is BootstrapModule => typeof field(module, "needsBootstrap") === "function";

function load(file: string): Promise<unknown> {
	const cache = (shared[MODULES] ??= new Map());
	const known = cache.get(file);
	if (known) return known;
	const loading = import(file);
	cache.set(file, loading);
	return loading;
}

async function toplevel(cwd: string): Promise<string | undefined> {
	try {
		return (await runGit("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 })).stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

function killGroup(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

// why(platform): omp is a compiled executable, so process.execPath is omp and not bun, which the script needs (omp@18.22.2)
function runScript(script: string, repo: string): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const child = spawn(findBun(process.execPath, process.env), [script, repo], { cwd: repo, detached: true, stdio: ["ignore", "ignore", "inherit"], timeout: BOOTSTRAP_LIMIT_MS + 5_000, killSignal: "SIGKILL" });
	const timer = setTimeout(() => {
		killGroup(child);
		resolve(`timed out after ${BOOTSTRAP_LIMIT_MS / 1000} s`);
	}, BOOTSTRAP_LIMIT_MS);
	const end = (outcome?: string): void => {
		clearTimeout(timer);
		resolve(outcome);
	};
	child.once("error", error => end(`not run: ${error.message}`));
	child.once("exit", (code, signal) => end(code === 0 ? undefined : `exited ${code ?? signal}`));
	return promise;
}

async function bootstrapRepo(gate: Gate, repo: string): Promise<void> {
	try {
		if (!(await gate.needsBootstrap(repo, AbortSignal.timeout(BOOTSTRAP_LIMIT_MS)))) return;
		excludeGenerated(repo);
		const failure = await runScript(gate.files.bootstrap, repo);
		if (failure) note(`bootstrap of ${repo}`, failure);
	} catch (error) {
		note(`bootstrap of ${repo} not run`, error);
	}
}

function bootstrapOnce(gate: Gate, repo: string): Promise<void> {
	const runs = (shared[BOOTSTRAPS] ??= new Map());
	const known = runs.get(repo);
	if (known) return known;
	const run = bootstrapRepo(gate, repo);
	runs.set(repo, run);
	return run;
}

async function bootstrapCwd(gate: Gate, view: object): Promise<void> {
	const cwd = field(view, "cwd");
	const repo = await toplevel(typeof cwd === "string" ? cwd : process.cwd());
	if (repo) await bootstrapOnce(gate, repo);
}

function asMain(ctx: object): object {
	const own = { agent: Object.assign({}, field(ctx, "agent"), { kind: "main" }), hasUI: false, ui: undefined };
	return new Proxy(ctx, { get: (target, prop) => (Object.hasOwn(own, prop) ? Reflect.get(own, prop) : Reflect.get(target, prop, target)) });
}

async function call(hooks: Hook[] | undefined, event: unknown, view: object): Promise<unknown> {
	let result: unknown;
	for (const hook of hooks ?? []) result = (await hook(event, view)) ?? result;
	return result;
}

function completed(event: unknown): boolean {
	const message = field(event, "message");
	const stopReason = field(message, "stopReason");
	const content = field(message, "content");
	return stopReason !== "aborted" && stopReason !== "error" && !(Array.isArray(content) && content.some(block => field(block, "type") === "toolCall"));
}

// why(platform): omp never fires session_stop for a task subagent, and a steer queued from its assistant_message hook gives it another turn instead of ending (omp@18.22.2)
async function judge(pi: Host, gate: Gate, early: Promise<void> | undefined, event: unknown, view: object): Promise<void> {
	const stop = gate.hooks.get("session_stop");
	if (!stop || !completed(event)) return;
	const changed = (await gate.done.sessionChanges(view)).filter(change => change.files.length > 0);
	if (changed.length === 0) return;
	const repos = [...new Set(changed.map(change => change.repo))];
	await Promise.all([early, ...repos.map(repo => bootstrapOnce(gate, repo))]);
	const verdict = await call(stop, {}, view);
	const reason = field(verdict, "reason");
	if (field(verdict, "decision") === "block" && typeof reason === "string") pi.sendMessage({ customType: "done-gate", display: false, content: reason }, { deliverAs: "steer" });
}

function installHooks(pi: Host, gate: Gate): void {
	let early: Promise<void> | undefined;
	for (const [name, hooks] of gate.hooks) {
		if (name === "session_stop") continue;
		pi.on(name, async (event, ctx) => {
			if (!isWorker(ctx)) return undefined;
			const view = asMain(ctx);
			try {
				if (name === "before_agent_start") early ??= bootstrapCwd(gate, view);
				const result = await call(hooks, event, view);
				if (name === "assistant_message") await judge(pi, gate, early, event, view);
				return result;
			} catch (error) {
				note(`${name} hook failed`, error);
				return undefined;
			}
		});
	}
}

async function loadGate(pi: Host, files: HarnessGate): Promise<Gate | undefined> {
	const [extension, bootstrap] = await Promise.all([load(files.extension), load(files.bootstrap)]);
	if (!isGateModule(extension) || !isBootstrapModule(bootstrap)) {
		note("not installed", `${files.extension} lacks registerDoneGate or ${files.bootstrap} lacks needsBootstrap`);
		return undefined;
	}
	const hooks = new Map<string, Hook[]>();
	const api = {
		zod: field(pi, "zod"),
		on: (name: string, hook: Hook): void => void hooks.set(name, [...(hooks.get(name) ?? []), hook]),
		registerCommand: (): void => undefined,
		registerTool: (): void => undefined,
		sendMessage: (): void => undefined,
	};
	return { files, hooks, done: extension.registerDoneGate(api), needsBootstrap: bootstrap.needsBootstrap };
}

async function install(pi: Host, files: HarnessGate): Promise<void> {
	try {
		const gate = await loadGate(pi, files);
		if (gate) installHooks(pi, gate);
	} catch (error) {
		note("not installed", error);
	}
}

export function installWorkerGate(pi: Host, o: { agentDir: string | undefined; first: boolean }): Promise<void> | undefined {
	if (o.first || !o.agentDir || process.env.DONE_GATE_DISABLED === "1") return undefined;
	const files = harnessFiles(o.agentDir);
	return files ? install(pi, files) : undefined;
}
