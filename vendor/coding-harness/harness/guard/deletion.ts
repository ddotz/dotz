import { basename, posix } from "node:path";
import { commandHead, expandShellVars, shellSegments, type Segment, type ShellWord } from "./shell.ts";

interface Protected {
	rel: string;
	tree: boolean;
	prefix?: boolean;
}

const PROTECTED: readonly Protected[] = [
	{ rel: ".ssh", tree: true },
	{ rel: ".gitconfig", tree: false },
	{ rel: ".zshrc", tree: false },
	{ rel: ".zprofile", tree: false },
	{ rel: ".bashrc", tree: false },
	{ rel: ".bash_profile", tree: false },
	{ rel: ".profile", tree: false },
	{ rel: ".config", tree: false },
	{ rel: ".config/git", tree: true },
	{ rel: ".config/gh", tree: true },
	{ rel: ".config/omp", tree: true },
	{ rel: ".codex", tree: true },
	{ rel: ".omo", tree: true },
	{ rel: ".claude", tree: true },
	{ rel: ".aside", tree: true },
	{ rel: ".bun", tree: true },
	{ rel: ".cargo", tree: true },
	{ rel: "Pictures/Photos Library.photoslibrary", tree: true },
	{ rel: "Library/Mail", tree: true },
	{ rel: "Library/Mobile Documents", tree: true },
	{ rel: ".omp/agent", tree: false },
	{ rel: ".omp/agent/agent.db", tree: false, prefix: true },
	{ rel: ".omp/agent/sessions", tree: true },
];

const MAX_DEPTH = 4;
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
const REMOVERS: Record<string, true> = { rm: true, rmdir: true, unlink: true, shred: true, trash: true, "trash-put": true };
const TRUNCATING = [">", ">|", "&>"];
const GLOB_CHARS = /[*?[]/;
const HOME_FORMS = [/^~(?=\/|$)/, /^\$HOME(?=\/|$)/, /^\$\{HOME\}(?=\/|$)/];

const REFUSED_PROTECTED = (verb: string, text: string, rel: string): string =>
	`orchestrator-guard: \`${verb}\`가 보호 경로 "${text}"(~/${rel})를 지우거나 옮기거나 덮어쓰게 되어 막았어요. 이 보호 목록은 오너가 정한 규칙(2026-10-12)이라 에이전트가 풀 수 없습니다. 지우려는 대상이 이 목록과 무관하면 그 정확한 경로만 하나씩 적어 다시 실행하세요. 보호 대상 자체를 바꿔야 하면 오너에게 직접 요청하세요.`;
const REFUSED_GLOB = (text: string): string =>
	`orchestrator-guard: 재귀 삭제 대상 "${text}"는 glob(공통 접두사)이라 막았어요. 다른 세션이나 사용자의 파일까지 함께 지워질 수 있습니다. 이 세션이 만든 정확한 경로를 나열해(예: rm -rf /tmp/dz-1234 /tmp/dz-1235) 다시 실행하세요.`;

const hasGlob = (text: string): boolean => GLOB_CHARS.test(text);

function resolveWord(text: string, cwd: string | undefined, home: string): string | undefined {
	let value = text;
	for (const form of HOME_FORMS) {
		const found = form.exec(value);
		if (found) {
			value = home + value.slice(found[0].length);
			break;
		}
	}
	if (value.includes("$") || value.includes("`")) return undefined;
	if (value.startsWith("/")) return posix.resolve(value);
	return cwd === undefined ? undefined : posix.resolve(cwd, value);
}

function globRegex(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else if (c === "[") {
			const close = pattern.indexOf("]", i + 2);
			source += close < 0 ? "\\[" : "[^/]";
			if (close >= 0) i = close;
		} else source += c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "i");
}

function segmentMatches(pattern: string, name: string): boolean {
	if (!hasGlob(pattern)) return pattern.toLowerCase() === name.toLowerCase();
	if (name.startsWith(".") && !pattern.startsWith(".")) return false;
	return globRegex(pattern).test(name);
}

function hits(target: string[], protectedPath: string[], entry: Protected): boolean {
	const shared = Math.min(target.length, protectedPath.length);
	for (let i = 0; i < shared; i++) {
		const last = i === protectedPath.length - 1 && target.length === protectedPath.length;
		if (last && entry.prefix === true && target[i].toLowerCase().startsWith(protectedPath[i].toLowerCase())) continue;
		if (!segmentMatches(target[i], protectedPath[i])) return false;
	}
	return target.length <= protectedPath.length || entry.tree;
}

function protectedEntry(absolute: string, home: string): Protected | undefined {
	const target = absolute.split("/").filter(part => part !== "");
	return PROTECTED.find(entry => hits(target, [...home.split("/").filter(part => part !== ""), ...entry.rel.split("/")], entry));
}

const operandsOf = (args: ShellWord[]): string[] => {
	const operands: string[] = [];
	let options = true;
	for (const { text } of args) {
		if (options && text === "--") options = false;
		else if (!options || !text.startsWith("-") || text === "-") operands.push(text);
	}
	return operands;
};

const flagsOf = (args: ShellWord[]): string[] => {
	const flags: string[] = [];
	for (const { text } of args) {
		if (text === "--") break;
		if (text.startsWith("-") && text !== "-") flags.push(text);
	}
	return flags;
};

function mvSources(args: ShellWord[]): string[] {
	const operands: string[] = [];
	let toDirectory = false;
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const text = args[i].text;
		if (options && text === "--") options = false;
		else if (options && (text === "-t" || text === "--target-directory")) {
			toDirectory = true;
			i++;
		} else if (options && text.startsWith("--target-directory=")) toDirectory = true;
		else if (!options || !text.startsWith("-") || text === "-") operands.push(text);
	}
	return toDirectory ? operands : operands.slice(0, -1);
}

function findRoots(args: ShellWord[]): string[] {
	const roots: string[] = [];
	let i = 0;
	while (i < args.length && /^-[HLPEXxsd]+$|^-O\d$/.test(args[i].text)) i++;
	for (; i < args.length; i++) {
		const text = args[i].text;
		if (text.startsWith("-") || text === "(" || text === "!" || text === ",") break;
		roots.push(text);
	}
	return roots.length === 0 ? ["."] : roots;
}

function findDeletes(args: ShellWord[]): boolean {
	return args.some((arg, i) => arg.text === "-delete" || (/^-(?:exec|execdir|ok|okdir)$/.test(arg.text) && REMOVERS[basename(args[i + 1]?.text ?? "")] === true));
}

interface Scan {
	cwd: string | undefined;
	others: (string | undefined)[];
	uncertain: boolean;
	home: string;
	depth: number;
}

const MAX_BRACE_WORDS = 1024;
const SCOPED_CD = /\(|\||(?<![&>])&(?![&>])/;
const SCRATCH_GLOB = /^\/(?:private\/)?tmp\/scratch-[^/]*$/;
const VERIFY_RUNS_GLOB = /^(?:[^*?[]*\/)?\.omp\/verify\/runs\/[^/]+\/?$/;

function braceParts(body: string): string[] | undefined {
	const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body) ?? /^([A-Za-z])\.\.([A-Za-z])$/.exec(body);
	if (!range) return undefined;
	const numeric = /^-?\d+$/.test(range[1]);
	const from = numeric ? Number(range[1]) : range[1].charCodeAt(0);
	const to = numeric ? Number(range[2]) : range[2].charCodeAt(0);
	const step = from <= to ? 1 : -1;
	const parts: string[] = [];
	for (let at = from; parts.length <= MAX_BRACE_WORDS; at += step) {
		parts.push(numeric ? String(at) : String.fromCharCode(at));
		if (at === to) break;
	}
	return parts;
}

function braceGroup(text: string): { open: number; close: number; parts: string[] } | undefined {
	for (let open = text.indexOf("{"); open >= 0; open = text.indexOf("{", open + 1)) {
		if (text[open - 1] === "$") continue;
		const cuts = [open];
		let depth = 0;
		for (let i = open + 1; i < text.length; i++) {
			if (text[i] === "{") depth++;
			else if (text[i] === "," && depth === 0) cuts.push(i);
			else if (text[i] === "}" && depth > 0) depth--;
			else if (text[i] === "}") {
				cuts.push(i);
				const parts = cuts.slice(1).map((cut, at) => text.slice(cuts[at] + 1, cut));
				const expanded = parts.length > 1 ? parts : braceParts(parts[0]);
				if (expanded) return { open, close: i, parts: expanded };
				break;
			}
		}
	}
	return undefined;
}

function expandBraces(text: string, budget = { left: MAX_BRACE_WORDS }): string[] | undefined {
	const group = braceGroup(text);
	if (!group) return [text];
	const words: string[] = [];
	for (const part of group.parts) {
		const rest = expandBraces(text.slice(0, group.open) + part + text.slice(group.close + 1), budget);
		budget.left -= rest?.length ?? Infinity;
		if (!rest || budget.left < 0) return undefined;
		words.push(...rest);
	}
	return words;
}

const sessionPatch = (absolute: string, home: string): boolean => absolute.startsWith(`${home}/.omp/agent/sessions/`) && absolute.endsWith(".patch");

function protectedTargets(verb: string, texts: string[], scan: Scan, patchesOk = false): string | undefined {
	for (const text of texts) {
		const variants = expandBraces(text);
		if (variants === undefined) return REFUSED_GLOB(text);
		for (const variant of variants) {
			for (const cwd of [scan.cwd, ...scan.others]) {
				const absolute = resolveWord(variant, cwd, scan.home);
				if (absolute === undefined || (patchesOk && sessionPatch(absolute, scan.home))) continue;
				const entry = protectedEntry(absolute, scan.home);
				if (entry) return REFUSED_PROTECTED(verb, text, entry.rel);
			}
		}
	}
	return undefined;
}

function globAllowed(variant: string, scan: Scan): boolean {
	const absolute = resolveWord(variant, scan.cwd, scan.home);
	if (absolute !== undefined && (SCRATCH_GLOB.test(absolute) || sessionPatch(absolute, scan.home))) return true;
	return VERIFY_RUNS_GLOB.test(posix.normalize(variant));
}

function removalProblem(name: string, args: ShellWord[], scan: Scan): string | undefined {
	const operands = operandsOf(args);
	const found = protectedTargets(name, operands, scan, name === "rm" || name === "unlink");
	if (found || name !== "rm" || !flagsOf(args).some(flag => (flag.startsWith("--") ? flag === "--recursive" : /[rR]/.test(flag)))) return found;
	for (const text of operands) {
		const glob = expandBraces(text)?.find(variant => variant.split("/").some(hasGlob) && !globAllowed(variant, scan));
		if (glob !== undefined) return REFUSED_GLOB(glob);
	}
	return undefined;
}

function changeDirectory(args: ShellWord[], scan: Scan): void {
	const target = operandsOf(args)[0];
	if (scan.uncertain) scan.others = [...scan.others, scan.cwd];
	scan.cwd = target === undefined ? scan.home : target === "-" ? undefined : resolveWord(target, scan.cwd, scan.home);
}

function nestedCode(name: string, args: ShellWord[]): string | undefined {
	if (name === "eval") return args.map(arg => arg.text).join(" ");
	if (SHELLS[name] !== true) return undefined;
	const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg.text));
	return at < 0 ? undefined : args.slice(at + 1).find(arg => !arg.text.startsWith("-"))?.text;
}

function segmentProblem(segment: Segment, scan: Scan): string | undefined {
	for (const redirect of segment.redirects) {
		if (redirect.operator === undefined || !TRUNCATING.includes(redirect.operator)) continue;
		const found = protectedTargets(">", [redirect.text], scan);
		if (found) return found;
	}
	const head = commandHead(segment.words);
	if (!head) return undefined;
	const { name, args } = head;
	if (name === "cd" || name === "pushd") changeDirectory(args, scan);
	else if (name === "popd") scan.cwd = undefined;
	else if (REMOVERS[name] === true) return removalProblem(name, args, scan);
	else if (name === "mv") return protectedTargets("mv", mvSources(args), scan);
	else if (name === "find" && findDeletes(args)) return protectedTargets("find -delete", findRoots(args), scan);
	const code = nestedCode(name, args);
	return code === undefined ? undefined : scanCommand(code, { ...scan });
}

function scanCommand(command: string, scan: Scan): string | undefined {
	if (scan.depth > MAX_DEPTH) return undefined;
	if (SCOPED_CD.test(command)) scan.uncertain = true;
	const inner: Scan = { ...scan, depth: scan.depth + 1 };
	for (const segment of shellSegments(expandShellVars(command))) {
		const found = segmentProblem(segment, scan);
		if (found) return found;
		for (const word of [...segment.words, ...segment.redirects]) {
			for (const sub of word.subs) {
				const nested = scanCommand(sub, { ...inner });
				if (nested) return nested;
			}
		}
	}
	return undefined;
}

/**
 * The refusal message when a bash command deletes, moves away, truncates or overwrites an owner-protected path (rm, rmdir, unlink, shred,
 * trash, mv as source, `find -delete`, `>` redirection) or removes recursively by a glob, otherwise undefined. `~`, `$HOME`, `${HOME}`,
 * relative paths (after `cd`) and `..` are resolved; a command this rule cannot read (an `eval` of a variable, a script file) is not refused.
 */
export function deletionProblem(command: string, cwd: string, home: string): string | undefined {
	return scanCommand(command, { cwd: posix.resolve(cwd), others: [], uncertain: false, home: posix.resolve(home), depth: 0 });
}
