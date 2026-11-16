// An agent session never sends a mail, comment reply or KakaoTalk reply itself: only the owner's 보내기 on the draft card sends, through the
// gateway's queue (hub/approval-send.ts runCli spawns the same CLIs from the gateway process, outside any agent tool call, so this guard never
// sees them). A prompt line was no guard: the model judged "the owner picked 보내기" itself and sent raw with zele (reply-flow audit 1.3, P8).
// Reads, drafts and revises stay open.
// Not caught (a shell guard reads the words it is given, not what they become): a command held in a variable and run later
// (`c="zele mail send"; $c`), code decoded and piped to a shell (`base64 -d | sh`), a script written to a file and run (`python3 send.py`),
// strings built at run time ('se'+'nd'). These still meet the owner's gate: the draft CLIs and the hub refuse a send without his pick on the
// card; the raw mailer (zele) has none, which is why every cheap form of it is refused here (docs/ARCHITECTURE.md, extension). Kept out of the agent's prompt on purpose.
import { basename } from "node:path";
import { commandStart, shellSegments, type ShellWord } from "./guard-shell.ts";

const REFUSAL = "Blocked by dotz: an agent never sends a reply itself (%s). Only the owner's 보내기 on the draft card sends it, through the gateway. Leave the card to the owner: make the draft (draft.ts new, mail-cli.ts compose, comments.ts draft, kakao cli.ts draft) and post its block, and ask for a change only with one line `[revise <ref>] <change>` or `draft.ts revise`. If the owner's words mean to send it, write one line `[send <ref>]`: that only puts a confirm card up for his button.";

const ZELE_SENDS = new Set(["send", "reply", "forward"]);
// The CLIs whose `send` subcommand sends a draft (each still checks the owner's pick; the agent must not be the one calling it).
const SEND_SCRIPTS: [RegExp, string][] = [
	[/(^|\/)draft\.ts$/, "draft.ts send"],
	[/(^|\/)mail-cli\.ts$/, "mail-cli.ts send"],
	[/(^|\/)comments\.ts$/, "comments.ts send"],
	[/(^|\/)kakao\/cli\.ts$/, "kakao cli.ts send"],
];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
// Words that open a group or a clause before the command they run (`{ zele mail send; }`, `if true; then zele ...`).
const LEADS = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until"]);
// find's actions that run a command per file: the command runs up to `;` or `+`.
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// Package runners that start a CLI by name (bunx zele …, npx zele@latest …): the command is the first word after their flags.
const RUNNERS = new Set(["bunx", "npx", "pnpx"]);
// Interpreters whose inline code is checked like an eval cell (python3 -c "…", node -e "…").
const INTERPRETERS = /^(python[0-9.]*|node|bun|deno|ruby|perl)$/;
const INLINE_FLAG = /^(-c|-e|-E|--eval|-p|--print)$/;
const REPLY_ACT = "/api/reply/act";
// A reply act that can send: everything but revise is the owner's (the hub answers an agent's send 403 too; this stops the attempt).
const SENDING_ACT = /["']?action["']?\s*[:=]\s*\\?["']?(send|retry|resolve)\b/;
// A card's answer (POST /api/notices/<id>/answer) is the owner's word too: on a draft's card only 고치기 is the agent's (the hub answers 403 for
// the rest). A 보내기-family or 보내지 않기 label sends or drops; an answer with no label cannot be told apart, so it is refused as well.
const NOTICE_ANSWER = /\/api\/notices\/[^/\s"'`]+\/answer/;
const SENDING_PICK = /["']?label["']?\s*[:=]\s*\\?["'][^"'\\]*(보내|직접 입력)/;
const LABELLED = /["']?label["']?\s*[:=]/;

// Code that makes an HTTP call (a cell that only names the route, in a search pattern or a test, sends nothing).
const HTTP_CALL = /\b(fetch|urlopen|post|request)\s*\(/i;

/** What a call to the hub posts that sends or drops a reply, or undefined. `fromFile`: its body is read from a file, so it cannot be checked. */
function postSends(text: string, fromFile: boolean, calls = true): string | undefined {
	if (text.includes(REPLY_ACT) && (fromFile || SENDING_ACT.test(text))) return `a ${REPLY_ACT} call that sends`;
	if (calls && NOTICE_ANSWER.test(text) && (fromFile || SENDING_PICK.test(text) || !LABELLED.test(text))) return "a card answer that sends or drops a draft";
	return undefined;
}

function segmentSend(words: ShellWord[], depth: number): string | undefined {
	const start = commandStart(words);
	const head = words[start];
	if (!head) return undefined;
	const name = basename(head.text);
	const args = words.slice(start + 1).map(w => w.text);
	if (LEADS.has(head.text)) return segmentSend(words.slice(start + 1), depth + 1);
	if (name === "find") {
		const at = args.findIndex(a => FIND_RUNS.has(a));
		if (at < 0) return undefined;
		const run = words.slice(start + 2 + at);
		const end = run.findIndex(w => w.text === ";" || w.text === "+");
		return segmentSend(end < 0 ? run : run.slice(0, end), depth + 1);
	}
	// A mailer named through a variable (`Z=zele; $Z mail send`): its mail subcommand is read as zele's.
	if ((head.expands || head.text.startsWith("$")) && args[0] === "mail" && args[1] && ZELE_SENDS.has(args[1])) return `zele mail ${args[1]} through a variable`;
	if (SHELLS.has(name)) {
		const flag = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
		const inner = name === "eval" ? args.join(" ") : flag >= 0 ? args[flag + 1] : undefined;
		return inner === undefined ? undefined : commandSend(inner, depth + 1);
	}
	const viaRunner = RUNNERS.has(name) ? 0 : (name === "bun" && args[0] === "x") || (name === "pnpm" && args[0] === "dlx") ? 1 : -1;
	if (viaRunner >= 0) {
		const rest = words.slice(start + 1 + viaRunner);
		const at = rest.findIndex(w => !w.text.startsWith("-"));
		return at < 0 ? undefined : segmentSend([{ ...rest[at]!, text: rest[at]!.text.replace(/(.)@[^/@]*$/, "$1") }, ...rest.slice(at + 1)], depth + 1);
	}
	if (INTERPRETERS.test(name)) {
		const flag = args.findIndex(a => INLINE_FLAG.test(a));
		const code = flag >= 0 ? args[flag + 1] : name === "deno" && args[0] === "eval" ? args[1] : undefined;
		if (code !== undefined) return cellSend(code);
	}
	if (name === "zele") {
		const mail = args.indexOf("mail");
		const sub = mail < 0 ? undefined : args.slice(mail + 1).find(a => !a.startsWith("-"));
		return sub && ZELE_SENDS.has(sub) ? `zele mail ${sub}` : undefined;
	}
	if (name === "curl" || name === "wget") return postSends(args.join(" "), args.some(a => a.startsWith("@") || /^--(post|body)-file\b/.test(a)));
	const line = [head.text, ...args];
	for (let i = 0; i < line.length - 1; i++) {
		const hit = SEND_SCRIPTS.find(([re]) => re.test(line[i]));
		if (hit) return line[i + 1] === "send" ? hit[1] : undefined;
	}
	return undefined;
}

// A shell command line: every simple command of it, and every $(...) or backtick substitution inside a word.
function commandSend(command: string, depth = 0): string | undefined {
	if (depth > 4) return undefined;
	for (const words of shellSegments(command)) {
		const found = segmentSend(words, depth);
		if (found) return found;
		for (const w of words) {
			for (const m of w.text.matchAll(/\$\(([\s\S]*)\)|`([^`]*)`/g)) {
				const inner = commandSend(m[1] ?? m[2] ?? "", depth + 1);
				if (inner) return inner;
			}
		}
	}
	return undefined;
}

// An eval cell is code, not shell: check the shell it hands out (Bun.$`...`, tool.bash({ command }), exec/system strings, argv arrays) and
// any fetch of the reply act that sends.
function cellSend(code: string): string | undefined {
	const quoted = String.raw`(["'\x60])((?:(?!\1)[^\\]|\\[\s\S])*)\1`;
	const shells = [
		...[...code.matchAll(/\$\x60((?:[^\x60\\]|\\[\s\S])*)\x60/g)].map(m => m[1]),
		...[...code.matchAll(new RegExp(String.raw`\bcommand\s*:\s*${quoted}`, "g"))].map(m => m[2]),
		// Perl and Ruby call it with or without parentheses (`system "zele mail send"`).
		...[...code.matchAll(new RegExp(String.raw`\b(?:exec|execSync|system|popen|check_output|getoutput|run)\s*\(?\s*${quoted}`, "g"))].map(m => m[2]),
	];
	for (const s of shells) {
		const found = commandSend(s);
		if (found) return found;
	}
	// argv lists: `["zele", "mail", "send"]`, a call's own arguments (Perl/Ruby `system("zele", "mail", "send")`, Node `spawn("zele", [...])`)
	// and Perl's `qw(zele mail send)`.
	const lists = [...code.matchAll(/\[([^[\]]*)\]/g), ...code.matchAll(/\b(?:system|exec\w*|spawn\w*|popen\w*|Popen|run|call|check_call|check_output)\s*\(([^()]*)\)/g), ...code.matchAll(/\b(?:system|exec)[ \t]+((?:["'][^"'\n]*["'][ \t]*,?[ \t]*)+)/g)];
	for (const m of lists) {
		const words = [...m[1]!.matchAll(/["']([^"'\n]*)["']/g)].map(w => ({ text: w[1]!, expands: false }));
		const found = segmentSend(words, 0);
		if (found) return found;
	}
	for (const m of code.matchAll(/\bqw\s*[([{/]([^)\]}/]*)[)\]}/]/g)) {
		const found = segmentSend(m[1]!.trim().split(/\s+/).map(text => ({ text, expands: false })), 0);
		if (found) return found;
	}
	return postSends(code, false, HTTP_CALL.test(code));
}

/** The refusal for an agent's bash command or eval cell that would send a reply itself, or undefined. */
export function replySendDeny(toolName: string, input: any): string | undefined {
	const found = toolName === "bash" ? commandSend(String(input?.command ?? "")) : toolName === "eval" ? cellSend(String(input?.code ?? "")) : undefined;
	return found && REFUSAL.replace("%s", found);
}
