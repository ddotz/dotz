import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logsDir } from "../agent-home.ts";

/** One block of the guard: a JSON line of this shape is appended to <log dir>/guard-blocks.jsonl, which harness/guard-blocks.ts reports. */
export interface BlockRow {
	at: string;
	phase: string;
	agentKind: string;
	cwd: string;
	tool: string;
	target: string;
}
const logDir = () => process.env.ORCH_GUARD_LOG_DIR ?? logsDir();
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const fileSize = (path: string): number => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};
const SECRET_MASKS: [RegExp, string][] = [
	[/(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^"'\r\n]+/gi, "$1***"],
	[/((?:token|secret|api[-_]?key|password|passwd|pwd|passphrase|cookie|credential|signature|private[-_]?key|[-_]key)[a-z0-9_-]*|\bauth(?:[-_][a-z0-9_-]+)?)(["']?\s*:\s*["']?)[^"'\r\n]+/gi, "$1$2***"],
	[/\b(bearer|token)(\s+)(?=[a-z0-9._~+/=-]*\d)[a-z0-9._~+/=-]{8,}/gi, "$1$2***"],
	[/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]*:)[^\s@/'"]+@/gi, "$1***@"],
	[/(\b[a-z][a-z0-9+.-]*:\/\/)[a-z0-9_-]{20,}@/gi, "$1***@"],
	[/(\bhooks\.slack(?:-gov)?\.com\/(?:services|workflows|triggers)\/)[^\s'"?#;&|<>)]+/gi, "$1***"],
	[/(\b(?:(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks|(?:outlook\.office(?:365)?\.com|[a-z0-9-]+\.webhook\.office\.com)\/webhook[a-z0-9]*|hooks\.zapier\.com\/hooks\/catch)\/)[^\s'"?#;&|<>)]+/gi, "$1***"],
	[/(\bapi\.telegram\.org\/(?:file\/)?bot)[^\s'"?#/;&|<>)]+/gi, "$1***"],
	[/(--(?:password|passwd|pass|passphrase|pwd|token|secret|secret-key|api-?key|access-?token|auth-?token|client-?secret|oauth2-bearer|private-?key|credentials?|proxy-password|cookie)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, "$1***"],
	[/((?:\s-[A-Za-z]*u\s*|--(?:proxy-)?user(?:=|\s+)))(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s:'"]*:\S*)/gi, "$1***"],
	[/(\s-b\s*)(?=["']?[^\s"']*=)("[^"]*"|'[^']*'|\S+)/g, "$1***"],
	[/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)[A-Z0-9_]*=)("[^"]*"|'[^']*'|\S+)/g, "$1***"],
	[/((?:\b|[_.-])(?:password|passwd|passphrase|pwd|pass|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|credentials?|signature|sig|auth|key)=)("[^"]*"|'[^']*'|[^\s&;|<>'")]+)/gi, "$1***"],
	[/(--(?:with-token|password-stdin)\b[^\n|;&]*?<<<\s*)("[^"]*"|'[^']*'|[^\s&;|]+)/g, "$1***"],
	[/(\b(?:echo|printf)\s+(?:-[A-Za-z]+\s+)*)("[^"]*"|'[^']*'|[^\s|;&<>]+)(?=\s*\|[^\n;&|]*--(?:with-token|password-stdin)\b)/g, "$1***"],
	[/(\bsecret\s+put\s+\S+\s*<<<\s*)("[^"]*"|'[^']*'|[^\s&;|]+)/g, "$1***"],
	[/(\bsshpass\b[^|;&\n]*?\s-p\s*)("[^"]*"|'[^']*'|[^\s'"]+)/g, "$1***"],
	[/(\blogin\b[^|;&\n]*?\s-p\s*)("[^"]*"|'[^']*'|[^\s'"]+)/g, "$1***"],
	[/(\bmysql\w*\b[^|;&\n]*?\s-p)("[^"]*"|'[^']*'|[^\s'"]+)/g, "$1***"],
	[/(\bredis-cli\b[^|;&\n]*?\s-a\s+)("[^"]*"|'[^']*'|[^\s'"]+)/g, "$1***"],
	[/(\baws\s+configure\s+set\s+\S*(?:secret|token|key)\S*\s+)("[^"]*"|'[^']*'|[^\s'"]+)/gi, "$1***"],
];

/** `text` with credentials replaced by `***`: authorization, cookie and key headers, URL userinfo, chat webhook and bot-token paths, `--password`-style options and clustered `-su user:pass`, `-b`, `-p` options of curl, mysql, sshpass, docker and redis-cli, `--with-token` input, query and form parameters, JSON fields and environment assignments. */
export function maskSecrets(text: string): string {
	return SECRET_MASKS.reduce((masked, [pattern, mask]) => masked.replace(pattern, mask), text);
}

const LOCK_STALE_MS = 5000;
const LOCK_TRIES = 10;
const LOCK_PAUSE_MS = 10;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockAge = (lock: string): number => {
	try {
		return Date.now() - statSync(lock).mtimeMs;
	} catch {
		return 0;
	}
};

function takeLock(lock: string): boolean {
	for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			if (lockAge(lock) > LOCK_STALE_MS) {
				try {
					unlinkSync(lock);
				} catch {}
				continue;
			}
			pause(LOCK_PAUSE_MS);
		}
	}
	return false;
}

function rotateIfFull(file: string): void {
	if (fileSize(file) <= LOG_MAX_BYTES) return;
	const lock = `${file}.lock`;
	if (!takeLock(lock)) return;
	try {
		if (fileSize(file) > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
	} finally {
		try {
			unlinkSync(lock);
		} catch {}
	}
}

/** Appends `row` to the block log, rotating the file at 5 MiB under an exclusive lock file (the size is checked again once the lock is held; with no lock the row is appended without rotating). Throws on any file error: the caller decides that a logging failure never reaches the hook. */
export function appendBlockRow(row: BlockRow): void {
	const file = join(logDir(), "guard-blocks.jsonl");
	mkdirSync(logDir(), { recursive: true });
	rotateIfFull(file);
	appendFileSync(file, `${JSON.stringify(row)}\n`);
}
