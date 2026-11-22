import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord, list, shellHome } from "./util.ts";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
const SKILL_REF = /skill:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)|(?:^|\/)skills\/([A-Za-z0-9][A-Za-z0-9._-]*)\/[^/\s]/g;
const SHELL_DIRS = /(?:^|[;&|(\n]\s*)(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)|\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const PATH_ARGS = /"([^"]*)"|'([^']*)'|(?<![\w.@+~/}-])((?:\/|~\/|\$HOME\/|\$\{HOME\}\/)[\w@+~./-]*)/g;
const PATH_START = /^(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)/;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/)/;

const skillNames = (text: string): string[] => [...text.matchAll(SKILL_REF)].map(match => match[1] ?? match[2]);

/** The skills a read or bash call reads. A `read` reads the skill named by a skill:// URL or by a path `.../skills/<name>/<file>`; a bash command reads it only through `cat`, `head`, `tail`, `less`, `more`, `bat` or `sed -n` (also under `bash -c`) on such a URL or path, not when it merely mentions it. */
export function skillsRead(tool: string | undefined, input: Record<string, unknown>): string[] {
	if (tool === "read") return typeof input.path === "string" ? skillNames(input.path) : [];
	return tool === "bash" && typeof input.command === "string" ? statements(withoutHeredocs(input.command)).flatMap(skillsReadBy) : [];
}

function skillsReadBy(words: readonly string[]): string[] {
	const [name, ...args] = commandWords(words);
	if (name === undefined) return [];
	const program = basename(name);
	if (SHELLS.includes(program)) {
		const script = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
		return script >= 0 && script + 1 < args.length ? statements(withoutHeredocs(args[script + 1])).flatMap(skillsReadBy) : [];
	}
	if (!SKILL_READERS.includes(program) || (program === "sed" && !args.some(arg => /^-[a-z]*n[a-z]*$/.test(arg) || arg === "--quiet" || arg === "--silent"))) return [];
	return args.flatMap(skillNames);
}

function patchTargets(patch: string): string[] {
	const targets: string[] = [];
	for (const match of patch.matchAll(/^\[(.+)#[0-9A-Za-z?]*\]\s*$/gm)) targets.push(match[1]);
	for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete|Edit) File:\s*(.+?)(?:\s+all)?\s*$/gm)) targets.push(match[1]);
	for (const match of patch.matchAll(/^(?:\*\*\* Move to:|MV)\s+(.+?)\s*$/gm)) targets.push(match[1].replace(/^(["'])(.*)\1$/, "$2"));
	return targets;
}

function globBase(pattern: string): string {
	const segments = pattern.split("/");
	const plain = segments.findIndex(segment => /[*?[{]/.test(segment));
	return plain < 0 ? pattern : segments.slice(0, plain).join("/") || ".";
}

function toPath(raw: string, cwd: string): string | undefined {
	let path = raw.trim();
	const wrapped = /^\[(.+)#[0-9A-Za-z?]*\]$/.exec(path);
	if (wrapped) path = wrapped[1];
	if (path === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
	if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
	return resolve(cwd, path);
}

/** The absolute paths an edit, write or ast_edit call is about to change: its path and paths inputs, the file headers of an edit payload, and an ast_edit glob's base directory. */
export function editedPaths(tool: string | undefined, input: Record<string, unknown>, cwd: string): string[] {
	if (tool === undefined || EDIT_TOOLS[tool] !== true) return [];
	const raw: string[] = [];
	if (typeof input.path === "string") raw.push(input.path);
	for (const item of list(input.paths) ?? []) if (typeof item === "string") raw.push(item);
	if (tool === "edit" && typeof input.input === "string") raw.push(...patchTargets(input.input));
	const paths = new Set<string>();
	for (const item of raw) {
		const path = toPath(tool === "ast_edit" ? globBase(item) : item, cwd);
		if (path) paths.add(path);
	}
	return [...paths];
}

/** The directories a bash call works in before it runs: its `cwd` input, then each `cd`, `pushd` and `git -C` target of its command, resolved against the directory the command is in at that point, then the directory of every absolute path (or `~/`, `$HOME/`, `${HOME}/` path) the command names as a bare word or as a whole quoted string; a path inside a quoted string that starts with something else is text, not an argument. The path itself counts when it is a directory or ends in `/`, else its parent. A file that need not exist yet leads to its nearest existing parent through `existingDir`; nothing is globbed. */
export function bashDirs(input: Record<string, unknown>, cwd: string): string[] {
	let at = typeof input.cwd === "string" ? resolve(cwd, input.cwd) : cwd;
	const dirs = [at];
	const command = typeof input.command === "string" ? input.command : "";
	for (const match of command.matchAll(SHELL_DIRS)) {
		const entered: string | undefined = match[1];
		const named: string | undefined = match[2];
		const target = toPath((entered ?? named ?? "").replace(/^(["'])(.*)\1$/, "$2"), at);
		if (target === undefined) continue;
		if (entered !== undefined) at = target;
		dirs.push(target);
	}
	for (const match of command.matchAll(PATH_ARGS)) {
		const raw = match[1] ?? match[2] ?? match[3];
		if (!PATH_START.test(raw)) continue;
		const path = resolve(raw.replace(HOME_PREFIX, shellHome()));
		const dir = raw.endsWith("/") || statSync(path, { throwIfNoEntry: false })?.isDirectory() === true ? path : dirname(path);
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}

function astEditDetails(tool: string | undefined, details: unknown): Record<string, unknown> | undefined {
	if (tool === "ast_edit") return isRecord(details) ? details : undefined;
	if (tool !== "write" || !isRecord(details) || !isRecord(details.xdev)) return undefined;
	const inner = details.xdev.inner;
	return isRecord(inner) && inner.action === "apply" && inner.sourceToolName === "ast_edit" && isRecord(inner.sourceResultDetails) ? inner.sourceResultDetails : undefined;
}

/** The absolute paths an ast_edit applied, from its own result when it applied at once or from the `write` to xd://resolve that applied its staged proposal; a proposal still staged changed nothing. */
export function appliedPaths(tool: string | undefined, details: unknown, cwd: string): string[] {
	const applied = astEditDetails(tool, details);
	if (!applied || applied.applied !== true) return [];
	const root = typeof applied.cwd === "string" ? applied.cwd : cwd;
	return (list(applied.files) ?? []).filter((file): file is string => typeof file === "string").map(file => resolve(root, file));
}

/** The absolute paths a finished edit, write or ast_edit call changed. */
export function touchedPaths(tool: string | undefined, input: Record<string, unknown>, details: unknown, cwd: string): string[] {
	const direct = tool === "ast_edit" ? [] : editedPaths(tool, input, cwd);
	return [...new Set([...direct, ...appliedPaths(tool, details, cwd)])];
}

const HISTORY_COMMANDS: readonly string[] = ["merge", "pull", "rebase", "cherry-pick", "checkout", "switch", "restore", "stash", "revert", "reset"];
const GIT_VALUE_OPTIONS: readonly string[] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"];
const SHELLS: readonly string[] = ["bash", "sh", "zsh", "dash", "ksh"];
const SKILL_READERS: readonly string[] = ["cat", "head", "tail", "less", "more", "bat", "sed"];
const KEYWORDS: readonly string[] = ["if", "then", "else", "elif", "do", "while", "until", "!", "{"];
const DIRECTORY_COMMANDS: readonly string[] = ["cd", "pushd", "popd"];
const CLOSERS: readonly string[] = ["fi", "done", "esac", "}"];
const OUTPUT_REDIRECT = /^[^>]*>>?(.*)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w-]*))/;

interface Wrapper {
	values: readonly string[];
	positionals: number;
}

export const WRAPPERS = new Map<string, Wrapper>([
	["env", { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], positionals: 0 }],
	["command", { values: [], positionals: 0 }],
	["exec", { values: ["-a"], positionals: 0 }],
	["nohup", { values: [], positionals: 0 }],
	["time", { values: ["-f", "--format", "-o", "--output"], positionals: 0 }],
	["nice", { values: ["-n", "--adjustment"], positionals: 0 }],
	["sudo", { values: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-T"], positionals: 0 }],
	["timeout", { values: ["-k", "-s", "--kill-after", "--signal"], positionals: 1 }],
]);

function withoutHeredocs(source: string): string {
	const kept: string[] = [];
	let ending: { word: string; tabs: boolean } | undefined;
	for (const line of source.split("\n")) {
		if (ending !== undefined) {
			if ((ending.tabs ? line.replace(/^\t+/, "") : line) === ending.word) ending = undefined;
			continue;
		}
		kept.push(line);
		const start = HEREDOC.exec(line);
		if (start !== null) ending = { word: start[2] ?? start[3] ?? start[4], tabs: start[1] === "-" };
	}
	return kept.join("\n");
}

function statements(source: string): string[][] {
	const found: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endStatement = () => {
		endWord();
		if (words.length > 0) found.push(words);
		words = [];
	};
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = undefined;
			else if (ch === "\\" && i + 1 < source.length) word += source[++i];
			else word += ch;
		} else if (ch === "\\") {
			if (i + 1 < source.length && source[i + 1] !== "\n") {
				word += source[++i];
				inWord = true;
			} else i++;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "#" && !inWord) {
			while (i + 1 < source.length && source[i + 1] !== "\n") i++;
		} else if (ch === "&" && (source[i - 1] === ">" || source[i - 1] === "<" || source[i + 1] === ">")) {
			word += ch;
			inWord = true;
		} else if (";&|()`\n".includes(ch)) endStatement();
		else if (ch === " " || ch === "\t") endWord();
		else {
			word += ch;
			inWord = true;
		}
	}
	endStatement();
	return found;
}

function commandWords(words: readonly string[]): string[] {
	let at = 0;
	for (;;) {
		const word = words[at];
		if (word === undefined) return [];
		if (KEYWORDS.includes(word) || ASSIGNMENT.test(word)) {
			at++;
			continue;
		}
		const wrapper = WRAPPERS.get(word);
		if (wrapper === undefined) return words.slice(at);
		at++;
		while (at < words.length) {
			const option = words[at];
			if (ASSIGNMENT.test(option)) at++;
			else if (option.startsWith("-")) at += wrapper.values.includes(option) ? 2 : 1;
			else break;
		}
		at += wrapper.positionals;
	}
}

function subcommand(args: readonly string[]): string | undefined {
	for (let at = 0; at < args.length; at++) {
		if (!args[at].startsWith("-")) return args[at];
		if (GIT_VALUE_OPTIONS.includes(args[at])) at++;
	}
	return undefined;
}

function isHistoryMove(words: readonly string[]): boolean {
	const [name, ...args] = commandWords(words);
	if (name === undefined) return false;
	if (SHELLS.includes(basename(name))) {
		const script = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
		return script >= 0 && script + 1 < args.length && movesHistory(args[script + 1]);
	}
	const sub = basename(name) === "git" ? subcommand(args) : undefined;
	return sub !== undefined && HISTORY_COMMANDS.includes(sub);
}

/** Whether a bash command runs a git command that moves history or rewrites the working tree from it (merge, pull, rebase, cherry-pick, checkout, switch, restore, stash, revert, reset), at command position: after a separator, a keyword, a wrapper such as env or sudo, or inside `bash -c`. `git apply`, `git am` (which applies patches, see `appliesPatch`) and `git commit` do not. */
export function movesHistory(command: string): boolean {
	return statements(withoutHeredocs(command)).some(isHistoryMove);
}

function writesFile(words: readonly string[]): boolean {
	return words.some((word, at) => {
		const target = OUTPUT_REDIRECT.exec(word)?.[1];
		return target !== undefined && !target.startsWith("&") && (target === "" ? words[at + 1] : target) !== "/dev/null";
	});
}

function isGitOnly(words: readonly string[]): boolean {
	if (words.length === 1 && CLOSERS.includes(words[0])) return true;
	const [name, ...args] = commandWords(words);
	if (name === undefined) return words.every(word => ASSIGNMENT.test(word) || KEYWORDS.includes(word) || CLOSERS.includes(word));
	if (writesFile(words)) return false;
	if (SHELLS.includes(basename(name))) {
		const script = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
		return script >= 0 && script + 1 < args.length && statements(withoutHeredocs(args[script + 1])).every(isGitOnly);
	}
	return basename(name) === "git" || DIRECTORY_COMMANDS.includes(name);
}

/** Whether a bash command moves the base text of every file it changes that the session never changed: it runs a history-moving git command (see `movesHistory`) and every command of it is a git command or a directory change (`cd`, `pushd`, `popd`), with no output redirected to a file. A call that also runs anything else may have written the files the git command then carries along, so it moves only the files that `BaseTexts.moveBrought` allows. The engine never asks about a call that applies a patch (`appliesPatch`): that call moves nothing, whatever else it runs. */
export function movesBase(command: string): boolean {
	const found = statements(withoutHeredocs(command));
	return found.some(isHistoryMove) && found.every(isGitOnly);
}
