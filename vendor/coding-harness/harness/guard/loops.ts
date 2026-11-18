import { basename } from "node:path";
import { commandHead, shellSegments, type ShellWord } from "./shell.ts";

/** One finished bash call of a session: the command, its exit code, and the first error line of its output. */
export interface BashOutcome {
	command: string;
	exitCode: number;
	firstErrorLine: string;
}

const STREAK = 3;
const SHOWN_COMMAND = 120;
const SETUP_HEADS: Record<string, true> = { cd: true, export: true, set: true, unset: true, source: true, ".": true, true: true, ":": true, echo: true, pushd: true, popd: true };
const SUBCOMMAND_HEADS: Record<string, true> = { git: true, bun: true, npm: true };
const GIT_VALUE_OPTIONS: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true };
const TMP_PATH = /(?:\/private)?\/(?:tmp|var\/folders)(?:\/[^\s'"`:)\]}]*)?/g;
const HEX_ID = /\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g;
const DIGITS = /\d+/g;
const SPACES = /\s+/g;

const KEYWORDS: Record<string, true> = { then: true, do: true, else: true, elif: true, if: true, while: true, until: true, "{": true, "!": true, time: true };
const LOOP_OPENERS: Record<string, true> = { while: true, until: true, for: true };
const STATUS_READERS: Record<string, true> = { cat: true, tail: true, head: true, ls: true, ps: true, pgrep: true, grep: true, rg: true, wc: true, stat: true, echo: true, date: true, jobs: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function normalizeError(line: string): string {
	return line.replace(TMP_PATH, "<tmp>").replace(HEX_ID, "<hex>").replace(DIGITS, "<n>").replace(SPACES, " ").trim().toLowerCase();
}

function subcommand(name: string, args: ShellWord[]): string {
	if (SUBCOMMAND_HEADS[name] !== true) return "";
	for (let i = 0; i < args.length; i++) {
		const text = args[i].text;
		if (name === "git" && GIT_VALUE_OPTIONS[text] === true) i++;
		else if (!text.startsWith("-")) return ` ${text}`;
	}
	return "";
}

function headKey(command: string): string {
	let first: string | undefined;
	for (const segment of shellSegments(command)) {
		const found = commandHead(segment.words);
		if (found === undefined) continue;
		const key = `${found.name}${subcommand(found.name, found.args)}`;
		if (SETUP_HEADS[found.name] !== true) return key;
		first ??= key;
	}
	return first ?? "";
}

function failureKey(outcome: BashOutcome): string {
	return `${headKey(outcome.command)}\0${outcome.exitCode}\0${normalizeError(outcome.firstErrorLine)}`;
}

const shown = (command: string): string => {
	const flat = command.replace(SPACES, " ").trim();
	return flat.length > SHOWN_COMMAND ? `${flat.slice(0, SHOWN_COMMAND)}...` : flat;
};

/** Counts the trailing failures of `history` that share one key (head, exit code, normalized first error line). Three in a row give a notice to write the root cause; when `next` has the head of that streak, the fourth try is blocked. A success or a different key resets the streak. */
export function failureStreak(history: readonly BashOutcome[], next: string): { notice?: string; block?: string } {
	const last = history[history.length - 1];
	if (last === undefined || last.exitCode === 0) return {};
	const key = failureKey(last);
	let run = 1;
	while (run < history.length && history[history.length - 1 - run].exitCode !== 0 && failureKey(history[history.length - 1 - run]) === key) run++;
	if (run < STREAK) return {};
	const head = headKey(last.command);
	const what = `\`${shown(last.command)}\` (exit ${last.exitCode}, "${last.firstErrorLine.trim()}")`;
	if (headKey(next) === head) return { block: `같은 실패가 ${run}번 반복됐고 같은 명령(${head})을 또 실행하려 합니다: ${what}. 다시 시도하기 전에 근본 원인을 글로 적고, 원인에 맞는 다른 접근을 쓰세요.` };
	return { notice: `같은 실패가 ${run}번 연속 반복됐습니다: ${what}. 같은 시도를 멈추고 다시 시도하기 전에 근본 원인을 먼저 적으세요.` };
}

function leadingWord(words: ShellWord[]): { name: string; opener: string } | undefined {
	let i = 0;
	while (i < words.length && ASSIGNMENT.test(words[i].text)) i++;
	const opener = words[i] === undefined ? "" : basename(words[i].text);
	while (i < words.length && KEYWORDS[basename(words[i].text)] === true) i++;
	return words[i] === undefined ? undefined : { name: basename(words[i].text), opener };
}

/** The reason a main session may not run this bash command while jobs are running (a wait-by-sleep: `sleep N` alone or with a status read, or a loop that sleeps), or undefined when it is allowed. */
export function pollingProblem(command: string, runningJobs: number): string | undefined {
	if (runningJobs <= 0 || !command.includes("sleep")) return undefined;
	let sleeps = false;
	let loop = false;
	let others = false;
	for (const segment of shellSegments(command)) {
		const lead = leadingWord(segment.words);
		if (lead === undefined) continue;
		if (LOOP_OPENERS[lead.opener] === true) loop = true;
		if (lead.name === "sleep") sleeps = true;
		else if (STATUS_READERS[lead.name] !== true && lead.name !== "done" && lead.name !== "}") others = true;
	}
	if (!sleeps || (!loop && others)) return undefined;
	return `실행 중인 작업이 ${runningJobs}개 있는데 sleep으로 기다리며 상태를 확인하려 합니다: \`${shown(command)}\`. 폴링하지 말고 blocking wait 도구로 작업 결과를 기다리세요.`;
}
