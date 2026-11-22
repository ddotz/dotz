import { statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { harnessDir } from "../agent-home.ts";
import { commandHead, expandShellVars, shellSegments, skipBacktick, skipParen } from "./shell.ts";

/**
 * The worker env file, read per call. Layer 1 of the worker boundary (harness/worker-env.sh): every worker bash command first sources the env file that makes pushes, wrangler and the like fail however they are invoked (make, scripts), which the string patterns cannot promise.
 * ORCH_GUARD_WORKER_ENV points it elsewhere for tests and for a copy of this extension run with -e.
 */
export const workerEnvFile = () => process.env.ORCH_GUARD_WORKER_ENV ?? join(harnessDir(), "worker-env.sh");
const SOURCE_FAILED = ` && [ -n "\${ORCH_GUARD_WORKER_ENV_ACTIVE:-}" ] || { echo "orchestrator-guard: worker env failed to source; command not run" >&2; exit 126; }; `;
export const workerEnvPrefix = (envFile: string) => `. "${envFile.replace(/[\\"$`]/g, "\\$&")}"${SOURCE_FAILED}`;
export const WORKER_ENV_PREFIX = new RegExp(String.raw`^\. "(?:[^"\\]|\\[\s\S])*"` + SOURCE_FAILED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
export const WORKER_ENV_NOTICE = "orchestrator-guard added the `. \".../worker-env.sh\" && [ ... ] || { ... }; ` prefix to this bash command, and adds it to every bash command you run: it loads the worker environment. You did not write it. Do not add, remove or mention it; report your commands and their output as you issued them.";
const isFile = (path: string): boolean => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

export function workerEnvProblem(envFile: string): string | undefined {
	if (!isAbsolute(envFile)) return `ORCH_GUARD_WORKER_ENV is not an absolute path (${envFile}), and the shell sources it from the worker's own working directory`;
	return isFile(envFile) ? undefined : `${envFile} is missing`;
}

const ENV_NAME = "worker-env.sh";
const STDIN_LIKE = /^(?:-|\/dev\/(?:stdin|fd\/\d+)|\/proc\/self\/fd\/\d+)$/;
const LIST_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "{"]);

function globRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		const close = c === "[" ? glob.indexOf("]", i + 2) : c === "{" ? glob.indexOf("}", i + 1) : -1;
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[" && close > 0) {
			re += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
			i = close;
		} else if (c === "{" && close > 0) {
			re += `(?:${glob.slice(i + 1, close).split(",").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
			i = close;
		} else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

const namesEnvFile = (word: string): boolean => {
	const name = basename(word);
	if (!/[*?[{]/.test(name)) return name === ENV_NAME;
	if (name.replace(/[*?[\]{},!^-]/g, "").length < 3) return false;
	try {
		return globRegex(name).test(ENV_NAME);
	} catch {
		return false;
	}
};
const mentionsEnvFile = (text: string): boolean => text.split(/[\s'"`()<>|&;=]+/).some(namesEnvFile);

function detached(s: string): string {
	let out = "";
	let listStart = 0;
	let atCommand = true;
	const take = (end: number, from: number) => {
		out += s.slice(from, end);
		return end;
	};
	for (let i = 0; i < s.length; ) {
		const c = s[i];
		const next = s[i + 1] ?? "";
		if (c === "\\") i = take(i + 2, i);
		else if (c === "'") i = take(s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1) + 1, i);
		else if (c === '"') {
			let end = i + 1;
			while (end < s.length && s[end] !== '"') end = s[end] === "\\" ? end + 2 : s[end] === "$" && s[end + 1] === "(" ? skipParen(s, end + 1) : s[end] === "`" ? skipBacktick(s, end) : end + 1;
			i = take(Math.min(end + 1, s.length), i);
			atCommand = false;
		} else if ((c === "$" || c === "<" || c === ">") && next === "(") {
			i = take(skipParen(s, i + 1), i);
			atCommand = false;
		} else if (c === "`") {
			i = take(skipBacktick(s, i), i);
			atCommand = false;
		} else if (c === "#" && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
			const end = s.indexOf("\n", i);
			i = take(end < 0 ? s.length : end, i);
		} else if (c === "(" && atCommand) {
			const end = skipParen(s, i);
			if (s[end - 1] !== ")") i = take(i + 1, i);
			else {
				out += ";";
				i = end;
			}
			atCommand = false;
		} else if (c === ";" || c === "\n") {
			i = take(i + 1, i);
			listStart = out.length;
			atCommand = true;
		} else if (c === "&" && next === "&") {
			i = take(i + 2, i);
			atCommand = true;
		} else if (c === "&" && (next === ">" || /[<>|]/.test(s[i - 1] ?? ""))) i = take(i + 1, i);
		else if (c === "&") {
			out = `${out.slice(0, listStart)};`;
			listStart = out.length;
			atCommand = true;
			i++;
		} else if (c === "|") {
			i = take(i + 1, i);
			atCommand = true;
		} else if (/\s/.test(c)) i = take(i + 1, i);
		else {
			const word = /^[^\s;&|()<>'"`$\\]+/.exec(s.slice(i))?.[0] ?? c;
			i = take(i + word.length, i);
			atCommand = atCommand && LIST_KEYWORDS.has(word);
		}
	}
	return out;
}

function forVariants(text: string): string[] {
	const variants: string[] = [];
	for (const m of text.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*)/g)) {
		for (const raw of m[2].split(/\s+/)) {
			const value = raw.replace(/^['"]|['"]$/g, "");
			if (value) variants.push(expandShellVars(text.replace(new RegExp(`\\$\\{?${m[1]}\\}?`, "g"), () => value)));
		}
	}
	return variants;
}

function loadsEnvFile(text: string, depth: number): boolean {
	return shellSegments(text).some(({ words }) => {
		const found = commandHead(words);
		const args = found?.args.map(a => a.text) ?? [];
		if (found?.name === "." || found?.name === "source") {
			const file = args.find(a => a !== "--");
			return file === undefined || STDIN_LIKE.test(file) ? mentionsEnvFile(text) : mentionsEnvFile(file);
		}
		if (found?.name !== "eval") return false;
		const code = args.join(" ");
		return sourcesWorkerEnv(code, depth + 1) || (/\$\(|`/.test(code) && mentionsEnvFile(code));
	});
}

/** Whether `command` reads a file named worker-env.sh (a glob matching it counts) into the shell that runs it: `.`, `source`, `eval` of its content, or `source` of stdin or `<( )` fed from it. Variables the guard expands, `for` lists and `eval` strings are followed; `( )` groups, commands run with `&` and child shells (`bash worker-env.sh`) are not, and a renamed copy is not recognised. */
export function sourcesWorkerEnv(command: string, depth = 0): boolean {
	if (depth > 4) return false;
	const flat = expandShellVars(detached(command));
	return [flat, ...forVariants(flat)].some(text => loadsEnvFile(text, depth));
}

/** The input of a worker bash call with the env file sourced before its command. Idempotent; the identity for an input without a command string. */
export function workerBashInput<T extends Record<string, unknown>>(input: T, envFile: string): T {
	const prefix = workerEnvPrefix(envFile);
	if (typeof input?.command !== "string" || input.command.startsWith(prefix)) return input;
	return { ...input, command: `${prefix}${input.command}` };
}
