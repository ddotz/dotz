// Three refusals that keep the orchestrator from blocking on long work or deleting what is not its own (ported from the
// owner's harness guard: loops.ts pollingProblem, deletion.ts deletionProblem). Pure functions plus one small per-session
// tracker, so they cost no tokens. The harness' bun-only machine rule is not ported: it is a personal machine preference.
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, posix } from "node:path";
import { commandStart, expandShellVars, shellSegments, type ShellWord } from "./guard-shell.ts";
import { gitTop } from "./guard-brief.ts";

// A bash call that may hold the session longer than this belongs to a `task` worker (the owner turn that took 1,065 s ran a full `bun test` and 4 waits itself).
export const LONG_BASH_SECONDS = 120;
const HANDOFF = "hand long runs (full test suites, builds) to a `task` worker and end the turn with a short report; its result arrives on its own";
const NEW_RESULT = /<task-result|task completion|\b(?:completed|finished|failed|cancelled|aborted)\b/i;

/** The gateway orchestrator and a conversation's session. A lane is exempt: its brief tells it to wait for its own runs inside one blocking call. */
export const blocksLongWork = (env: Record<string, string | undefined> = process.env): boolean => !env.DOTZ_LANE && (env.DOTZ_ORCHESTRATOR === "1" || Boolean(env.DOTZ_CONV));

/** The refusal for a bash call that blocks this session for long: a deadline over LONG_BASH_SECONDS, or none (0). `async: true` and a named service (`name` + `ready`) return at once. */
export function longBashProblem(input: unknown): string | undefined {
	const call = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	if (call.async === true || (call.name && call.ready)) return undefined;
	const seconds = call.timeout === undefined ? undefined : Number(call.timeout);
	if (seconds === undefined || !(seconds === 0 || seconds > LONG_BASH_SECONDS)) return undefined;
	return `orchestrator-guard: this bash call would block the session ${seconds === 0 ? "with no deadline" : `for up to ${seconds} s`} (limit ${LONG_BASH_SECONDS} s). Do not run long work yourself: ${HANDOFF}. Something that must stay up goes in \`async: true\` or a named service (\`name\` + \`ready\`).`;
}

const WAIT_AGAIN = `orchestrator-guard: the previous wait returned nothing new and this is another wait, which only blocks the session. A worker's result arrives on its own: do other work first, or end the turn with a short report of what is running. To run something long, ${HANDOFF}.`;

/** Per-session record of the last tool call, so a wait right after a wait that brought nothing is refused. A single wait, or a wait after any other call, passes. */
type Handler = (event: { toolName?: string; content?: { text?: string }[] }) => unknown;
export function createLongGuard(pi: { on(name: string, handler: Handler): unknown }) {
	let last = "";
	let idleWait = false;
	const reset = () => {
		last = "";
		idleWait = false;
	};
	pi.on("tool_result", event => {
		if (event?.toolName !== "wait") return;
		const text = (event.content ?? []).map(b => b?.text ?? "").join("\n");
		idleWait = !NEW_RESULT.test(text);
	});
	// A new owner message or the end of a turn: the next wait is a first wait again.
	pi.on("input", reset);
	pi.on("agent_end", reset);
	/** Records the call and returns the phase and reason when this session may not make it, or undefined. `running` is read only for a bash call that mentions sleep. */
	return (tool: string, input: unknown, running: () => number, env = process.env): { phase: string; reason: string } | undefined => {
		const again = tool === "wait" && last === "wait" && idleWait;
		last = tool;
		// Until its result says otherwise (tool_result above), a wait counts as one that brought nothing.
		idleWait = tool === "wait";
		if (blocksLongWork(env)) {
			if (again) return { phase: "wait-again-block", reason: WAIT_AGAIN };
			const long = tool === "bash" ? longBashProblem(input) : undefined;
			if (long) return { phase: "long-bash-block", reason: long };
		}
		const command = (input as { command?: unknown } | undefined)?.command;
		const polling = tool === "bash" && typeof command === "string" && command.includes("sleep") ? pollingProblem(expandShellVars(command), running()) : undefined;
		return polling ? { phase: "polling-block", reason: polling } : undefined;
	};
}

const SHOWN_COMMAND = 120;
const shown = (command: string): string => {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > SHOWN_COMMAND ? `${flat.slice(0, SHOWN_COMMAND)}...` : flat;
};
const KEYWORDS: Record<string, true> = { then: true, do: true, else: true, elif: true, if: true, while: true, until: true, "{": true, "!": true, time: true };
const LOOP_OPENERS: Record<string, true> = { while: true, until: true, for: true };
const STATUS_READERS: Record<string, true> = { cat: true, tail: true, head: true, ls: true, ps: true, pgrep: true, grep: true, rg: true, wc: true, stat: true, echo: true, date: true, jobs: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function leadingWord(words: ShellWord[]): { name: string; opener: string } | undefined {
	let i = 0;
	while (i < words.length && ASSIGNMENT.test(words[i].text)) i++;
	const opener = words[i] === undefined ? "" : basename(words[i].text);
	while (i < words.length && KEYWORDS[basename(words[i].text)] === true) i++;
	return words[i] === undefined ? undefined : { name: basename(words[i].text), opener };
}

/** Why a main session may not run this bash command while workers run (a wait by sleep: `sleep N` alone or with a status read, or a loop that sleeps), or undefined when it is allowed. */
export function pollingProblem(command: string, runningJobs: number): string | undefined {
	if (runningJobs <= 0 || !command.includes("sleep")) return undefined;
	let sleeps = false;
	let loop = false;
	let others = false;
	for (const words of shellSegments(command)) {
		const lead = leadingWord(words);
		if (lead === undefined) continue;
		if (LOOP_OPENERS[lead.opener] === true) loop = true;
		if (lead.name === "sleep") sleeps = true;
		else if (STATUS_READERS[lead.name] !== true && lead.name !== "done" && lead.name !== "}") others = true;
	}
	if (!sleeps || (!loop && others)) return undefined;
	return `orchestrator-guard: ${runningJobs} worker(s) are running and \`${shown(command)}\` waits for them with sleep. Do not poll: use the blocking \`wait\` tool, or end the turn; results arrive on their own.`;
}

const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
const HOME_FORMS = [/^~(?=\/|$)/, /^\$HOME(?=\/|$)/, /^\$\{HOME\}(?=\/|$)/];
const MAX_DEPTH = 3;

interface Scan {
	root: string; // the session's own folder
	dir: string | undefined; // the shell's current folder after `cd`; undefined once it cannot be known
	home: string;
	temp: string[];
	depth: number;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
const operandsOf = (args: ShellWord[]): string[] => {
	let options = true;
	const operands: string[] = [];
	for (const { text } of args) {
		if (options && text === "--") options = false;
		else if (!options || !text.startsWith("-") || text === "-") operands.push(text);
	}
	return operands;
};
const recursive = (args: ShellWord[]): boolean => {
	for (const { text } of args) {
		if (text === "--") break;
		if (text === "--recursive" || /^-[A-Za-z]*[rR]/.test(text)) return true;
	}
	return false;
};

// An absolute path for a word, or undefined when it holds a variable or substitution this rule cannot read (not refused).
function resolveWord(text: string, scan: Scan): string | undefined {
	let value = text;
	for (const form of HOME_FORMS) {
		const found = form.exec(value);
		if (found) {
			value = scan.home + value.slice(found[0].length);
			break;
		}
	}
	if (value.includes("$") || value.includes("`") || value.startsWith("~")) return undefined;
	if (value.startsWith("/")) return posix.resolve(value);
	return scan.dir === undefined ? undefined : posix.resolve(scan.dir, value);
}

/** `self`: the target may be the session folder itself (`find . -delete`), but never a folder that contains it. */
function targetProblem(verb: string, text: string, scan: Scan, self: boolean): string | undefined {
	const abs = resolveWord(text, scan);
	if (abs === undefined) return undefined;
	const protectedPath = abs === "/" || abs === scan.home || scan.temp.includes(abs) || basename(abs) === ".git" || (within(scan.root, abs) && !(self && abs === scan.root));
	if (protectedPath) return `orchestrator-guard: \`${verb}\` target "${text}" (${abs}) is protected: home, /, a temp folder, .git, or a folder that holds this session's own folder (${scan.root}). It was blocked. Delete exact paths inside ${scan.root} or the temp folders; for anything else name the path in your report and let the owner run it.`;
	if (verb === "rm" && /^\.?\*$/.test(basename(abs)) && posix.dirname(abs) === scan.root) return `orchestrator-guard: \`rm -r ${text}\` would empty this session's folder (${scan.root}). Name the exact paths to delete instead.`;
	if (within(abs, scan.root) || scan.temp.some(root => within(abs, root))) return undefined;
	const top = gitTop(scan.root);
	if (top && within(realish(abs), top)) return undefined;
	return `orchestrator-guard: \`${verb}\` target "${text}" (${abs}) is outside this session's folder (${scan.root}) and the temp folders, so it was blocked. Delete only paths inside ${scan.root} or /tmp; for anything else name the path in your report and let the owner run it.`;
}

// `path` with its existing part resolved through symlinks (gitTop answers with real paths: /var/folders is /private/var/folders on macOS).
function realish(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = posix.dirname(path);
		return parent === path ? path : posix.join(realish(parent), basename(path));
	}
}

function findRoots(args: ShellWord[]): string[] {
	let i = 0;
	while (i < args.length && /^-[HLPEXxsd]+$|^-O\d$/.test(args[i].text)) i++;
	const roots: string[] = [];
	for (; i < args.length; i++) {
		const text = args[i].text;
		if (text.startsWith("-") || text === "(" || text === "!" || text === ",") break;
		roots.push(text);
	}
	return roots.length === 0 ? ["."] : roots;
}
const deletes = (args: ShellWord[]): boolean => args.some((arg, i) => arg.text === "-delete" || (/^-(?:exec|execdir|ok|okdir)$/.test(arg.text) && basename(args[i + 1]?.text ?? "") === "rm"));

function nestedCode(name: string, args: ShellWord[]): string | undefined {
	if (name === "eval") return args.map(arg => arg.text).join(" ");
	if (SHELLS[name] !== true) return undefined;
	const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg.text));
	return at < 0 ? undefined : args.slice(at + 1).find(arg => !arg.text.startsWith("-"))?.text;
}

function scanCommand(command: string, scan: Scan): string | undefined {
	if (scan.depth > MAX_DEPTH) return undefined;
	for (const words of shellSegments(expandShellVars(command))) {
		const at = commandStart(words);
		if (words[at] === undefined) continue;
		const name = basename(words[at].text);
		const args = words.slice(at + 1);
		if (name === "cd" || name === "pushd") {
			const target = operandsOf(args)[0];
			scan.dir = target === undefined ? scan.home : target === "-" ? undefined : resolveWord(target, scan);
		} else if (name === "popd") scan.dir = undefined;
		else if (name === "rm" && recursive(args)) {
			for (const text of operandsOf(args)) {
				const found = targetProblem("rm", text, scan, false);
				if (found) return found;
			}
		} else if (name === "find" && deletes(args)) {
			for (const text of findRoots(args)) {
				const found = targetProblem("find -delete", text, scan, true);
				if (found) return found;
			}
		}
		const code = nestedCode(name, args);
		const nested = code === undefined ? undefined : scanCommand(code, { ...scan, depth: scan.depth + 1 });
		if (nested) return nested;
	}
	return undefined;
}

/**
 * The refusal when a bash command removes recursively (`rm -r`, `find ... -delete`) a path that is protected (home, /, a temp root, .git, a bare `*`
 * of the session folder, or a folder holding it) or lies outside the session folder, its git checkout and the temp folders; otherwise undefined.
 * `~`, `$HOME`, relative paths (after `cd`) and `..` are resolved; a target built from an unknown variable is not refused. A quoted mention
 * (`echo 'rm -rf /'`) is one word of echo, not a command.
 */
export function deletionProblem(command: string, cwd: string, home: string, temp: string[] = [...new Set([tmpdir(), ...TEMP_ROOTS])]): string | undefined {
	if (!/\b(?:rm|find)\b/.test(command)) return undefined;
	const root = posix.resolve(cwd);
	return scanCommand(command, { root, dir: root, home: posix.resolve(home), temp: temp.map(path => posix.resolve(path)), depth: 0 });
}

/** deletionProblem for a bash call of a session working in `cwd` (the call's own `cwd` argument counts), the form the guard hooks use. */
export function deletionBlock(tool: string, input: unknown, cwd: unknown): string | undefined {
	const call = (typeof input === "object" && input !== null ? input : {}) as { command?: unknown; cwd?: unknown };
	if (tool !== "bash" || typeof call.command !== "string") return undefined;
	return deletionProblem(call.command, posix.resolve(String(cwd ?? process.cwd()), String(call.cwd ?? "")), homedir());
}
