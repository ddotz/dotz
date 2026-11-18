import { basename } from "node:path";
import { commandHead, shellSegments } from "./shell.ts";

const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };

const VALUE_OPTIONS: Record<string, readonly string[]> = {
	git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"],
	npm: ["--prefix", "-w", "--workspace", "--registry", "--userconfig", "--globalconfig", "--cache", "--loglevel", "--otp", "--tag", "--access", "--scope", "--before", "--omit", "--include"],
	pnpm: ["-C", "--dir", "-F", "--filter", "--filter-prod", "--workspace-concurrency", "--reporter", "--loglevel", "--registry", "--store-dir", "--lockfile-dir", "--modules-dir", "--virtual-store-dir", "--test-pattern", "--changed-files-ignore-pattern", "--use-node-version"],
	yarn: ["--cwd", "--registry", "--cache-folder", "--modules-folder", "--mutex", "--link-folder", "--global-folder", "--prefix", "--network-concurrency", "--network-timeout", "--proxy", "--https-proxy", "--otp", "--use-yarnrc", "--preferred-cache-folder"],
	bun: ["--cwd", "-c", "--config", "--env-file", "--filter", "-F", "--registry", "-p", "--port", "-r", "--preload", "--define", "-d", "--loader", "-l", "--tsconfig-override", "--bunfile", "--elide-lines"],
};
const valueOptionsOf = (name: string): readonly string[] | undefined => (Object.hasOwn(VALUE_OPTIONS, name) ? VALUE_OPTIONS[name] : undefined);
const MAX_OPTION_WALK = 64;

function verbIndex(words: readonly string[], from: number, valueOptions: readonly string[]): number {
	let i = from;
	for (let steps = 0; i < words.length && steps < MAX_OPTION_WALK; steps++) {
		const word = words[i];
		if (word === "--") return i + 1 < words.length ? i + 1 : -1;
		if (!word.startsWith("-") || word === "-") return i;
		i += valueOptions.includes(word) ? 2 : 1;
	}
	return -1;
}

function unwrapLauncher(name: string, args: string[]): string[] {
	if (["bunx", "npx", "pnpx"].includes(name)) return args.filter((a, i) => i > 0 || !a.startsWith("-"));
	const table = name === "git" ? undefined : valueOptionsOf(name);
	const at = table ? verbIndex(args, 0, table) : -1;
	if (at >= 0 && ["x", "exec", "dlx"].includes(args[at])) return args.slice(at + 1);
	return [name, ...args];
}

function verbFirst(words: string[]): string[] {
	const table = valueOptionsOf(words[0] ?? "");
	if (!table) return words;
	const at = verbIndex(words, 1, table);
	return at < 0 ? [words[0]] : [words[0], ...words.slice(at)];
}

const REMOTE_HOST = "remote host";
const WORD_SEPARATORS = /[\s'"`()[\]{};|&<>]+/;
const DEPLOY_WORD = /\b(?:deploy|publish)\b/;
const GH_VALUE_OPTIONS = ["-R", "--repo", "--hostname"];
const GH_API_VALUE_OPTIONS = ["-H", "--header", "-q", "--jq", "-t", "--template", "-p", "--preview", "--cache", "--hostname"];
const GH_REVIEW_VERBS = ["create", "merge", "edit", "close", "comment", "delete", "reopen"];
const GH_WRITE_VERBS: Record<string, readonly string[]> = {
	pr: GH_REVIEW_VERBS,
	issue: GH_REVIEW_VERBS,
	repo: GH_REVIEW_VERBS,
	release: [...GH_REVIEW_VERBS, "upload"],
	workflow: ["run"],
	secret: ["set"],
};
const SSH_VALUE_FLAGS = "BbcDEeFIiJLlmOopQRSWw";
const MAX_API_WALK = 256;
const CURL_IMAGE = /(?:^|\/)curl(?:[:@][^/]*)?$/i;

interface Facts {
	lastColon: number;
	lastDeploy: number;
}

function factsOf(tokens: readonly string[]): Facts {
	let lastColon = -1;
	let lastDeploy = -1;
	for (let i = tokens.length - 1; i >= 0 && (lastColon < 0 || lastDeploy < 0); i--) {
		if (lastColon < 0 && tokens[i].indexOf(":") > 0) lastColon = i;
		if (lastDeploy < 0 && DEPLOY_WORD.test(tokens[i])) lastDeploy = i;
	}
	return { lastColon, lastDeploy };
}

function yarnPublish(tokens: readonly string[], verb: number): boolean {
	let at = verb;
	for (let hop = 0; hop < 4 && at >= 0 && at < tokens.length; hop++) {
		const word = tokens[at];
		if (word === "publish") return true;
		if (word === "npm") return tokens[at + 1] === "publish";
		if (word === "workspaces") {
			if (tokens[at + 1] !== "foreach") return false;
			for (let i = at + 2; i < tokens.length && i < at + 2 + MAX_OPTION_WALK; i++) {
				if (tokens[i] === "run" || tokens[i] === "exec") return false;
				if (tokens[i] === "publish") return true;
			}
			return false;
		}
		if (word !== "workspace") return false;
		at = verbIndex(tokens, at + 2, VALUE_OPTIONS.yarn);
	}
	return false;
}

function commandName(word: string): string {
	return basename(word.startsWith("$") ? word.slice(1) : word);
}

function verbKindAt(tokens: readonly string[], at: number): string | undefined {
	const name = commandName(tokens[at]);
	const table = valueOptionsOf(name);
	if (!table && name !== "git-lfs") return undefined;
	const verb = table ? verbIndex(tokens, at + 1, table) : at + 1;
	if (verb < 0 || verb >= tokens.length) return undefined;
	const word = tokens[verb];
	if (name === "git") return word === "push" || word === "send-pack" || (word === "lfs" && tokens[verb + 1] === "push") ? "git push" : undefined;
	if (name === "git-lfs") return word === "push" ? "git push" : undefined;
	if (name === "yarn") return yarnPublish(tokens, verb) ? "package publish" : undefined;
	return word === "publish" ? "package publish" : undefined;
}

const GH_API_SHORT_VALUES = "fFXHqtp";

function ghApiWrites(tokens: readonly string[], from: number, live: ReadonlySet<string> | undefined): boolean {
	let method: string | undefined;
	const endpoints: string[] = [];
	let fields = false;
	let input = false;
	let queries = 0;
	let writingQuery = false;
	const field = (word: string, value: string | undefined) => {
		fields = true;
		if (!value?.startsWith("query=")) return;
		queries++;
		const text = value.slice(6).trimStart();
		if (!text.startsWith("query") || /mutation|\$\{|#\{/.test(text) || live === undefined || live.has(word)) writingQuery = true;
	};
	for (let i = from; i < tokens.length && i < from + MAX_API_WALK; i++) {
		const word = tokens[i];
		if (word === "--") {
			endpoints.push(...tokens.slice(i + 1));
			break;
		}
		if (word === "--method") method = tokens[++i];
		else if (word.startsWith("--method=")) method = word.slice(9);
		else if (word === "--input" || word.startsWith("--input=")) input = true;
		else if (word === "--field" || word === "--raw-field") {
			const value = tokens[++i];
			field(value ?? "", value);
		} else if (/^--(?:raw-)?field=/.test(word)) field(word, word.slice(word.indexOf("=") + 1));
		else if (GH_API_VALUE_OPTIONS.includes(word)) i++;
		else if (word.startsWith("--")) continue;
		else if (word.length > 1 && word.startsWith("-")) {
			const at = [...word.slice(1)].findIndex(flag => GH_API_SHORT_VALUES.includes(flag)) + 1;
			if (at === 0) continue;
			const rest = word.slice(at + 1).replace(/^=/, "");
			const owner = rest ? word : (tokens[i + 1] ?? "");
			const value = rest || tokens[++i];
			if (word[at] === "X") method = value;
			else if (word[at] === "f" || word[at] === "F") field(owner, value);
		} else endpoints.push(word);
	}
	if (input) return true;
	if (endpoints[0]?.replace(/^\//, "") === "graphql") return endpoints.length > 1 || (method !== undefined && !/^(GET|POST)$/i.test(method)) || queries === 0 || writingQuery;
	return (method !== undefined && WRITE_METHOD.test(method)) || (fields && method?.toUpperCase() !== "GET");
}

function ghKind(tokens: readonly string[], at: number, live: ReadonlySet<string> | undefined): string | undefined {
	const noun = verbIndex(tokens, at + 1, GH_VALUE_OPTIONS);
	if (noun < 0) return undefined;
	if (tokens[noun] === "api") return ghApiWrites(tokens, noun + 1, live) ? "gh api write" : undefined;
	if (!Object.hasOwn(GH_WRITE_VERBS, tokens[noun])) return undefined;
	const verb = verbIndex(tokens, noun + 1, GH_VALUE_OPTIONS);
	return verb >= 0 && GH_WRITE_VERBS[tokens[noun]].includes(tokens[verb]) ? "gh write" : undefined;
}

function sshKind(tokens: readonly string[], at: number): string | undefined {
	let i = at + 1;
	for (let steps = 0; i < tokens.length && steps < MAX_OPTION_WALK; steps++) {
		const word = tokens[i];
		if (word === "--") return i + 1 < tokens.length ? REMOTE_HOST : undefined;
		if (!word.startsWith("-") || word === "-") return REMOTE_HOST;
		let next = i + 1;
		for (let j = 1; j < word.length; j++) {
			if (word[j] === "G" || word[j] === "V") return undefined;
			if (!SSH_VALUE_FLAGS.includes(word[j])) continue;
			if (j + 1 === word.length) next = i + 2;
			break;
		}
		i = next;
	}
	return i < tokens.length ? REMOTE_HOST : undefined;
}

function commandKind(tokens: readonly string[], at: number, facts: Facts, live: ReadonlySet<string> | undefined): string | undefined {
	const name = commandName(tokens[at]);
	if (name === "gh") return ghKind(tokens, at, live);
	if (name === "ssh") return sshKind(tokens, at);
	if (name === "scp" || name === "rsync") return tokens[at + 1] !== "-V" && facts.lastColon > at ? REMOTE_HOST : undefined;
	if (/^wrangler\b/.test(name)) return facts.lastDeploy > at ? "wrangler deploy" : undefined;
	return /^agent-discord\b/.test(name) ? "message send" : undefined;
}

function goExecCommand(line: readonly string[]): string | undefined {
	if (line[0] !== "go" || (line[1] !== "test" && line[1] !== "run")) return undefined;
	for (let i = 2; i < line.length; i++) {
		const word = line[i];
		if (word === "-args" || word === "--args") return undefined;
		if (!word.startsWith("-")) continue;
		const flag = word.replace(/^--?/, "");
		if (flag === "exec") return line[i + 1];
		if (flag.startsWith("exec=")) return flag.slice(5);
	}
	return undefined;
}


const DATA_ONLY: Record<string, true> = { echo: true, printf: true, grep: true, egrep: true, fgrep: true, rg: true, ag: true, cat: true, head: true, tail: true, wc: true, sort: true, uniq: true, jq: true, less: true, ls: true };
const DATA_ONLY_GIT = /^(commit|log|show|grep|diff|status|tag|notes)$/;
function testRunner(line: string[]): boolean {
	const [name = "", verb = "", extra = ""] = line;
	if (/^(vitest|jest|pytest|py\.test|mocha)$/.test(name)) return true;
	if (/^(bun|npm|pnpm|yarn)$/.test(name)) return verb === "test" || (verb === "run" && extra === "test");
	if (/^(cargo|go|deno)$/.test(name)) return verb === "test" || verb === "nextest";
	return /^python3?$/.test(name) && verb === "-m" && /^(pytest|unittest)$/.test(extra);
}

const OUTBOUND_WRITE = "outbound HTTP write";
const CURL_VALUE_SHORT = "AbcCdDeEFHKmoPQrtTuUwxXyYz";
const CURL_WRITE_LONG = /^--(data(-[a-z]+)?|form(-string)?|json|upload-file)$/;
const CURL_VALUE_LONG: Record<string, true> = { "--header": true, "--request": true, "--config": true, "--output": true, "--user": true, "--user-agent": true, "--referer": true, "--cookie": true, "--cookie-jar": true, "--max-time": true, "--connect-timeout": true, "--retry": true, "--retry-delay": true, "--retry-max-time": true, "--write-out": true, "--range": true, "--cacert": true, "--capath": true, "--cert": true, "--key": true, "--resolve": true, "--connect-to": true, "--limit-rate": true, "--max-redirs": true, "--dump-header": true, "--output-dir": true, "--time-cond": true, "--proxy-header": true, "--oauth2-bearer": true, "--interface": true, "--unix-socket": true, "--noproxy": true, "--proto": true, "--url-query": true, "--variable": true };
const CURL_TARGET_LONG: Record<string, true> = { "--url": true, "--proxy": true, "--preproxy": true, "--proxy1.0": true, "--socks4": true, "--socks4a": true, "--socks5": true, "--socks5-hostname": true };
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const LOOPBACK_ADDRESS = /^(127(\.\d{1,3}){1,3}|0\.0\.0\.0|\[::1\]|\[0:0:0:0:0:0:0:1\])$/;

// why(spec): RFC 6761 section 6.3 reserves localhost and every name under .localhost for the loopback interface.
function isLoopback(host: string): boolean {
	const name = host.endsWith(".") ? host.slice(0, -1) : host;
	return name === "localhost" || name.endsWith(".localhost") || LOOPBACK_ADDRESS.test(name);
}

function urlHost(word: string): string | undefined {
	return /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^/?#@]*@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[^/?#]*)?(?:[/?#]|$)/.exec(word)?.[1].toLowerCase();
}

function curlOutbound(args: readonly string[], from: number): boolean {
	let writes = false;
	let unknown = false;
	const targets: string[] = [];
	for (let i = from; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			const takes = CURL_WRITE_LONG.test(name) || CURL_VALUE_LONG[name] === true || CURL_TARGET_LONG[name] === true;
			const value = eq >= 0 ? arg.slice(eq + 1) : takes ? args[++i] : undefined;
			if (CURL_WRITE_LONG.test(name) || (name === "--request" && WRITE_METHOD.test(value ?? ""))) writes = true;
			if (CURL_TARGET_LONG[name] === true && value !== undefined) targets.push(value);
			if (name === "--config") unknown = true;
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				const flag = arg[j];
				if (!CURL_VALUE_SHORT.includes(flag)) continue;
				const value = arg.length > j + 1 ? arg.slice(j + 1) : args[++i];
				if ("dFT".includes(flag) || (flag === "X" && WRITE_METHOD.test(value ?? ""))) writes = true;
				if (flag === "x" && value !== undefined) targets.push(value);
				if (flag === "K") unknown = true;
				break;
			}
		} else targets.push(arg);
	}
	if (!writes) return false;
	if (unknown) return true;
	const hosts = targets.map(urlHost);
	return !targets.length || !hosts.every(host => host !== undefined && isLoopback(host));
}

function curlWord(word: string): boolean {
	return commandName(word).toLowerCase() === "curl";
}

function indexWithin(tokens: readonly string[], from: number, test: (word: string) => boolean): number {
	for (let i = from; i < tokens.length && i < from + MAX_OPTION_WALK; i++) if (test(tokens[i])) return i;
	return -1;
}

function launcherArgsAt(tokens: readonly string[], at: number): number {
	const name = commandName(tokens[at]);
	const container = name === "docker" || name === "podman" || name === "nerdctl";
	if (!container && name !== "nix") return -1;
	const run = indexWithin(tokens, at + 1, word => word === "run");
	const target = run < 0 ? -1 : indexWithin(tokens, run + 1, word => (container ? CURL_IMAGE.test(word) : word.endsWith("#curl")));
	return target < 0 ? -1 : target + 1;
}

function exactKind(line: string[], live: ReadonlySet<string>): string | undefined {
	if (line.length === 0) return undefined;
	const found = verbKindAt(line, 0) ?? commandKind(line, 0, factsOf(line), live);
	if (found) return found;
	const from = curlWord(line[0]) ? 1 : launcherArgsAt(line, 0);
	return from >= 0 && curlOutbound(line, from) ? OUTBOUND_WRITE : undefined;
}

function looseKind(words: string[], redirects: string[], live: ReadonlySet<string>, depth: number, inline: CodeCheck): string | undefined {
	const parts = [...words, ...redirects];
	const split: string[] = [];
	const origin: number[] = [];
	parts.forEach((part, p) => {
		for (const word of part.split(WORD_SEPARATORS)) {
			if (word === "") continue;
			split.push(word);
			origin.push(p);
		}
	});
	for (const tokens of [parts, split]) {
		for (let at = 0; at < tokens.length; at++) {
			const verb = verbKindAt(tokens, at);
			if (verb) return verb;
		}
	}
	const facts = factsOf(split);
	for (let at = 0; at < split.length; at++) {
		const standaloneGh = commandName(split[at]) === "gh" && parts[origin[at]] === split[at];
		const kind = standaloneGh ? ghKind(parts, origin[at], live) : commandKind(split, at, facts, undefined);
		if (kind) return kind;
	}
	const first = words.findIndex(curlWord);
	if (first >= 0 && curlOutbound(words, first + 1)) return OUTBOUND_WRITE;
	for (let at = 0; at < words.length; at++) {
		const from = launcherArgsAt(words, at);
		if (from < 0) continue;
		if (curlOutbound(words, from)) return OUTBOUND_WRITE;
		break;
	}
	for (const word of parts) {
		if (!/\s/.test(word) || !/\bcurl\b/i.test(word)) continue;
		const kind = scanCommand(word, depth + 1, true, inline);
		if (kind) return kind;
	}
	return undefined;
}

/** Reads a script for the external action it performs: given the code of an interpreter one-liner, its nesting depth and whether it is JavaScript. */
export type CodeCheck = (code: string, depth: number, js: boolean) => string | undefined;

interface InlineFlags {
	code: string;
	print: string;
	booleans: string;
	values: string;
	attached: string;
	stop: string;
	long: readonly string[];
	longPrint: readonly string[];
	longValues: readonly string[];
	positional: boolean;
	codeEndsOptions: boolean;
	js: boolean;
}

const inlineFlags = (flags: Partial<InlineFlags>): InlineFlags => ({ code: "", print: "", booleans: "", values: "", attached: "", stop: "", long: [], longPrint: [], longValues: [], positional: false, codeEndsOptions: false, js: false, ...flags });
const JS_EVAL = { code: "e", print: "p", long: ["--eval"], longPrint: ["--print"], js: true };
// why(vendor): option grammars per python3(1) of python@3.15.2, node(1) of node@26.13.0, perlrun(1) of perl@5.34.1, ruby(1) of ruby@4.0.9, https://bun.sh/docs/cli/run and https://docs.deno.com/runtime/reference/cli/eval/.
const INLINE: [RegExp, InlineFlags][] = [
	[/^python[0-9.]*$/, inlineFlags({ code: "c", booleans: "bBdEhiIOPqRsSuvx", values: "WX", stop: "m", codeEndsOptions: true })],
	[/^(?:node|nodejs)$/, inlineFlags({ ...JS_EVAL, values: "rC", longValues: ["--require", "--import", "--conditions", "--loader", "--experimental-loader", "--title", "--input-type"] })],
	[/^bun$/, inlineFlags({ ...JS_EVAL, values: "rc", longValues: ["--preload", "--config", "--cwd", "--env-file", "--tsconfig-override"] })],
	[/^perl[0-9.]*$/, inlineFlags({ code: "eE", booleans: "acnpsTtuUvwWXl0123456789", values: "I", attached: "MmiFxdDC" })],
	[/^ruby[0-9.]*$/, inlineFlags({ code: "e", booleans: "acdlnpsSvwWy0123456789", values: "IrCE", attached: "FxiK" })],
];
const DENO_EVAL = inlineFlags({ values: "c", longValues: ["--ext", "--config", "--import-map", "--location", "--cert"], positional: true, js: true });

function inlineCode(name: string, args: readonly string[]): { codes: string[]; js: boolean } {
	const command = name === "deno" ? args.findIndex(word => !word.startsWith("-")) : -1;
	const deno = command >= 0 && args[command] === "eval";
	const flags = deno ? DENO_EVAL : INLINE.find(([pattern]) => pattern.test(name))?.[1];
	const codes: string[] = [];
	if (!flags) return { codes, js: false };
	const take = (code: string | undefined) => {
		if (code !== undefined) codes.push(code);
	};
	const optional = (next: string | undefined) => (next !== undefined && !next.startsWith("-") ? next : undefined);
	let unknownBefore = false;
	walk: for (let i = deno ? command + 1 : 0; i < args.length && i < MAX_OPTION_WALK; i++) {
		const word = args[i];
		const unknown = unknownBefore;
		unknownBefore = false;
		if (word === "--" || word === "-" || !word.startsWith("-")) {
			if (flags.positional) take(word === "--" ? args[i + 1] : word);
			if (unknown && word !== "--" && word !== "-") continue;
			break;
		}
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const option = eq < 0 ? word : word.slice(0, eq);
			if (flags.long.includes(option)) take(eq < 0 ? args[++i] : word.slice(eq + 1));
			else if (flags.longPrint.includes(option)) {
				const code = eq < 0 ? optional(args[i + 1]) : word.slice(eq + 1);
				if (eq < 0 && code !== undefined) i++;
				take(code);
			} else if (eq < 0 && flags.longValues.includes(option)) i++;
			else unknownBefore = eq < 0;
			continue;
		}
		unknownBefore = false;
		for (let j = 1; j < word.length; j++) {
			const flag = word[j];
			const rest = word.slice(j + 1);
			unknownBefore = !flags.booleans.includes(flag);
			if (flags.stop.includes(flag)) break walk;
			if (flags.print.includes(flag)) {
				if (rest !== "") continue;
				const code = optional(args[i + 1]);
				if (code !== undefined) i++;
				take(code);
			} else if (flags.code.includes(flag)) {
				take(rest === "" ? args[++i] : rest);
				if (flags.codeEndsOptions) break walk;
			} else if (flags.values.includes(flag)) {
				if (rest === "") i++;
			} else if (!flags.attached.includes(flag)) continue;
			unknownBefore = false;
			break;
		}
	}
	return { codes, js: flags.js };
}

function opaqueRunner(name: string, args: string[]): boolean {
	if (SHELLS[name] === true) return !args.some(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
	if (name === "find" || name === "fd" || name === "fdfind") return args.some(a => /^-(exec|execdir|ok|okdir|x|X)$|^--exec(-batch)?$/.test(a));
	if (/^(python3?|node|perl|ruby|bun|deno|osascript)$/.test(name)) return args.some(a => /^-[A-Za-z]*[ce]$|^--eval$/.test(a));
	return name === "source" || name === ".";
}

/**
 * Kind of external-impact action in `command`, or undefined. Each simple command is checked at its command word (after env
 * assignments, wrappers and package-runner launchers), so a quoted mention (`echo "git push"`, commit messages) passes; `bash -c`,
 * `eval`, `$(...)`, backticks and `go test -exec` are checked recursively, and the code of an interpreter one-liner
 * (`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `bun -e`, `deno eval`) goes to `inline`. With `loose`, every segment is also searched for the
 * same commands anywhere in its words, and a hit passes only when the segment's command word is a known data-only command (echo,
 * grep, git commit, a test runner) AND no segment of the command executes text this parser cannot see (a shell reading stdin or a
 * script, find -exec, interpreter one-liners, source). Unknown wrappers with option values (`sudo -u deploy git push`,
 * `timeout -s KILL 60 git push`, `xargs -I {} git push`) therefore block without being listed.
 * `bunx wrangler deploy`, `npx wrangler`, `bun x`, `pnpm dlx` and `npm exec` launch a tool, which is the command; `git -C dir push` and `git -c k=v push` are still a push.
 * Test runners take test names and filters as arguments (`bun test -t "git push is blocked"`): data, like echo's arguments.
 * curl sends data, and so counts as an outbound write, with -d/--data*, -F/--form*, -T/--upload-file, --json or -X/--request POST|PUT|PATCH|DELETE, alone or inside a combined short flag (`-sd`, `-sX POST`, `-sF`).
 * It is exempt only when every target URL has a loopback host (`http://user@host:8080/p`, `host:8080/p`, `[::1]/p`): `localhost` in the query or user part of another URL is no exemption.
 * Options that take a value consume the next word (or the rest of the cluster), so `-H 'A: b'` and `-d @file` are never read as targets.
 */
export function scanCommand(command: string, depth: number, loose: boolean, inline: CodeCheck): string | undefined {
	if (depth > 4) return "nested shell too deep to check";
	const segments = shellSegments(command);
	const heads = segments.map(segment => commandHead(segment.words));
	const opaque = heads.some(found => found !== undefined && opaqueRunner(found.name, found.args.map(a => a.text)));
	for (const [i, { words, redirects }] of segments.entries()) {
		for (const word of [...words, ...redirects]) for (const inner of word.subs) {
			const kind = scanCommand(inner, depth + 1, loose, inline);
			if (kind) return kind;
		}
		const found = heads[i];
		if (!found) continue;
		const args = found.args.map(a => a.text);
		const live = new Set([...words, ...redirects].filter(w => w.live).map(w => w.text));
		if (SHELLS[found.name] === true) {
			const flag = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
			const kind = flag >= 0 && args[flag + 1] !== undefined ? scanCommand(args[flag + 1], depth + 1, loose, inline) : undefined;
			if (kind) return kind;
		}
		if (found.name === "eval") {
			const kind = scanCommand(args.join(" "), depth + 1, loose, inline);
			if (kind) return kind;
		}
		const interpreters = DATA_ONLY[found.name] === true ? [] : [found.name, ...args.slice(0, MAX_OPTION_WALK).map(word => basename(word))];
		for (const [at, name] of interpreters.entries()) {
			const inlined = inlineCode(name, args.slice(at));
			for (const code of inlined.codes) {
				const kind = inline(code, depth + 1, inlined.js);
				if (kind) return kind;
			}
		}
		const line = verbFirst(unwrapLauncher(found.name, args));
		const goExec = goExecCommand(line);
		if (goExec !== undefined) {
			const kind = scanCommand(goExec, depth + 1, loose, inline);
			if (kind) return kind;
		}
		const exact = exactKind(line, live);
		if (exact) return exact;
		if (!loose) continue;
		const mention = looseKind(words.map(w => w.text), redirects.map(w => w.text), live, depth, inline);
		const dataOnly = DATA_ONLY[found.name] === true || (line[0] === "git" && DATA_ONLY_GIT.test(line[1] ?? "")) || testRunner(line);
		if (mention && (opaque || !dataOnly)) return mention;
	}
	return undefined;
}
