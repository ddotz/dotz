import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codeLockReason, scopeReaches, writeScopes, writtenPaths } from "../hub/codeguard.ts";
import { dataDir, expensiveMatch, type GuardConfig, isMain, laneShareReason, payloadStateDir, statePath } from "./guard-config.ts";
import { debug } from "./guard-debug.ts";
import { grantedHere, ownerPickedHere } from "./guard-expensive.ts";
import { limitStopProblem } from "./guard-limit.ts";
import { pipedStatusBlock } from "./guard-pipe.ts";
import { expandShellVars, shellText } from "./guard-shell.ts";
import { evalSpawnBlock, evalSpawnProblem } from "./guard-spawn.ts";
export { codeLockReason };

/** Whether the guard knows worker `id` of the session `ctx` as running: a write to its agent:// steers it, where one to a finished worker would revive it. */
export type WorkerRunning = (ctx: unknown, id: string) => boolean;

type Event = { toolName?: unknown; input?: unknown; agent?: unknown; patterns?: unknown; payload?: { model?: unknown } };
type Ctx = { cwd?: string; agent?: { kind?: string }; ui?: { notify?: (message: string, level: string) => unknown } };
type Command = { description: string; handler: (args: unknown, ctx: { ui: { notify(message: string, level: string): unknown } }) => unknown };

/** The part of omp's extension API the rules in this file register on. */
export interface RuleHost {
	on(name: string, hook: (event: Event, ctx: Ctx) => unknown): unknown;
	registerCommand(name: string, command: Command): unknown;
	getThinkingLevel?(): unknown;
}

// A lane lands a PR through dotz_merge, which checks the reviewed commit and CI; a direct `gh pr merge` would skip both.
export function laneMergeBlock(command: string, lane = process.env.DOTZ_LANE): string | undefined {
	if (!lane || !/\bgh\s+pr\s+merge\b/.test(command)) return undefined;
	return "orchestrator-guard: a lane merges a PR only through dotz_merge (action=review records the verdict for the head you read, then action=merge checks that head and CI).";
}

// The quick chat (DOTZ_CONV=quick, hub/quick-chat.ts) is a cheaper model: what launches sessions, lands code or changes settings is main's.
// Reads (dotz_connect status, dotz_channel list) and the hand-over to main (dotz_conv send main) stay.
const QUICK_READS: Record<string, string> = { dotz_connect: "status", dotz_channel: "list" };
export function quickChatBlock(tool: string, input: any, conv = process.env.DOTZ_CONV): string | undefined {
	if (conv !== "quick") return undefined;
	const launch = tool === "dotz_lane" && input?.action === "launch";
	const changes = tool in QUICK_READS && input?.action !== QUICK_READS[tool];
	if (!launch && !changes && tool !== "dotz_merge" && tool !== "dotz_escalate") return undefined;
	return `orchestrator-guard: the quick chat does not launch sessions, merge, or change settings (${tool}). Hand it to main with dotz_conv send main.`;
}

// The files every session reads at start and only the main session writes (state.json, owner rules, lessons, owner memory):
// a conversation's session hands a change to them to main, and a lane (DOTZ_LANE) puts it in its report's "<bot> 몫:" line
// (hub/forline.ts), so two sessions never write one at once (2026-11-10: a lane wrote memory/owner.md).
const SHARED_FILES = ["state.json", "RULES.md", "LESSONS.md"];
// A shell or eval text writes a shared file only when a write's target is one: a JS/Python write call with it as its target
// argument, Python open(<it>, "w"|"a"), a shell > / >> right before it, or tee/cp/mv/rm/sed -i/truncate with it as an argument.
// A bare >, =>, >= or 2>&1 is no write (2026-11-13: 52 of 57 refusals were reads, most of them a lane's first rules read).
const WRITE_CALLS = /(?<![\w$.])(?:Bun\.write|(?:os\.|fs\.)?(?:write|rename|unlink|remove|open|openSync))\s*\(|(?:(?:writeFile|appendFile)(?:Sync)?|writeAtomic|renameSync|unlinkSync|rmSync)\s*\(/g;
const SHELL_REDIRECT = /(?:^|[^=<>&\d-])\d?>>?\|?\s*([^\s;&|<>()`]+)/g;
const SHELL_WRITE_CMDS = /(?:^|[\s;&|(`"'])(tee|cp|mv|rm|truncate|sed)\s+([^;&|\n)`]*)/g;

// The top-level arguments of the call whose "(" ends just before `from`.
function callArgs(text: string, from: number): string[] {
	const args: string[] = [];
	let depth = 0, quote = "", start = from;
	for (let i = from; i < text.length; i++) {
		const c = text[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if ("([{".includes(c)) depth++;
		else if (")]}".includes(c) && depth-- === 0) return [...args, text.slice(start, i)];
		else if (c === "," && depth === 0) (args.push(text.slice(start, i)), (start = i + 1));
	}
	return [...args, text.slice(start)];
}

// A target named by a variable counts when the text set it to a shared path (not to a read of one), or when a JS/Python write's
// target is a name the text never set (an earlier cell did).
function shellWritesShared(text: string, hits: (p: string) => boolean, data: string): boolean {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const dir = `(?:${esc(data)}|\\.dotz)`;
	const file = /state\.json|RULES\.md|LESSONS\.md|memory\b/;
	const path = new RegExp(`${dir}[\\s"'\`,+/]*(?:${file.source})`);
	const dirOnly = new RegExp(`${dir}/?(?:["'\`)\\s]|$)`);
	const assigned = new Map<string, string>();
	for (const m of text.matchAll(/(?:^|[\s;,({`"'])(?:(?:const|let|var|export)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>~])\s*([^;\n]*)/g)) assigned.set(m[1]!, m[2]!);
	const sharedVars = new Set<string>(), dirVars = new Set<string>();
	const uses = (t: string, vars: Set<string>) => [...vars].some(v => new RegExp(`(?<![\\w$])${esc(v)}(?![\\w$])`).test(t));
	const names = (t: string) => path.test(t) || uses(t, sharedVars) || (uses(t, dirVars) && file.test(t));
	for (let grew = true; grew; ) {
		grew = false;
		for (const [v, rhs] of assigned) {
			const read = /(?:open|read|load|parse|text)\w*\s*\(/i.test(rhs);
			const set = read ? undefined : names(rhs) ? sharedVars : dirOnly.test(rhs) ? dirVars : undefined;
			if (set && !set.has(v)) (set.add(v), (grew = true));
		}
	}
	// Quoted text and shell words are literal paths; a bare JS/Python name or a shell $NAME is a variable.
	const target = (raw: string, shell: boolean) => {
		const quoted = /^["'`]/.test(raw.trim());
		const t = raw.trim().replace(/^["'`]|["'`]$/g, "");
		if (names(t)) return true;
		const variable = quoted ? null : (shell ? /^\$\{?([A-Za-z_]\w*)\}?$/ : /^([A-Za-z_$][\w$]*)$/).exec(t);
		if (variable) return !shell && !assigned.has(variable[1]!);
		return (quoted || shell) && /^[~\w./-]+$/.test(t) && hits(t);
	};
	for (const m of text.matchAll(WRITE_CALLS)) {
		const args = callArgs(text, m.index + m[0].length);
		if (m[0].includes("open") && !/^\s*(?:mode\s*=\s*)?[rbfu]*["'][rbt]*[wax+]/i.test(args[1] ?? "")) continue;
		if (args.slice(0, m[0].includes("rename") ? 2 : 1).some(a => target(a, false))) return true;
	}
	for (const m of text.matchAll(/([^\n;=]*)\.(?:write_text|write_bytes|unlink)\s*\(/g)) if (names(m[1]!)) return true;
	for (const m of text.matchAll(SHELL_REDIRECT)) if (target(m[1]!, true)) return true;
	for (const m of text.matchAll(SHELL_WRITE_CMDS)) {
		if (m[1] === "sed" && !/(?:^|\s)-[a-zA-Z]*i/.test(m[2]!)) continue;
		const words = m[2]!.split(/\s+/).filter(w => w && !w.startsWith("-"));
		if ((m[1] === "cp" ? words.slice(-1) : words).some(w => target(w, true))) return true;
	}
	return false;
}

// A relative path resolves in the session's folder (cwd): a lane's worktree may hold its own RULES.md or state.json.
export function sharedWriteBlock(tool: string, input: any, data = dataDir(), conv = process.env.DOTZ_CONV, lane = process.env.DOTZ_LANE, cwd = data): string | undefined {
	if (!conv && !lane) return undefined;
	const shared = [...SHARED_FILES.map(f => join(data, f)), join(data, "memory") + "/"];
	const hits = (p: string) => {
		const abs = p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(cwd, p);
		return shared.some(s => (s.endsWith("/") ? abs.startsWith(s) : abs === s));
	};
	let writes = false;
	const written = writtenPaths(tool, input);
	const scopes = writeScopes(tool, input, cwd);
	if (written.length || scopes.length || tool === "apply_patch") {
		writes =
			written.some(hits) ||
			scopes.some(scope => shared.some(s => scopeReaches(scope, s.replace(/\/$/, "")))) ||
			(tool === "apply_patch" && typeof input?.input === "string" && shared.some(s => input.input.includes(s)));
	} else if (tool === "bash" || tool === "eval") {
		const text = shellText(input);
		const named = shared.some(s => text.includes(s)) || SHARED_FILES.some(f => text.includes(`.dotz/${f}`)) || text.includes(".dotz/memory/");
		writes = named && shellWritesShared(text, hits, data);
	}
	if (!writes) return undefined;
	if (lane) return laneShareReason(data);
	return `orchestrator-guard: this session answers only its own conversation (${conv}); state.json, RULES.md, LESSONS.md and owner memory are written by the main session. Hand the change over with dotz_conv send main.`;
}

/** The reason a call breaks a rule only dotz has, or undefined: a lane that merges a PR itself, a piped push or test status, a write by a lane or conversation to a shared owner file, the quick chat's reach, workers started from an eval cell without a done-condition, a stop line tied to a usage limit. */
export function dotzCallBlock(tool: string, input: unknown, cwd?: string): string | undefined {
	const shell = tool === "bash" || tool === "eval" ? shellText(input) : undefined;
	const shellBlock = shell === undefined ? undefined : (laneMergeBlock(expandShellVars(shell)) ?? pipedStatusBlock(shell));
	if (shellBlock) return shellBlock;
	const shared = sharedWriteBlock(tool, input, dataDir(), process.env.DOTZ_CONV, process.env.DOTZ_LANE, cwd) ?? quickChatBlock(tool, input);
	if (shared) {
		debug({ phase: "shared-write-block", tool });
		return shared;
	}
	return evalSpawnProblem(tool, input) ?? limitStopProblem(tool, input);
}

/** The reason a task subagent's call breaks a rule only dotz has, or undefined: the quick chat's reach, a stop line tied to a usage limit, workers started from an eval cell without a done-condition. */
export const subagentCallBlock = (tool: string, input: unknown): string | undefined => quickChatBlock(tool, input) ?? limitStopProblem(tool, input) ?? evalSpawnProblem(tool, input);

/** Registers what the full guard and a coding lane's dotz rules share: the `/fable-ok` command and the `before_subagent_spawn` refusals (a writing worker started from an eval cell, a worker on an expensive model without the owner's ask). Returns the owner's expensive-model gate for the hooks that read it. */
export function installDotzGate(pi: RuleHost, config: GuardConfig) {
	let okUntil = 0;
	let flagged = false;
	// Owner rule, off by default: models in `expensive_models` run only after the owner asked. A dotz lane launched with owner_asked_for_fable gets DOTZ_OWNER_ASKED_FABLE=1; otherwise the user runs /fable-ok.
	const gated = config.ask_before_expensive && config.expensive_models.length > 0;
	// The gateway's grants (<DOTZ_DIR>/state/expensive-grants.json) count while `until` lies ahead; the key is this process's conversation.
	const ok = () => !gated || process.env.DOTZ_OWNER_ASKED_FABLE === "1" || Date.now() < okUntil || grantedHere();
	const reason = (what: string, found: string) => `orchestrator-guard: ${what} uses an expensive model (${found}). Models listed in guard.expensive_models run only when the owner explicitly asked for it. Use the default worker model. If the owner asked for it, get a grant on that message (POST /api/expensive-grant {conversation, owner_message: <mid>}) or have them type /fable-ok (${config.override_minutes} min).`;
	if (gated) {
		pi.registerCommand("fable-ok", {
			description: `Allow expensive-model workers (guard.expensive_models) for ${config.override_minutes} minutes (guard expensive-model gate).`,
			handler: async (_args, ctx) => {
				okUntil = Date.now() + config.override_minutes * 60_000;
				ctx.ui.notify(`orchestrator-guard: expensive-model workers allowed for ${config.override_minutes} minutes.`, "info");
			},
		});
	}
	pi.on("before_subagent_spawn", event => {
		const evalBlock = evalSpawnBlock(event);
		if (evalBlock) return evalBlock;
		const found = ok() ? undefined : expensiveMatch(event?.patterns, config);
		debug({ phase: "spawn-model", agent: event?.agent, patterns: event?.patterns, found });
		if (found) return { block: true, reason: reason(`worker ${event?.agent ?? "task"}`, found) };
	});
	const flag = (event: Event, ctx: Ctx) => {
		if (!isMain(ctx) || flagged || ok()) return;
		const effort = String(pi.getThinkingLevel?.() ?? "");
		const found = expensiveMatch([event?.payload?.model, /^(max|xhigh)$/i.test(effort) ? `:${effort}` : undefined], config);
		if (!found || ownerPickedHere(event?.payload?.model, effort, config)) return;
		flagged = true;
		debug({ phase: "session-expensive", found });
		ctx.ui?.notify?.(`orchestrator-guard: this session runs on an expensive model (${found}). Fable and max/xhigh effort are for explicit owner requests only. Do not change the model yourself: ask the owner whether it should stay (/fable-ok silences this).`, "warning");
	};
	return { gated, ok, reason, flag };
}

/** Whether the payload's orchestrator-guard (harness/guard/state.ts) tracks worker `id` as running, read from its state file for the session's folder and lane. */
export const payloadWorkerRunning = (payload: string): WorkerRunning => (ctx, id) => {
	const cwd = typeof ctx === "object" && ctx !== null && "cwd" in ctx && typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
	const file = statePath(payloadStateDir(payload), cwd, process.env.DOTZ_LANE || undefined);
	if (!existsSync(file)) return false;
	return JSON.parse(readFileSync(file, "utf8"))?.workers?.[id]?.status === "running";
};

/** What dotz's worker guard keeps while a coding lane's payload runs its own orchestrator-guard: the rules only dotz has and the owner's expensive-model gate, none of the checks the payload covers. Returns the reader of the payload's worker state that the restart hold asks about running workers. */
export function installDotzRules(pi: RuleHost, config: GuardConfig, payload: string): WorkerRunning {
	const gate = installDotzGate(pi, config);
	if (gate.gated) pi.on("before_provider_request", gate.flag);
	pi.on("tool_call", (event, ctx) => {
		const reason = dotzCallBlock(String(event?.toolName ?? ""), event?.input, ctx?.cwd);
		return reason ? { block: true, reason } : undefined;
	});
	return payloadWorkerRunning(payload);
}
