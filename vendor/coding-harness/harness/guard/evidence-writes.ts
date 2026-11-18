import { basename, posix } from "node:path";
import { commandHead, expandShellVars, shellSegments, type Segment, type ShellWord } from "./shell.ts";

const MAX_DEPTH = 4;
const MANIFEST_PATH = /(?:^|\/)\.omp\/verify\/runs\/(?:.*\/)?manifest\.json$/i;
const EVIDENCE_SCRIPT = /(?:^|\/)evidence\.ts$/;
const WRITING_REDIRECTS = [">", ">>", ">|", "&>", "&>>", "<>"];
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true };
const ALL_OPERANDS_WRITTEN: Record<string, true> = { tee: true, truncate: true };
const LAST_OPERAND_WRITTEN: Record<string, true> = { cp: true, mv: true, install: true, rsync: true, ln: true };
const AST_EDIT_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };
const HEADER = /^\[(.+?)#[0-9A-Za-z]+\]\s*$/gm;
const MOVE_OP = /^MV\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/gm;

const REFUSED_FILE = (path: string): string =>
	`orchestrator-guard: "${path}"는 검증 증거의 manifest.json이라 막았어요. manifest는 verify 드라이버 스크립트(.omp/skills/verify-*/ 아래)가 마지막 단계에서만 만듭니다. 직접 쓰거나 고치면 증거가 아니라 주장이 돼요. 드라이버를 실행해(예: sh .omp/skills/verify-x/drive.sh <run-id>) 다시 만들고, 드라이버가 틀렸다면 그 스크립트를 고치세요.`;
const REFUSED_COMMAND = (what: string): string =>
	`orchestrator-guard: ${what}는 검증 증거의 manifest.json을 에이전트가 직접 만들게 되어 막았어요. manifest는 verify 드라이버 스크립트(.omp/skills/verify-*/ 아래)가 마지막 단계에서 \`evidence.ts manifest\`로 만듭니다. 드라이버를 실행하세요(예: sh .omp/skills/verify-x/drive.sh <run-id>). 읽기(cat, jq)는 그대로 됩니다.`;

const isManifest = (text: string): boolean => text !== "" && MANIFEST_PATH.test(posix.normalize(text));

function nestedCode(name: string, args: ShellWord[]): string | undefined {
	if (name === "eval") return args.map(arg => arg.text).join(" ");
	if (SHELLS[name] !== true) return undefined;
	const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg.text));
	return at < 0 ? undefined : args.slice(at + 1).find(arg => !arg.text.startsWith("-"))?.text;
}

function operandsOf(args: ShellWord[]): { operands: string[]; target?: string } {
	const operands: string[] = [];
	let target: string | undefined;
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const text = args[i].text;
		if (options && text === "--") options = false;
		else if (options && (text === "-t" || text === "--target-directory")) target = args[++i]?.text;
		else if (options && text.startsWith("--target-directory=")) target = text.slice("--target-directory=".length);
		else if (!options || !text.startsWith("-") || text === "-") operands.push(text);
	}
	return { operands, target };
}

function writtenPaths(name: string, args: ShellWord[]): string[] {
	const { operands, target } = operandsOf(args);
	if (name === "dd") return args.filter(arg => arg.text.startsWith("of=")).map(arg => arg.text.slice(3));
	if (name === "sed") return args.some(arg => /^-[A-Za-z]*i|^--in-place/.test(arg.text)) ? operands : [];
	if (ALL_OPERANDS_WRITTEN[name] === true) return operands;
	if (LAST_OPERAND_WRITTEN[name] !== true) return [];
	if (target === undefined) return operands.slice(-1);
	return operands.filter(source => basename(source) === "manifest.json").map(() => posix.join(target, "manifest.json"));
}

function segmentProblem(segment: Segment, depth: number): string | undefined {
	for (const redirect of segment.redirects) {
		if (redirect.operator !== undefined && WRITING_REDIRECTS.includes(redirect.operator) && isManifest(redirect.text)) return REFUSED_COMMAND(`"${redirect.operator} ${redirect.text}"`);
	}
	if (segment.words.some((word, i) => EVIDENCE_SCRIPT.test(word.text) && segment.words[i + 1]?.text === "manifest")) return REFUSED_COMMAND("`evidence.ts manifest`");
	const head = commandHead(segment.words);
	if (!head) return undefined;
	const written = writtenPaths(head.name, head.args).find(isManifest);
	if (written !== undefined) return REFUSED_COMMAND(`\`${head.name}\`가 쓰는 "${written}"`);
	const code = nestedCode(head.name, head.args);
	return code === undefined ? undefined : scanCommand(code, depth + 1);
}

function scanCommand(command: string, depth: number): string | undefined {
	if (depth > MAX_DEPTH) return undefined;
	for (const segment of shellSegments(expandShellVars(command))) {
		const found = segmentProblem(segment, depth);
		if (found) return found;
		for (const word of [...segment.words, ...segment.redirects]) {
			for (const sub of word.subs) {
				const nested = scanCommand(sub, depth + 1);
				if (nested) return nested;
			}
		}
	}
	return undefined;
}

function filePaths(input: Record<string, unknown>): string[] {
	const paths: string[] = [];
	for (const key of ["path", "file_path"]) if (typeof input[key] === "string") paths.push(input[key]);
	if (Array.isArray(input.paths)) for (const path of input.paths) if (typeof path === "string") paths.push(path);
	if (typeof input.input === "string") {
		for (const found of input.input.matchAll(HEADER)) paths.push(found[1]);
		for (const found of input.input.matchAll(MOVE_OP)) paths.push(found[1] ?? found[2] ?? found[3]);
	}
	return paths;
}

/**
 * The refusal message when a tool call writes a verify run's `manifest.json` (a `write`, `edit` or `ast_edit` of a path ending in
 * `.omp/verify/runs/<...>/manifest.json`; a bash segment that runs `evidence.ts manifest` or writes such a file by redirect, tee, cp, mv, install,
 * rsync, ln, dd, truncate or `sed -i`), otherwise undefined. Only a verify driver script writes manifests; running one, and reading a manifest, pass.
 */
export function evidenceWriteProblem(tool: string, input: unknown): string | undefined {
	const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const name = tool.toLowerCase();
	if (AST_EDIT_TOOLS[name] === true) {
		const path = filePaths(record).find(isManifest);
		return path === undefined ? undefined : REFUSED_FILE(path);
	}
	if (name !== "bash" || typeof record.command !== "string") return undefined;
	return scanCommand(record.command, 0);
}
