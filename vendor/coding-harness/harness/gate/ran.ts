import { basename } from "node:path";
import { type Segment, type ShellWord, shellSegments, WRITING_AGENTS } from "../guard/shell.ts";
import { WRAPPERS } from "./tool-paths.ts";

const NEVER_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "edit", "ast_edit", "todo", "ask", "web_search", "wait", "task"]);
const EVIDENCE_WRITE_PREFIXES: readonly string[] = ["xd://lsp", "xd://debug"];
const INSPECT: ReadonlySet<string> = new Set([
	"git", "cd", "pushd", "popd", "pwd", "ls", "cat", "bat", "less", "head", "tail", "nl", "wc", "rg", "grep",
	"fd", "find", "sed", "awk", "sort", "uniq", "cut", "tr", "jq", "echo", "printf", "mkdir", "cp", "mv", "rm", "rmdir",
	"touch", "chmod", "ln", "which", "type", "stat", "file", "tree", "diff", "cmp", "date", "true", "false", "test", "[", "[[",
	":", "export", "set", "unset", "local", "declare", "alias", "sleep", "wait", "exit", "return", "basename", "dirname",
	"realpath", "readlink", "ast-grep", "sg", "tee", "sponge", "xxd", "od", "du", "df", "uname", "ps", "md5sum", "shasum",
	"sha256sum", "printenv", "hostname", "whoami", "id", "patch", "read",
]);
const KEYWORD_PREFIXES: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "("]);
const NOT_PROGRAMS: ReadonlySet<string> = new Set(["for", "select", "case", "function", "fi", "done", "esac", "}"]);
const EXEC_PRIMARIES: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const EXEC_ENDS: ReadonlySet<string> = new Set([";", "+"]);
const XARGS: WrapperOptions = {
	values: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-e", "-I", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "-J"],
	positionals: 0,
};
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
const PATCH_SUBCOMMANDS: ReadonlySet<string> = new Set(["apply", "am"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_PROBE = /^-[A-Za-z]*[vV]/;

type WrapperOptions = NonNullable<ReturnType<typeof WRAPPERS.get>>;

interface Program {
	name: string;
	args: string[];
}

function field(input: unknown, key: string): unknown {
	return typeof input === "object" && input !== null ? Reflect.get(input, key) : undefined;
}

function program(words: readonly string[]): Program | undefined {
	let at = 0;
	while (at < words.length) {
		const word = words[at];
		if (ASSIGNMENT.test(word) || KEYWORD_PREFIXES.has(word)) {
			at++;
			continue;
		}
		if (NOT_PROGRAMS.has(word)) return undefined;
		const name = basename(word);
		const wrapper = name === "xargs" ? XARGS : WRAPPERS.get(name);
		if (wrapper === undefined) return { name, args: words.slice(at + 1) };
		at++;
		while (at < words.length) {
			const option = words[at];
			if (ASSIGNMENT.test(option)) at++;
			else if (option.startsWith("-")) {
				if (name === "command" && COMMAND_PROBE.test(option)) return undefined;
				at += wrapper.values.includes(option) ? 2 : 1;
			} else break;
		}
		at += wrapper.positionals;
	}
	return undefined;
}

function execRuns(args: readonly string[]): boolean {
	return args.some((arg, at) => {
		if (!EXEC_PRIMARIES.has(arg)) return false;
		const rest = args.slice(at + 1);
		const end = rest.findIndex((word) => EXEC_ENDS.has(word));
		const inner = program(end < 0 ? rest : rest.slice(0, end));
		return inner !== undefined && programRuns(inner);
	});
}

function programRuns(found: Program): boolean {
	return found.name === "find" ? execRuns(found.args) : !INSPECT.has(found.name);
}

function substitutionsOf(segment: Segment): string[] {
	return [...segment.words, ...segment.redirects].flatMap((word: ShellWord) => word.subs);
}

function bashRuns(command: string): boolean {
	if (command.trim() === "") return false;
	try {
		const segments = shellSegments(command);
		if (segments.length === 0) return true;
		return segments.some((segment) => {
			const found = program(segment.words.map((word) => word.text));
			return (found !== undefined && programRuns(found)) || substitutionsOf(segment).some(bashRuns);
		});
	} catch {
		return true;
	}
}

function gitSubcommand(args: readonly string[]): string | undefined {
	for (let at = 0; at < args.length; at++) {
		if (!args[at].startsWith("-")) return args[at];
		if (GIT_VALUE_OPTIONS.has(args[at])) at++;
	}
	return undefined;
}

function bashApplies(command: string): boolean {
	try {
		return shellSegments(command).some((segment) => {
			const found = program(segment.words.map((word) => word.text));
			if (found?.name === "patch") return true;
			if (found?.name === "git") {
				const sub = gitSubcommand(found.args);
				if (sub !== undefined && PATCH_SUBCOMMANDS.has(sub)) return true;
			}
			return substitutionsOf(segment).some(bashApplies);
		});
	} catch {
		return false;
	}
}

/** Whether a tool call executes something whose output can show that a change works. Fails open: an unknown tool or an unparseable command counts. */
export function evidenceCall(tool: string, input: unknown): boolean {
	if (NEVER_EVIDENCE_TOOLS.has(tool)) return false;
	if (tool === "write") {
		const path = field(input, "path");
		return typeof path === "string" && EVIDENCE_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix));
	}
	if (tool === "bash") {
		const command = field(input, "command");
		return typeof command !== "string" || bashRuns(command);
	}
	return true;
}

/** Whether a tool call brings in source the main session did not write with an edit tool: a `task` call, or a bash command that runs `git apply`, `git am` or `patch`. */
export function appliesPatch(tool: string, input: unknown): boolean {
	if (tool === "task") return true;
	if (tool !== "bash") return false;
	const command = field(input, "command");
	return typeof command === "string" && bashApplies(command);
}

/** Whether a tool call hands source to a worker or applies a patch: a `task` call with at least one writing worker (`task` or `sonic`; an item without an agent is `task`, and a `tasks` list that cannot be read counts), or a bash command that runs `git apply`, `git am` or `patch`. */
export function delegatesWrites(tool: string, input: unknown): boolean {
	if (tool !== "task") return appliesPatch(tool, input);
	const tasks = field(input, "tasks");
	if (!Array.isArray(tasks)) return true;
	return tasks.some((item) => {
		const agent = field(item, "agent");
		return WRITING_AGENTS.has(typeof agent === "string" ? agent : "task");
	});
}
