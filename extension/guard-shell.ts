// Shell-text parsing for the guard: splitting a command into words, expanding its plain variables, and refusing a recursive search of a broad path.
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// The shell text of a call: a bash command, or the code of an OmO `eval` cell (which runs shell through tool.bash / Bun.$).
export const shellText = (input: any): string => String(input?.command ?? input?.code ?? "");

// The plain NAME=value assignments of a command (quotes stripped from the value).
function shellVars(command: string): Map<string, string> {
	const vars = new Map<string, string>();
	for (const m of command.matchAll(/(?:^|[;&|\s])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)) vars.set(m[1], m[2].replace(/^['"]|['"]$/g, ""));
	return vars;
}

export function expandShellVars(command: string, vars = shellVars(command)): string {
	return command.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => vars.get(name) ?? whole);
}

// A path with an unquoted space splits into "/Users/x/Library" + "Support/..."; a recursive search of the
// broad prefix once grew an omp process to 22GB. These paths are searched only by mistake.
function broadPath(raw: string): string | undefined {
	const home = homedir();
	const expanded = raw.trim().replace(/^~(?=\/|$)/, home).replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/, home);
	if (!expanded.startsWith("/")) return undefined;
	const normalized = resolve(expanded);
	const roots = ["/", "/Users", home, join(home, "Library"), join(home, "Library", "Application Support")];
	return roots.includes(normalized) ? normalized : undefined;
}

interface ShellWord {
	text: string;
	expands: boolean;
}

function skipParen(s: string, open: number): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") i++;
		else if (c === "'" || c === '"') {
			const end = s.indexOf(c, i + 1);
			i = end < 0 ? s.length : end;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i + 1;
	}
	return s.length;
}

function skipBacktick(s: string, open: number): number {
	for (let i = open + 1; i < s.length; i++) {
		if (s[i] === "\\") i++;
		else if (s[i] === "`") return i + 1;
	}
	return s.length;
}

// Splits a command into simple-command segments of words; `expands` marks an unquoted $VAR, ${VAR}, $(...) or backtick.
function shellSegments(s: string): ShellWord[][] {
	const segments: ShellWord[][] = [];
	let words: ShellWord[] = [];
	let text = "";
	let started = false;
	let expands = false;
	const endWord = () => {
		if (started) words.push({ text, expands });
		text = "";
		started = false;
		expands = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length) segments.push(words);
		words = [];
	};
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		const next = s[i + 1] ?? "";
		if (c === "\\") {
			text += next;
			started = true;
			i += 2;
		} else if (c === "'") {
			const end = s.indexOf("'", i + 1);
			const stop = end < 0 ? s.length : end;
			text += s.slice(i + 1, stop);
			started = true;
			i = stop + 1;
		} else if (c === '"') {
			started = true;
			i++;
			while (i < s.length && s[i] !== '"') {
				if (s[i] === "\\") {
					text += s[i + 1] ?? "";
					i += 2;
				} else if (s[i] === "$" && s[i + 1] === "(") {
					const end = skipParen(s, i + 1);
					text += s.slice(i, end);
					i = end;
				} else if (s[i] === "`") {
					const end = skipBacktick(s, i);
					text += s.slice(i, end);
					i = end;
				} else text += s[i++];
			}
			i++;
		} else if (c === "$" && next === "(") {
			const end = skipParen(s, i + 1);
			text += s.slice(i, end);
			started = expands = true;
			i = end;
		} else if (c === "`") {
			const end = skipBacktick(s, i);
			text += s.slice(i, end);
			started = expands = true;
			i = end;
		} else if (c === "$" && /[A-Za-z_{]/.test(next)) {
			text += c;
			started = expands = true;
			i++;
		} else if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
			endSegment();
			i++;
		} else {
			text += c;
			started = true;
			i++;
		}
	}
	endSegment();
	return segments;
}

const WRAPPER_COMMANDS: Record<string, true> = { sudo: true, env: true, time: true, nice: true, nohup: true, command: true, exec: true, builtin: true, xargs: true, timeout: true };

function recursiveSearch(words: ShellWord[]): { name: string; args: ShellWord[] } | undefined {
	let i = 0;
	while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text) || WRAPPER_COMMANDS[basename(words[i].text)] === true || (i > 0 && /^(-|\d+$)/.test(words[i].text)))) i++;
	const head = words[i];
	if (!head) return undefined;
	const name = basename(head.text);
	const args = words.slice(i + 1);
	const has = (re: RegExp) => args.some(a => re.test(a.text));
	if (["rg", "find", "du", "fd", "fdfind"].includes(name)) return { name, args };
	if (["grep", "egrep", "fgrep", "zgrep"].includes(name) && (has(/^-[A-Za-z]*[rR]/) || has(/^--(dereference-)?recursive$/))) return { name, args };
	if (name === "ls" && (has(/^-[A-Za-z]*R/) || has(/^--recursive$/))) return { name, args };
	return undefined;
}

export function broadSearchProblem(toolName: string, input: unknown): string | undefined {
	const how = "Quote the path (a path with a space splits into several arguments) or name a specific subfolder.";
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const tool = toolName.toLowerCase();
	if (tool === "grep" || tool === "glob") {
		if (typeof record.path !== "string") return undefined;
		for (const part of record.path.split(";")) {
			const broad = broadPath(part);
			if (broad) return `orchestrator-guard: ${tool} path "${part.trim()}" (${broad}) is too broad and was blocked: a recursive search of it can exhaust memory. ${how}`;
		}
		return undefined;
	}
	if (tool !== "bash" || typeof record.command !== "string") return undefined;
	const command = record.command;
	// HOME is known even when the command never assigns it; an assignment in the command wins.
	const vars = new Map([["HOME", homedir()], ...shellVars(command)]);
	for (const words of shellSegments(command)) {
		const found = recursiveSearch(words);
		if (!found) continue;
		// Expand first: an unquoted variable whose value is known, holds no space and is not broad is as safe as the literal path.
		for (const arg of found.args) {
			const value = expandShellVars(arg.text, vars);
			if (arg.expands && /[$`\s]/.test(value)) return `orchestrator-guard: the recursive-search argument \`${arg.text}\` of \`${found.name}\` has an unquoted shell expansion whose value is unknown or holds a space, so it was blocked: a value with a space splits and can sweep a broad path such as ~/Library. Wrap the expansion in double quotes (e.g. "$VAR"). ${how}`;
			const broad = broadPath(value);
			if (broad) return `orchestrator-guard: \`${found.name}\` path "${arg.text}" (${broad}) is too broad and was blocked: a recursive search of it can exhaust memory. ${how}`;
		}
	}
	return undefined;
}
