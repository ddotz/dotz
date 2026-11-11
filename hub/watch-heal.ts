// Self-healing of a watch whose check script is broken (design: classify the failure with rules only, then let the orchestrator fix the one file the watch
// runs; the gateway re-runs the check). This file holds the pure parts: what kind of failure it is, and which file a watch runs.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export type FailClass = "script" | "outside" | "owner" | "unknown";
/** What notify() is told about a failure: the class, the file holding the last output and, after a heal, the note it left. */
export type NotifyInfo = { cls: FailClass; log: string; note?: string };
/** What the heal turn text is made of (the wording is in the i18n catalogs, selfHealTurn). */
export type HealTurnArgs = {
	label: string;
	code: number;
	cls: FailClass;
	file: string;
	backup: string;
	tail: string;
	lastOk?: string;
	scriptAfterOk?: boolean;
	okLines: string;
	attempt: number;
	max: number;
	notePath: string;
	tried?: string;
};

export const SCRIPT_MAX_BYTES = 64 * 1024;

const OWNER_KINDS = new Set(["approval", "password", "login", "2fa", "auth"]);
const OUTSIDE = [
	/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|socket hang up|Could not resolve host/i,
	/\b(?:HTTP|status)[ :=]*5\d\d\b/i,
	/\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway)/i,
	/점검|maintenance|rate limit|\b429\b/i,
];
const OWNER = [
	/logged out|로그인이 풀|세션이 만료|second factor|2차 인증|\bOTP\b|비밀번호|승인|approval/i,
	/password (?:rejected|incorrect|wrong)/i,
	/\b(?:401|403)\b|Unauthorized|Forbidden/,
];
const SCRIPT = [
	/\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
	/Cannot read propert(?:y|ies) of (?:null|undefined)/,
	/is not a function|is not defined|command not found|No such file or directory|\bENOENT\b|Cannot find module|Module not found/,
	/Unexpected token|JSON Parse error|is not valid JSON|JSONDecodeError|Traceback \(most recent call last\)|syntax error near unexpected token/,
	/querySelector|selector[^\n]{0,80}not found|no such element/i,
];
const STACK_LINE = /^\s+at .+:\d+:\d+/m;

/** The ordered rules of the design: the first that fits decides. `kind` is the DOTZ_FAIL kind ("fail" when the check named none). */
export function classifyFailure(i: { output: string; code: number; timedOut?: boolean; kind: string }): FailClass {
	const { output, code, timedOut, kind } = i;
	if (kind === "script") return "script";
	if (OWNER_KINDS.has(kind)) return "owner";
	if (kind !== "fail") return "outside";
	if (timedOut) return "unknown";
	if (OUTSIDE.some(r => r.test(output))) return "outside";
	if (OWNER.some(r => r.test(output))) return "owner";
	if (SCRIPT.some(r => r.test(output)) || (code !== 0 && STACK_LINE.test(output)) || code === 126 || code === 127) return "script";
	return "unknown";
}

export type HealRefusal = "none" | "shipped" | "secret" | "session" | "text" | "size";
export type HealTarget = { file: string } | { refuse: HealRefusal };
type Runs = { script?: string; command: string; cwd?: string; session?: unknown };

const SCRIPT_EXT = /\.(?:sh|bash|zsh|ts|js|mjs|py|rb)$/i;
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const real = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

// The words of a shell command that can name a file: quotes dropped, flags and operators left out.
function pathTokens(command: string): string[] {
	return command.split(/[\s"'`;&|()<>]+/).filter(t => t && !t.startsWith("-") && (t.includes("/") || t.includes(".")));
}

/**
 * The file a watch runs: its `script`, else the first existing file named in its `command` (an absolute path, `~/`, or relative to the watch's cwd).
 * Refused: nothing found, the dotz package's own code, the data folder's secrets, a login-keeping watch, a file that is not text or over 64 KB.
 */
export function healTarget(w: Runs, pkgDir: string, dataDir: string): HealTarget {
	if (w.session) return { refuse: "session" };
	const candidates = w.script ? [w.script] : pathTokens(w.command).map(t => (t.startsWith("~/") ? join(homedir(), t.slice(2)) : t));
	const pkg = real(pkgDir), secrets = real(join(dataDir, "secrets"));
	let soft: HealRefusal | undefined;
	for (const c of candidates) {
		const file = isAbsolute(c) ? c : resolve(w.cwd ?? process.cwd(), c);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(file);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;
		// a command also names data it reads (`cat state.json | ...`): only a script is fixed, never a data file
		if (!w.script && !(st.mode & 0o111) && !SCRIPT_EXT.test(file)) continue;
		const at = real(file);
		if (inside(at, pkg)) return { refuse: "shipped" };
		if (inside(at, secrets)) return { refuse: "secret" };
		if (st.size > SCRIPT_MAX_BYTES) soft ??= "size";
		else if (readFileSync(file).includes(0)) soft ??= "text";
		else return { file };
	}
	return { refuse: soft ?? "none" };
}
