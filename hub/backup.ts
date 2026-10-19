// Optional off-machine copy of the ~/.dotz git snapshot (config `backup.remote`, off by default). Nothing leaves the
// machine unless every file about to be pushed passes the secret scan below (ported from 오모냥 backup.py).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log, writeAtomic } from "./config.ts";

const SECRET = new RegExp(
	[
		"gh[pousr]_[A-Za-z0-9]{30,}",
		"\\bsk-[A-Za-z0-9_-]{20,}",
		"xox[baprs]-[A-Za-z0-9-]{10,}",
		"AIza[0-9A-Za-z_-]{30,}",
		"eyJ[A-Za-z0-9_-]{20,}\\.eyJ[A-Za-z0-9_-]{10,}",
		"Bearer\\s+[A-Za-z0-9._~+/-]{30,}",
		"-----BEGIN [A-Z ]*PRIVATE KEY-----",
		"[MNO][A-Za-z0-9_-]{23,25}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}",
	].join("|"),
);
const SECRET_ASSIGN = /"?(?:api_?key|access_?token|refresh_?token|client_?secret|password|passwd)"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{16,}/i;
const SECRET_KEY = /(pass|pw$|secret|token|key|credential|cookie|auth)/i;
// `token_file: "~/.dotz/secrets/x"` names where a secret lives; it is not one.
const POINTER_KEY = /_(file|path|dir)$/i;
const MAX_BYTES = 1_000_000;

function jsonSecret(text: string): boolean {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return false;
	}
	const stack: unknown[] = [data];
	while (stack.length) {
		const o = stack.pop();
		if (Array.isArray(o)) stack.push(...o);
		else if (o && typeof o === "object")
			for (const [k, v] of Object.entries(o)) {
				if (typeof v === "string" && SECRET_KEY.test(k) && !POINTER_KEY.test(k) && v.length >= 6 && !/^[!$]/.test(v)) return true;
				stack.push(v);
			}
	}
	return false;
}

export const hasSecret = (text: string): boolean => SECRET.test(text) || SECRET_ASSIGN.test(text) || jsonSecret(text);

type Run = { code: number; out: string };
async function git(dir: string, args: string[], timeout = 60_000): Promise<Run> {
	const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out: out + err };
}

const lines = (s: string) => s.split("\n").filter(Boolean);
const scrub = (s: string) => s.replace(/\/\/[^@/\s]+@/g, "//***@");

// Staged files whose content looks like a secret. Names only; values never leave this function.
async function scan(dir: string, show: (path: string) => string, files: string[]): Promise<string[]> {
	const bad: string[] = [];
	for (const f of files) {
		const r = await git(dir, ["show", show(f)]);
		if (r.code === 0 && r.out.length <= MAX_BYTES && hasSecret(r.out)) bad.push(f);
	}
	return bad;
}

// Call after `git add -A`, before committing. Flagged files are unstaged so the local history never records them.
export async function unstageSecrets(dir: string): Promise<string[]> {
	const staged = lines((await git(dir, ["diff", "--cached", "--name-only", "--diff-filter=AM"])).out);
	const bad = await scan(dir, f => `:${f}`, staged);
	for (const f of bad) await git(dir, ["reset", "-q", "--", f]);
	return bad;
}

// One alert per KST day, whatever the cause; the log line is written every time.
function alertOnce(dir: string, text: string): string | undefined {
	const file = join(dir, "backup-state.json");
	const day = new Date().toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
	let last = "";
	try {
		last = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).alertDay : "";
	} catch {}
	if (last === day) return undefined;
	writeAtomic(file, JSON.stringify({ alertDay: day }));
	return text;
}

// Pushes HEAD to `remote` when nothing unpushed (this run's commit or older ones) trips the scan. Returns alert text
// for the owner, at most once a day; undefined when pushed, nothing to push, or already alerted today.
export async function pushBackup(dir: string, remote: string, flagged: string[]): Promise<string | undefined> {
	const fail = (why: string, alert: string) => {
		log(`backup: ${why}`);
		return alertOnce(dir, `[backup] ${alert}`);
	};
	if (/\/\/[^@/\s]+:[^@/\s]+@/.test(remote)) return fail("backup.remote embeds credentials; push refused", "backup.remote URL에 비밀번호/토큰이 들어 있어서 push를 막았어요. 자격증명은 git credential helper나 ssh 키로 빼주세요.");
	if (flagged.length) return fail(`push blocked, secret-like content in: ${flagged.join(", ")}`, `비밀값처럼 보이는 내용이 있어서 백업 push를 막았어요 (파일: ${flagged.join(", ")}). 값을 지우면 다음 스냅샷부터 다시 올라가요.`);
	const head = (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).out.trim();
	if (!head) return undefined;
	const ref = `refs/backup/${createHash("sha1").update(remote).digest("hex").slice(0, 8)}`;
	const done = (await git(dir, ["rev-parse", "-q", "--verify", ref])).out.trim();
	if (done === head) return undefined;
	// Commits from before the remote was enabled (or from before a blocked file was cleaned) are pushed too: scan them all.
	const commits = lines((await git(dir, ["rev-list", done ? `${done}..HEAD` : "HEAD"])).out);
	for (const c of commits) {
		const changed = lines((await git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--diff-filter=AM", c])).out);
		const bad = await scan(dir, f => `${c}:${f}`, changed);
		if (bad.length) return fail(`push blocked, secret-like content in history ${c.slice(0, 8)}: ${bad.join(", ")}`, `백업 히스토리(${c.slice(0, 8)})에 비밀값처럼 보이는 내용이 있어서 push를 막았어요 (파일: ${bad.join(", ")}). 히스토리 정리가 필요해요.`);
	}
	const branch = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).out.trim() || "main";
	const r = await git(dir, ["push", "-q", remote, `HEAD:refs/heads/${branch}`], 120_000);
	if (r.code !== 0) return fail(`push failed: ${scrub(r.out).trim().slice(-300)}`, "백업 push가 실패했어요. hub.log의 'backup:' 줄을 확인해 주세요.");
	await git(dir, ["update-ref", ref, head]);
	log(`backup: pushed ${commits.length} commit(s)`);
	return undefined;
}
