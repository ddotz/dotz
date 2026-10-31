// Self-update of the dotz checkout the gateway runs from (settings → 업데이트). The check fetches the tracked branch
// (origin/main by default) and lists what is new. Local commits upstream already has are dropped, the rest are re-applied on the new
// version in a temporary worktree (hub/selfupdate-local.ts) with the same checks; what cannot be carried over (conflict, failing checks,
// uncommitted changes) is saved first (branch dotz-local/<stamp> + patch files in the logs dir) and waits for the owner's button, or is
// moved aside automatically by auto_apply on a non-developer install. The update then fast-forwards, runs `bun install`
// when package.json or the lockfile changed, runs the update gate (hub/update-gate.json of the new version: a smoke start of its gateway)
// and goes back to the old commit if it fails. An applied update leaves <data>/update-pending.json and, from the gateway, a detached
// watchdog (hub/update-watchdog.ts) that rolls it back when the restarted gateway never comes up healthy (updateBoot clears it). The
// restart itself is main.ts's restart gate (waits for running turns) or, on the owner's word, an immediate restart.
// A daily check (self_update.auto_check / self_update.at in config.json) only notifies, unless self_update.auto_apply is on
// (default off): then a new upstream commit on a clean checkout with nothing ahead of origin goes through the same apply()
// (ff-only, bun install, tests, revert on failure) and the idle restart gate; a refusal or failure goes to alert with a choice block.
// Every check and update leaves lines in ~/.dotz/logs/update-YYYYMMDD.log.
// A tarball install (install.sh without --git: no .git, a .dotz-install stamp with repo, ref, commit sha, source kind and
// auth) updates the same way: the check asks GitHub for the latest commit of repo@ref (for DOTZ_TARBALL installs it compares
// the tarball's sha256) and lists the incoming commits; apply downloads the new tarball into a staging dir next to the install,
// runs bun install and the tests there, then swaps the dirs (the old one stays as <dir>.prev, one copy) and leaves the restart to
// the same gate. A failed step removes the staging dir and keeps the old code. GitHub auth order: GITHUB_TOKEN/GH_TOKEN,
// <data dir>/secrets/github-token (0600, saved by install.sh), `gh api` when gh is signed in, then none (public repos).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { CONFIG_FILE, cfg, DATA_DIR, HUB_TOKEN, log, PORT, writeAtomic } from "./config.ts";
import { FORMAT, type Keep, keepLine, openTrial, parseCommits, type Saved, saveLocal, savedNote, splitEquivalent, writeSavedSummary } from "./selfupdate-local.ts";
import { trackTimer } from "./shutdown.ts";
import type { Pending } from "./update-watchdog.ts";

export type Exec = (cmd: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; out: string }>;
export type Commit = { sha: string; short: string; date: string; subject: string };
export type Version =
	| { kind: "git"; commit: Commit; branch: string }
	| { kind: "tarball"; commit: Commit; origin: "github" | "url"; repo: string; ref: string; auth: string; source: string; installed: string }
	| { kind: "install"; source: string; installed: string }
	| { kind: "unknown"; detail: string };
type CheckError = { reason: string; fix: string; detail: string };
export type CheckResult = {
	at: string;
	version: Version;
	ok: boolean;
	error?: CheckError;
	upstream: string;
	remoteHead?: string;
	incoming: Commit[];
	incomingTotal: number;
	ahead: Commit[];
	// Local commits upstream already has (same patch, or nothing left to apply): skipped, never counted as local work.
	dropped: Commit[];
	dirty: string[];
	blocked: string[];
	// Local work that cannot be carried onto the new version by itself (already saved): settings shows the 'keep and update' button.
	keep?: Keep;
};
type Job = {
	id: number;
	startedAt: string;
	endedAt?: string;
	status: "running" | "updated" | "current" | "refused" | "failed";
	phase: string;
	message: string;
	from?: string;
	to?: string;
	steps: { at: string; text: string }[];
	check?: CheckResult;
	keep?: Keep;
	note?: string;
};
export type Options = {
	dir: string;
	remote?: string;
	branch?: string;
	exec?: Exec;
	testCmd?: string[];
	logDir?: string;
	// Tarball installs only: the network (default fetch), the environment tokens come from, the data dir holding secrets/github-token.
	http?: Http;
	env?: Record<string, string | undefined>;
	dataDir?: string;
	// Set when the running gateway applies an update to its own code: arm the rollback watchdog for this gateway pid and port.
	watch?: Watch;
};
// spawn: starts the watchdog detached (default spawnDetached); tests pass a fake.
export type Watch = { pid: number; port: number; spawn?: (cmd: string[]) => void };
export type Http = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
type Tarball = Extract<Version, { kind: "tarball" }>;

const REPO_DIR = join(import.meta.dir, "..");
const STATE_FILE = join(DATA_DIR, "self-update.json");
const LOCK_FILES = ["package.json", "bun.lock", "bun.lockb"];
const LIST_MAX = 30;
export const PENDING_FILE = "update-pending.json";
// The watchdog text of the version running now, read once at start: by the time it is spawned the files on disk are already the new version's.
const WATCHDOG_SRC = (() => {
	try {
		return readFileSync(join(import.meta.dir, "update-watchdog.ts"), "utf8");
	} catch {
		return undefined;
	}
})();
let gatewayWatch: Watch | undefined;

export const defaultExec: Exec = async (cmd, cwd, timeoutMs) => {
	// No credential prompt can ever wait for a terminal: a missing login fails at once with a message we can explain.
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
	try {
		const p = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { code, out: `${out}${err ? `\n${err}` : ""}`.trim() };
	} catch (e) {
		return { code: -1, out: String(e) };
	}
};

// Credentials embedded in a remote URL (https://user:token@host) never reach the page or the log.
export const scrub = (s: string) => s.replace(/(https?:\/\/)[^/@\s]+@/g, "$1***@").replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "***");
const lastLine = (s: string) => scrub(s.split("\n").map(l => l.trim()).filter(Boolean).pop() ?? "").slice(0, 300);

// Why a fetch failed, in the owner's words, and what fixes it.
export function fetchError(out: string, remote: string): CheckError {
	const detail = lastLine(out);
	if (/could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|Repository not found|returned error: 40[13]|Write access to repository not granted/i.test(out))
		return { reason: "GitHub 인증이 없어 비공개 저장소를 받을 수 없어요.", fix: "이 Mac의 터미널에서 `gh auth login`으로 로그인한 뒤 `gh auth setup-git`을 실행해 주세요. (토큰을 쓰는 git 자격 증명도 돼요)", detail };
	if (/Permission denied \(publickey\)|Host key verification failed/i.test(out))
		return { reason: "SSH 키로 GitHub에 접속하지 못했어요.", fix: "`ssh -T git@github.com`으로 확인하고, 키가 없으면 `gh ssh-key add ~/.ssh/id_ed25519.pub`로 등록해 주세요.", detail };
	if (/Could not resolve host|Failed to connect|Connection (refused|timed out)|Network is unreachable|Operation timed out|timed out|SIGTERM/i.test(out))
		return { reason: "원격 저장소에 연결하지 못했어요 (네트워크).", fix: "인터넷 연결을 확인하고 잠시 뒤 다시 확인해 주세요.", detail };
	if (/does not appear to be a git repository|No such remote/i.test(out))
		return { reason: `원격 '${remote}'이 없어요.`, fix: `\`git remote add ${remote} https://github.com/ddotz/dotz.git\`로 원격을 등록해 주세요.`, detail };
	if (/couldn't find remote ref/i.test(out)) return { reason: "원격에 추적하는 브랜치가 없어요.", fix: "config.json의 self_update.branch를 확인해 주세요.", detail };
	return { reason: "원격 저장소를 받지 못했어요.", fix: "터미널에서 `git fetch`를 실행해 원인을 확인해 주세요.", detail };
}

function settings() {
	const raw: unknown = "self_update" in cfg ? (cfg as Record<string, unknown>).self_update : undefined;
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const at = typeof o.at === "string" && /^\d{1,2}:\d{2}$/.test(o.at) ? o.at : "10:00";
	return {
		auto_check: o.auto_check !== false,
		auto_apply: o.auto_apply === true,
		at,
		remote: typeof o.remote === "string" && o.remote ? o.remote : "origin",
		branch: typeof o.branch === "string" && o.branch ? o.branch : "main",
		keep_local: typeof o.keep_local === "boolean" ? o.keep_local : undefined,
	};
}

// bun prints a failing test's error block (source excerpt, `error:`/expect lines, stack) right before its `(fail) name` line, after the
// previous `(pass)`/`(fail)` line or the file header. Keeps each block, capped per block, per run and in count, so the assertion survives the tail cut.
const FAIL_BLOCK_LINES = 40, FAIL_BLOCK_CHARS = 3000, FAIL_BLOCKS = 15, FAIL_TOTAL_CHARS = 20_000;
export function failureBlocks(out: string): string {
	const lines = out.split("\n");
	const blocks: string[] = [];
	let start = 0, total = 0, failed = 0;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (/^\((pass|skip|todo)\) /.test(l) || /^\S+\.test\.[cm]?[jt]sx?:\s*$/.test(l)) { start = i + 1; continue; }
		if (!/^\(fail\) /.test(l)) continue;
		failed++;
		const body = lines.slice(start, i).join("\n").trim().split("\n");
		start = i + 1;
		if (blocks.length >= FAIL_BLOCKS || total >= FAIL_TOTAL_CHARS) continue;
		let text = body.slice(-FAIL_BLOCK_LINES).join("\n");
		if (text.length > FAIL_BLOCK_CHARS) text = text.slice(-FAIL_BLOCK_CHARS);
		text = `${text}\n${l}`.trim();
		total += text.length;
		blocks.push(text);
	}
	if (!blocks.length) return "";
	return `${blocks.join("\n--\n")}${failed > blocks.length ? `\n… ${failed - blocks.length} more failure(s) not kept` : ""}`;
}

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
function record(logDir: string, text: string): void {
	try {
		mkdirSync(logDir, { recursive: true });
		appendFileSync(join(logDir, `update-${today()}.log`), `${new Date().toISOString()} ${scrub(text)}\n`);
	} catch (e) {
		log(`self-update: log write failed: ${e}`);
	}
}

// The update gate runs every test file in a fresh global (--isolate). In one shared global, what earlier files leave behind
// (WebViews, servers, timers) piles up until the later Bun.WebView tests time out one after another, and the whole run passes the
// 20-minute limit below (exit 143) on a slower or busy Mac, so the update never lands. Each file alone passes either way.
export const TEST_CMD = ["bun", "test", "--isolate"];
export const GATE_MINUTES = 20;

// The gate is read from the version being installed (hub/update-gate.json in the folder under test), not from this running file.
// The updater that runs is always the OLD one, so a gate fix shipped as a code constant would only take effect one update later,
// and never if the old gate keeps failing (that is how the --isolate fix got stuck behind exit 143). Missing or bad file: the
// constants above (the running version's own gate, never "no gate"). An explicit testCmd (tests, --test-cmd) still wins; the time limit comes from the new folder either way.
export const GATE_FILE = join("hub", "update-gate.json");
export function gateIn(cwd: string, testCmd?: string[]): { cmd: string[]; ms: number } {
	let g: { cmd?: unknown; timeoutMinutes?: unknown } = {};
	try {
		g = JSON.parse(readFileSync(join(cwd, GATE_FILE), "utf8"));
	} catch {
		// no gate file (an older version, or a test tree): fall back below
	}
	// The file may only choose the arguments of `bun test` and a limit of at most 60 minutes: a gate that is `true` or never ends is no gate.
	const fileCmd = Array.isArray(g?.cmd) && g.cmd.length >= 2 && g.cmd.every(x => typeof x === "string" && x) && g.cmd[0] === "bun" && g.cmd[1] === "test" ? (g.cmd as string[]) : undefined;
	const min = typeof g?.timeoutMinutes === "number" && g.timeoutMinutes > 0 && g.timeoutMinutes <= 60 ? g.timeoutMinutes : GATE_MINUTES;
	return { cmd: testCmd ?? fileCmd ?? TEST_CMD, ms: min * 60_000 };
}

function resolve(o: Options) {
	const s = settings();
	const watch = o.watch ?? (gatewayWatch && o.dir === REPO_DIR ? gatewayWatch : undefined);
	return { dir: o.dir, remote: o.remote ?? s.remote, branch: o.branch ?? s.branch, exec: o.exec ?? defaultExec, testCmd: o.testCmd, logDir: o.logDir ?? join(DATA_DIR, "logs"), watch };
}

type Stamp = Record<string, string>;
const readStamp = (dir: string): Stamp | undefined => {
	try {
		const kv: Stamp = {};
		for (const l of readFileSync(join(dir, ".dotz-install"), "utf8").split("\n")) {
			const i = l.indexOf("=");
			if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim();
		}
		return kv;
	} catch {
		return undefined;
	}
};
const stampText = (kv: Stamp) => `${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
// A stamp from before the sha was recorded only has `source=github.com/OWNER/REPO@REF`: enough to check, with an unknown sha.
function tarballVersion(kv: Stamp): Tarball | undefined {
	let { kind: origin, repo, ref } = kv;
	if (!origin) {
		const m = /^github\.com\/([^/@\s]+\/[^/@\s]+)@(.+)$/.exec(kv.source ?? "");
		if (m) [origin, repo, ref] = ["github", m[1], m[2]];
	}
	const installed = kv.installed ?? "?";
	const sha = kv.sha ?? "";
	const commit: Commit = { sha, short: sha.slice(0, 7) || "?", date: installed, subject: "" };
	const common = { kind: "tarball" as const, commit, auth: kv.auth ?? "?", source: scrub(kv.source ?? "?"), installed };
	if (origin === "github" && repo && ref) return { ...common, origin, repo, ref };
	if (origin === "url" && kv.tarball) return { ...common, origin, repo: "", ref: "" };
	return undefined;
}

// The version on disk: the checked-out commit, or the install.sh stamp for a tarball install.
export async function version(o: Options): Promise<Version> {
	const { dir, exec } = resolve(o);
	if (!existsSync(join(dir, ".git"))) {
		const kv = readStamp(dir);
		if (!kv) return { kind: "unknown", detail: "git 저장소도 install.sh 설치본도 아니에요" };
		return tarballVersion(kv) ?? { kind: "install", source: scrub(kv.source ?? "?"), installed: kv.installed ?? "?" };
	}
	const [c, b] = await Promise.all([exec(["git", "log", "-1", FORMAT], dir, 15_000), exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], dir, 15_000)]);
	const commit = parseCommits(c.out)[0];
	if (c.code !== 0 || !commit) return { kind: "unknown", detail: lastLine(c.out) };
	return { kind: "git", commit, branch: b.code === 0 ? b.out.trim() : "?" };
}

// ---- tarball installs (install.sh without --git) ----
type Cred = { how: "token"; token: string; from: string } | { how: "gh" } | { how: "none" };
const credName = (c: Cred) => (c.how === "token" ? `token(${c.from})` : c.how);
const authLabel = (c: Cred) => (c.how === "none" ? "public" : c.how);

// Who GitHub is asked as, in order: GITHUB_TOKEN, GH_TOKEN, the token file install.sh saved, `gh api` (when gh is signed in), nobody.
// A credential GitHub refuses falls through to the next one, so a stale token never blocks a public repo.
export function authOrder(o: Options): Cred[] {
	const env = o.env ?? process.env;
	const out: Cred[] = [];
	const add = (token: string | undefined, from: string) => {
		const t = token?.trim();
		if (t && !out.some(c => c.how === "token" && c.token === t)) out.push({ how: "token", token: t, from });
	};
	add(env.GITHUB_TOKEN, "env GITHUB_TOKEN");
	add(env.GH_TOKEN, "env GH_TOKEN");
	const file = join(o.dataDir ?? DATA_DIR, "secrets", "github-token");
	if (existsSync(file)) add(readFileSync(file, "utf8"), "secrets/github-token");
	out.push({ how: "gh" }, { how: "none" });
	return out;
}

type GhCommit = { sha: string; commit?: { message?: string; committer?: { date?: string } } };
const toCommit = (x: GhCommit): Commit => ({ sha: x.sha, short: x.sha.slice(0, 7), date: x.commit?.committer?.date ?? "", subject: (x.commit?.message ?? "").split("\n")[0].slice(0, 200) });
const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

type Try<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };
type Hit<T> = { ok: true; value: T; cred: Cred } | { ok: false; error: CheckError };

function github(o: Options, repo: string) {
	const { exec } = resolve(o);
	const http: Http = o.http ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(120_000) }));
	const creds = authOrder(o);
	let good: Cred | undefined;
	const headers = (c: Cred, accept: string): Record<string, string> => ({ accept, "user-agent": "dotz-selfupdate", ...(c.how === "token" ? { authorization: `Bearer ${c.token}` } : {}) });
	// The first credential that works wins (and goes first next time); the error names what the refusals mean for the owner.
	const run = async <T>(fn: (c: Cred) => Promise<Try<T>>): Promise<Hit<T>> => {
		const fails: string[] = [];
		let auth = false, rate = false, net = false;
		for (const c of good ? [good, ...creds.filter(x => x !== good)] : creds) {
			const r = await fn(c).catch((e): Try<T> => ({ ok: false, status: 0, detail: String(e) }));
			if (r.ok) {
				good = c;
				return { ok: true, value: r.value, cred: c };
			}
			fails.push(`${credName(c)}: ${r.status || "-"} ${r.detail}`.trim());
			if (/rate limit/i.test(r.detail)) rate = true;
			else if ([401, 403, 404].includes(r.status)) auth = true;
			else if (r.status === 0 && c.how !== "gh") net = true;
		}
		const detail = scrub(fails.join(" | ")).slice(0, 400);
		if (rate) return { ok: false, error: { reason: "GitHub 요청 한도에 걸렸어요.", fix: "잠시 뒤 다시 확인해 주세요. GITHUB_TOKEN이나 `gh auth login`을 쓰면 한도가 커져요.", detail } };
		if (auth) return { ok: false, error: { reason: `GitHub 인증이 없어 ${repo}을(를) 받을 수 없어요 (비공개 저장소이거나 ref가 없어요).`, fix: "이 Mac의 터미널에서 `gh auth login`을 하거나, GITHUB_TOKEN을 준 채 install.sh를 다시 실행해 주세요 (토큰은 데이터 폴더의 secrets/github-token에 0600으로 저장돼요).", detail } };
		if (net) return { ok: false, error: { reason: "GitHub에 연결하지 못했어요 (네트워크).", fix: "인터넷 연결을 확인하고 잠시 뒤 다시 확인해 주세요.", detail } };
		return { ok: false, error: { reason: "GitHub에서 새 버전을 받지 못했어요.", fix: "`gh auth status`로 로그인을 확인하고 다시 확인해 주세요.", detail } };
	};
	return {
		json: <T>(path: string) =>
			run<T>(async c => {
				if (c.how === "gh") {
					const r = await exec(["gh", "api", path.slice(1), "-H", "Accept: application/vnd.github+json"], o.dir, 60_000);
					if (r.code !== 0) return { ok: false, status: Number(/HTTP (\d{3})/.exec(r.out)?.[1] ?? 0), detail: lastLine(r.out) };
					return { ok: true, value: JSON.parse(r.out) as T };
				}
				const res = await http(`https://api.github.com${path}`, { headers: headers(c, "application/vnd.github+json") });
				if (!res.ok) return { ok: false, status: res.status, detail: lastLine(await res.text().catch(() => "")) };
				return { ok: true, value: (await res.json()) as T };
			}),
		download: (sha: string, dest: string) =>
			run<true>(async c => {
				if (c.how === "gh") {
					const r = await exec(["sh", "-c", 'gh api "$1" > "$2"', "sh", `repos/${repo}/tarball/${sha}`, dest], o.dir, 5 * 60_000);
					return r.code === 0 ? { ok: true, value: true } : { ok: false, status: Number(/HTTP (\d{3})/.exec(r.out)?.[1] ?? 0), detail: lastLine(r.out) };
				}
				const url = c.how === "token" ? `https://api.github.com/repos/${repo}/tarball/${sha}` : `https://codeload.github.com/${repo}/tar.gz/${sha}`;
				const res = await http(url, { headers: headers(c, "application/vnd.github+json") });
				if (!res.ok) return { ok: false, status: res.status, detail: lastLine(await res.text().catch(() => "")) };
				await Bun.write(dest, res);
				return { ok: true, value: true };
			}),
	};
}

// A DOTZ_TARBALL install: the same URL or path again. Its identity is the sha256 of the bytes.
async function readUrl(o: Options, url: string): Promise<Uint8Array> {
	if (!/^https?:\/\//.test(url)) return new Uint8Array(await Bun.file(url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url).arrayBuffer());
	const token = authOrder(o).find(c => c.how === "token");
	const http: Http = o.http ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(120_000) }));
	const res = await http(url, { headers: token?.how === "token" ? { authorization: `Bearer ${token.token}` } : {} });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function checkTarball(o: Options, v: Tarball, base: CheckResult): Promise<CheckResult> {
	const { logDir } = resolve(o);
	const fail = (upstream: string, error: CheckError) => {
		record(logDir, `check: tarball ${upstream} failed: ${error.reason} (${error.detail})`);
		return { ...base, upstream, error };
	};
	if (v.origin === "url") {
		const url = readStamp(o.dir)?.tarball ?? "";
		const upstream = scrub(url);
		let digest: string;
		try {
			digest = sha256(await readUrl(o, url));
		} catch (e) {
			return fail(upstream, { reason: "설치할 때 쓴 tarball을 다시 받지 못했어요.", fix: "DOTZ_TARBALL 경로나 주소가 아직 있는지 확인하고, 없으면 install.sh를 다시 실행해 주세요.", detail: lastLine(String(e)) });
		}
		const r: CheckResult = { ...base, ok: true, upstream, remoteHead: digest };
		if (sameSha(digest, v.commit.sha)) return r;
		r.incoming = [{ sha: digest, short: digest.slice(0, 7), date: new Date().toISOString(), subject: `${upstream}의 tarball이 바뀌었어요` }];
		r.incomingTotal = 1;
		record(logDir, `check: ${v.commit.short} vs tarball ${digest.slice(0, 7)}: changed`);
		return r;
	}
	const upstream = `${v.repo}@${v.ref}`;
	const gh = github(o, v.repo);
	const latest = await gh.json<GhCommit>(`/repos/${v.repo}/commits/${encodeURI(v.ref)}`);
	if (!latest.ok) return fail(upstream, latest.error);
	const head = toCommit(latest.value);
	const r: CheckResult = { ...base, ok: true, upstream, remoteHead: head.sha };
	const cur = v.commit.sha;
	if (cur && sameSha(cur, head.sha)) {
		record(logDir, `check: ${v.commit.short} is ${upstream} (${latest.cred.how})`);
		return r;
	}
	r.incoming = [head];
	r.incomingTotal = 1;
	if (cur) {
		const cmp = await gh.json<{ status?: string; total_commits?: number; commits?: GhCommit[] }>(`/repos/${v.repo}/compare/${cur}...${head.sha}`);
		const list = cmp.ok && cmp.value.status === "ahead" ? cmp.value.commits ?? [] : [];
		if (list.length) {
			r.incoming = list.map(toCommit).reverse().slice(0, LIST_MAX);
			r.incomingTotal = cmp.ok ? cmp.value.total_commits ?? list.length : list.length;
		}
	}
	record(logDir, `check: ${v.commit.short || "?"} vs ${upstream} ${head.short}: ${r.incomingTotal} incoming (${latest.cred.how})`);
	return r;
}

// Detached from the gateway's process group, so the service manager does not take it down with the gateway. Under systemd the whole
// unit cgroup is stopped when the gateway exits, so it runs in a transient unit of its own there.
function spawnDetached(cmd: string[]): void {
	const systemd = process.platform === "linux" && process.env.INVOCATION_ID && Bun.which("systemd-run");
	const p = Bun.spawn(systemd ? ["systemd-run", "--user", "--collect", "--quiet", ...cmd] : cmd, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	p.unref();
}

// After an update is applied: <data>/update-pending.json for the next start to clear (updateBoot), and, when the running gateway
// applied it to its own code, the rollback watchdog started from a copy in the data dir (hub/update-watchdog.ts says why).
function markPending(o: Options, p: Pick<Pending, "kind" | "dir" | "from" | "to" | "prev" | "deps">, step: (phase: string, text: string) => void): void {
	const { watch, logDir } = resolve(o);
	const data = o.dataDir ?? DATA_DIR;
	const file = join(data, PENDING_FILE);
	const marker: Pending = { ...p, at: new Date().toISOString(), status: "pending", ...(watch ? { gatewayPid: watch.pid, port: watch.port } : {}) };
	try {
		mkdirSync(data, { recursive: true });
		writeAtomic(file, `${JSON.stringify(marker)}\n`);
		if (!watch) return record(logDir, "update: pending marker written, no watchdog (not the running gateway's own code)");
		if (!WATCHDOG_SRC) return record(logDir, "update: no watchdog source in the running version; no automatic rollback");
		const copy = join(data, "update-watchdog.ts");
		writeFileSync(copy, WATCHDOG_SRC);
		(watch.spawn ?? spawnDetached)([process.execPath, copy, file]);
		step("확인", "재시작한 게이트웨이가 3분 안에 정상으로 뜨지 않으면 이전 버전으로 자동으로 되돌려요");
	} catch (e) {
		record(logDir, `update: pending marker or watchdog failed: ${e}`);
	}
}

// Download → extract → bun install → tests, all in a staging dir next to the install; only then swap the dirs. Any failure removes the
// staging dir and leaves the running code untouched.
async function applyTarball(o: Options, c: CheckResult, v: Tarball, j: Job, step: (phase: string, text: string) => void, end: (status: Job["status"], text: string) => Job): Promise<Job> {
	const { dir, exec, testCmd, logDir } = resolve(o);
	const stage = `${dir}.update`;
	const prev = `${dir}.prev`;
	const fresh = join(stage, "new");
	const oldStamp = readStamp(dir) ?? {};
	const fail = (why: string) => {
		rmSync(stage, { recursive: true, force: true });
		return end("failed", `${why}. 이전 버전(${v.commit.short})이 그대로 있어요.`);
	};
	let to = c.remoteHead as string;
	let auth = v.auth;
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(join(stage, "x"), { recursive: true });
	const tgz = join(stage, "src.tgz");
	step("내려받기", `${v.origin === "url" ? scrub(oldStamp.tarball ?? "") : `${v.repo}@${v.ref}`} 새 버전을 내려받아요`);
	if (v.origin === "github") {
		const d = await github(o, v.repo).download(to, tgz);
		if (!d.ok) return fail(`내려받지 못했어요: ${d.error.reason} ${d.error.detail}`);
		auth = authLabel(d.cred);
	} else {
		try {
			const bytes = await readUrl(o, oldStamp.tarball ?? "");
			to = sha256(bytes);
			writeFileSync(tgz, bytes);
		} catch (e) {
			return fail(`내려받지 못했어요: ${lastLine(String(e))}`);
		}
	}
	j.to = to;
	step("풀기", "압축을 풀어요");
	const x = await exec(["tar", "-xzf", tgz, "-C", join(stage, "x")], stage, 2 * 60_000);
	if (x.code !== 0) return fail(`압축을 풀지 못했어요: ${lastLine(x.out)}`);
	// GitHub tarballs (and git archive --prefix) wrap everything in one top folder.
	const tops = readdirSync(join(stage, "x"));
	const top = tops.length === 1 && statSync(join(stage, "x", tops[0])).isDirectory() ? join(stage, "x", tops[0]) : join(stage, "x");
	if (!existsSync(join(top, "setup.ts")) || !existsSync(join(top, "hub", "main.ts"))) return fail("받은 파일이 dotz가 아니에요 (setup.ts, hub/main.ts가 없어요)");
	renameSync(top, fresh);
	writeFileSync(join(fresh, ".dotz-install"), stampText({ ...oldStamp, sha: to, auth, installed: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));

	step("의존성", "새 폴더에서 bun install을 실행해요");
	const i = await exec(["bun", "install"], fresh, 10 * 60_000);
	if (i.code !== 0) return fail(`bun install 실패: ${lastLine(i.out)}`);

	const gate = gateIn(fresh, testCmd);
	step("테스트", `${gate.cmd.join(" ")} 실행 중 (새 폴더)`);
	const t = await exec(gate.cmd, fresh, gate.ms);
	const summary = t.out.split("\n").filter(l => /^\s*\d+ (pass|fail)\b/.test(l)).map(l => l.trim()).join(", ");
	if (t.code !== 0) {
		const blocks = failureBlocks(t.out);
		if (blocks) record(logDir, `update #${j.id}: failed tests\n${blocks}`);
		record(logDir, `update #${j.id}: test output (tail)\n${t.out.split("\n").slice(-40).join("\n")}`);
		const names = failedTestNames(t.out);
		return fail(`테스트 실패${summary ? ` (${summary})` : ` (exit ${t.code})`}${names.length ? `: ${names.join(" / ")}` : ""}`);
	}

	step("교체", `${dir} 폴더를 새 버전으로 바꾸고 이전 폴더는 ${prev}에 남겨요`);
	try {
		rmSync(prev, { recursive: true, force: true });
		renameSync(dir, prev);
		try {
			renameSync(fresh, dir);
		} catch (e) {
			renameSync(prev, dir);
			throw e;
		}
	} catch (e) {
		return fail(`폴더를 바꾸지 못했어요: ${lastLine(String(e))}`);
	}
	rmSync(stage, { recursive: true, force: true });
	markPending(o, { kind: "tarball", dir, from: v.commit.sha, to, prev }, step);
	return end("updated", `${v.commit.short} → ${to.slice(0, 7)} 받았어요${summary ? ` (테스트 ${summary})` : ""}. 이전 폴더는 ${prev}에 있어요. 재시작하면 적용돼요.`);
}

// Fetch the tracked branch and compare. Never changes the working tree.
export async function check(o: Options): Promise<CheckResult> {
	const { dir, remote, branch, exec, logDir } = resolve(o);
	const upstream = `${remote}/${branch}`;
	const v = await version(o);
	const base: CheckResult = { at: new Date().toISOString(), version: v, ok: false, upstream, incoming: [], incomingTotal: 0, ahead: [], dropped: [], dirty: [], blocked: [] };
	if (v.kind === "tarball") return checkTarball(o, v, base);
	if (v.kind !== "git") {
		const r = {
			...base,
			error: {
				reason: v.kind === "install" ? "install.sh 설치본의 출처를 알 수 없어서 새 버전을 확인할 수 없어요." : "업데이트할 수 있는 dotz 사본이 아니에요.",
				fix: "설치 스크립트를 다시 실행하면 최신으로 바뀌고, 그다음부터는 여기서 업데이트해요: `curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh` (비공개 저장소면 먼저 `gh auth login`)",
				detail: v.kind === "install" ? `source=${v.source} installed=${v.installed}` : v.detail,
			},
		};
		record(logDir, `check: not a git checkout (${r.error.detail})`);
		return r;
	}
	const f = await exec(["git", "fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${upstream}`], dir, 90_000);
	if (f.code !== 0) {
		const error = fetchError(f.out, remote);
		record(logDir, `check: fetch ${upstream} failed: ${error.reason} (${error.detail})`);
		return { ...base, error };
	}
	const [head, inc, count, ahead, dirty] = await Promise.all([
		exec(["git", "rev-parse", upstream], dir, 15_000),
		exec(["git", "log", FORMAT, "-n", String(LIST_MAX), `HEAD..${upstream}`], dir, 15_000),
		exec(["git", "rev-list", "--count", `HEAD..${upstream}`], dir, 15_000),
		exec(["git", "log", FORMAT, "-n", String(LIST_MAX), `${upstream}..HEAD`], dir, 15_000),
		exec(["git", "status", "--porcelain"], dir, 15_000),
	]);
	const r: CheckResult = {
		...base,
		ok: true,
		remoteHead: head.out.trim(),
		incoming: parseCommits(inc.out),
		incomingTotal: Number(count.out.trim()) || 0,
		ahead: parseCommits(ahead.out),
		// exec trims its output, which takes the first line's leading blank (" M hub/x.ts" -> "M hub/x.ts"): put the two-column status back,
		// or the screen reads the path one letter short ("ub/x.ts").
		dirty: dirty.out.split("\n").filter(Boolean).map(l => (/^\S /.test(l) ? ` ${l}` : l)).slice(0, 40),
	};
	if (v.branch !== branch) r.blocked.push(`지금 브랜치가 ${v.branch}이에요. ${branch}에서만 업데이트해요.`);
	if (r.incomingTotal > 0 && r.remoteHead && (r.ahead.length || r.dirty.length)) {
		let why: string | undefined;
		if (r.ahead.length) {
			const split = await splitEquivalent(exec, dir, upstream);
			r.dropped = split.dropped;
			r.ahead = split.rest;
			if (split.rest.length) {
				const t = await openTrial(exec, dir, r.remoteHead, split.rest);
				if (t.ok) {
					r.dropped = [...r.dropped, ...t.emptied];
					r.ahead = t.kept;
					await t.close();
				} else why = t.reason;
			}
		}
		if (why || r.dirty.length) {
			const commits = why ? r.ahead : [];
			r.keep = { line: keepLine(commits, r.dirty.length, why), commits, dirty: r.dirty };
			r.keep.saved = await saveLocal(exec, dir, logDir, commits, r.dirty.length > 0).catch(e => (record(logDir, `check: save failed: ${e}`), undefined));
		}
	}
	record(logDir, `check: ${v.commit.short} vs ${upstream} ${r.remoteHead?.slice(0, 7)}: ${r.incomingTotal} incoming, ${r.ahead.length} local-only, ${r.dropped.length} already upstream, ${r.dirty.length} dirty${r.keep ? ", needs keep" : ""}`);
	return r;
}

// The names of the failing tests (at most `max`, once each: bun prints every `(fail)` line again in its closing summary), for the
// owner-facing message; the counts alone do not say what broke.
export function failedTestNames(out: string, max = 3): string[] {
	const names: string[] = [];
	for (const l of out.split("\n")) {
		const m = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(l);
		const name = m?.[1]?.trim();
		if (name && !names.includes(name)) names.push(name.length > 90 ? `${name.slice(0, 89)}…` : name);
		if (names.length >= max) break;
	}
	return names;
}

let jobSeq = 0;
let job: Job | undefined;

// `how.keep`: skip the trial rebase of local commits and save them aside at once (an older client's '보관하고 새 버전 받기'). `how.auto`:
// the daily auto-apply. Both, like a plain apply, never stop at local work: it is saved and the update goes on.
export async function apply(o: Options, how: { keep?: boolean; auto?: boolean } = {}): Promise<Job> {
	if (job?.status === "running") return job;
	const { dir, remote, branch, exec, testCmd, logDir } = resolve(o);
	const upstream = `${remote}/${branch}`;
	const j: Job = { id: ++jobSeq, startedAt: new Date().toISOString(), status: "running", phase: "확인", message: "새 버전을 확인하고 있어요", steps: [] };
	job = j;
	const step = (phase: string, text: string) => {
		j.phase = phase;
		j.message = text;
		j.steps.push({ at: new Date().toISOString(), text });
		record(logDir, `update #${j.id}: ${text}`);
	};
	const end = (status: Job["status"], text: string) => {
		step(status === "updated" ? "완료" : status === "running" ? j.phase : "끝", text);
		j.status = status;
		j.endedAt = new Date().toISOString();
		if (status === "updated" || status === "current") resolvedFn?.();
		log(`self-update #${j.id}: ${status}: ${text}`);
		return j;
	};
	step("확인", `업데이트 시작 (${upstream})`);
	const c = await check(o);
	j.check = c;
	const v = c.version;
	if (!c.ok || (v.kind !== "git" && v.kind !== "tarball")) return end("failed", `확인 실패: ${c.error?.reason ?? "?"}`);
	const from = v.commit.sha;
	j.from = from;
	if (v.kind === "tarball") {
		if (!c.incomingTotal || !c.remoteHead) return end("current", `이미 최신이에요 (${v.commit.short}).`);
		return applyTarball(o, c, v, j, step, end);
	}
	if (c.blocked.length) return end("refused", `업데이트하지 않았어요. ${c.blocked.join(" ")}`);
	if (!c.incomingTotal || !c.remoteHead) return end("current", `이미 최신이에요 (${v.commit.short}).`);
	const to = c.remoteHead;
	j.to = to;

	const runTests = async (cwd: string, where: string) => {
		const gate = gateIn(cwd, testCmd);
		step("테스트", `${gate.cmd.join(" ")} 실행 중${where}`);
		const t = await exec(gate.cmd, cwd, gate.ms);
		const summary = t.out.split("\n").filter(l => /^\s*\d+ (pass|fail)\b/.test(l)).map(l => l.trim()).join(", ");
		if (t.code === 0) return { ok: true as const, summary, why: "" };
		const blocks = failureBlocks(t.out);
		if (blocks) record(logDir, `update #${j.id}: failed tests\n${blocks}`);
		record(logDir, `update #${j.id}: test output (tail)\n${t.out.split("\n").slice(-40).join("\n")}`);
		const names = failedTestNames(t.out);
		return { ok: false as const, summary, why: `테스트 실패${summary ? ` (${summary})` : ` (exit ${t.code})`}${names.length ? `: ${names.join(" / ")}` : ""}` };
	};

	// Local work: commits upstream already has are skipped; the rest is re-applied on the new version in a temporary worktree with the
	// same checks (bun install, tests) and only a clean, green result moves the live checkout. Anything else is saved first and moved
	// aside: a local edit never stops a shipped update (owner 2026-10-29: "개별 사용자가 로컬에서 수정해서 사용하는거때문에 내가 배포한
	// 업뎃이 실패하면 안됨"). Uncommitted changes come back on top below as a local patch; the rest is carried to the custom layer.
	let target = to, hard = false, failed: string | undefined, saved: Saved | undefined, note = "", testSummary = "";
	let lost: Commit[] = [];
	if (c.dropped.length) step("확인", `이미 새 버전에 있는 로컬 커밋 ${c.dropped.length}개는 건너뛰어요: ${c.dropped.slice(0, 3).map(d => d.subject.slice(0, 40)).join(" / ")}`);
	if (c.ahead.length) {
		if (how.keep) lost = c.ahead;
		else {
			step("얹기", `로컬 커밋 ${c.ahead.length}개를 임시 작업 폴더에서 새 버전 위에 얹어 봐요`);
			const t = await openTrial(exec, dir, to, c.ahead);
			if (!t.ok) failed = t.reason;
			else {
				try {
					const deps = existsSync(join(t.wt, "package.json")) ? await exec(["bun", "install"], t.wt, 10 * 60_000) : { code: 0, out: "" };
					if (deps.code !== 0) failed = `bun install 실패: ${lastLine(deps.out)}`;
					else {
						const r = await runTests(t.wt, " (임시 작업 폴더)");
						if (r.ok) [target, testSummary] = [t.sha, r.summary];
						else failed = r.why;
					}
				} finally {
					await t.close();
				}
			}
			if (failed) lost = c.ahead;
		}
	}
	if (lost.length || c.dirty.length) {
		try {
			saved = await saveLocal(exec, dir, logDir, lost, c.dirty.length > 0);
		} catch (e) {
			return end("failed", `내 수정을 보관하지 못해서 아무것도 바꾸지 않았어요: ${lastLine(String(e))}`);
		}
		step("보관", `내 수정을 보관했어요: ${[saved.branch, saved.patch, saved.dirtyPatch].filter(Boolean).join(", ")}`);
		if (failed) step("보관", `로컬 커밋 ${lost.length}개는 새 버전 위에 얹을 수 없어서 보관만 해요 — ${failed}`);
		hard = true;
		note = ` ${savedNote(saved, upstream)}`;
		j.note = note.trim();
		if (lost.length) {
			try {
				const s = await writeSavedSummary(exec, dir, o.dataDir ?? DATA_DIR, lost, saved);
				step("보관", `보관한 커밋 요약을 적었어요: ${s.file}`);
				localSavedFn?.(s);
			} catch (e) {
				record(logDir, `update #${j.id}: summary failed: ${e}`);
			}
		}
	}

	const rebased = target !== to;
	step("병합", rebased ? `${v.commit.short} → ${target.slice(0, 7)} 새 버전 위에 얹은 로컬 커밋 ${c.ahead.length}개와 함께 옮겨요` : `${v.commit.short} → ${to.slice(0, 7)} ${hard || c.dropped.length ? "새 버전으로 옮겨요" : "fast-forward"} (${c.incomingTotal}개 커밋)`);
	const m = rebased || hard || c.dropped.length ? await exec(["git", "reset", hard ? "--hard" : "--keep", target], dir, 60_000) : await exec(["git", "merge", "--ff-only", to], dir, 60_000);
	if (m.code !== 0) return end("failed", `새 버전으로 합칠 수 없어요: ${lastLine(m.out)}`);

	const back = async (why: string, deps: boolean) => {
		step("되돌리기", `${why} → ${v.commit.short}로 되돌려요`);
		// --keep moves HEAD and the files the merge changed only; it refuses rather than overwrite anything else.
		const r = await exec(["git", "reset", hard ? "--hard" : "--keep", from], dir, 60_000);
		if (r.code === 0 && hard && saved?.dirtyPatch) await exec(["git", "apply", saved.dirtyPatch], dir, 60_000);
		if (r.code !== 0) return end("failed", `${why}. 되돌리기도 실패했어요(지금 ${to.slice(0, 7)}): ${lastLine(r.out)} — 터미널에서 \`git reset --keep ${from.slice(0, 12)}\`로 되돌려 주세요.`);
		if (deps) {
			const i = await exec(["bun", "install"], dir, 10 * 60_000);
			if (i.code !== 0) step("되돌리기", `이전 의존성 bun install 실패: ${lastLine(i.out)}`);
		}
		return end("failed", `${why}. 이전 버전(${v.commit.short})에 그대로 있어요.`);
	};

	const changed = await exec(["git", "diff", "--name-only", from, target], dir, 15_000);
	const deps = changed.out.split("\n").some(f => LOCK_FILES.includes(f.trim()));
	if (deps) {
		step("의존성", "package.json/lockfile이 바뀌어 bun install을 실행해요");
		const i = await exec(["bun", "install"], dir, 10 * 60_000);
		if (i.code !== 0) return back(`bun install 실패: ${lastLine(i.out)}`, true);
	}

	if (!rebased) {
		const t = await runTests(dir, "");
		if (!t.ok) return back(t.why, deps);
		testSummary = t.summary;
	}
	// The uncommitted changes go back on top as a local patch when they still apply and the tests still pass with them; otherwise the
	// new version stays clean and the patch stays in the backup for the carry-over (docs/customization.md, Surviving updates).
	if (hard && saved?.dirtyPatch && c.dirty.length) {
		const patch = saved.dirtyPatch;
		if ((await exec(["git", "apply", "--check", patch], dir, 60_000)).code !== 0) {
			const inside = (await exec(["git", "apply", "-R", "--check", patch], dir, 60_000)).code === 0;
			note += inside ? " 로컬 수정은 이미 새 버전에 들어 있어요." : ` 로컬 수정은 새 버전과 겹쳐서 다시 얹지 않고 보관만 했어요(${patch}).`;
			step("로컬 수정", inside ? "로컬 수정은 이미 새 버전에 들어 있어요" : "로컬 수정이 새 버전과 겹쳐서 보관만 해요");
		} else {
			const a = await exec(["git", "apply", patch], dir, 60_000);
			if (a.code !== 0) note += ` 로컬 수정을 다시 얹지 못해서 보관만 했어요(${patch}).`;
			else {
				step("로컬 수정", "보관한 로컬 수정을 새 버전 위에 다시 얹었어요");
				const t = await runTests(dir, " (로컬 수정 포함)");
				if (t.ok) {
					note += " 로컬 수정은 새 버전 위에 다시 얹었어요.";
					testSummary = t.summary;
				} else {
					await exec(["git", "apply", "-R", patch], dir, 60_000);
					note += ` 로컬 수정을 얹으면 ${t.why}여서 빼고 보관만 했어요(${patch}).`;
				}
			}
		}
		j.note = note.trim();
	}
	markPending(o, { kind: "git", dir, from, to: target, deps }, step);
	const extra = `${rebased ? ` 로컬 커밋 ${c.ahead.length}개는 새 버전 위에 얹었어요.` : ""}${c.dropped.length ? ` 이미 새 버전에 있는 로컬 커밋 ${c.dropped.length}개는 건너뛰었어요.` : ""}${note}`;
	return end("updated", `${v.commit.short} → ${target.slice(0, 7)} 받았어요${testSummary ? ` (테스트 ${testSummary})` : ""}. 재시작하면 적용돼요.${extra}`);
}

type State = { lastCheck?: CheckResult; notified?: string; autoFailed?: string; autoRefused?: string };
const readState = (): State => {
	try {
		return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
	} catch {
		return {};
	}
};
const saveState = (s: State) => writeAtomic(STATE_FILE, `${JSON.stringify(s)}\n`);

// The version this process runs (captured at start), so a pulled-but-not-restarted update shows as such.
let running: Version | undefined;
let autoTimer: Timer | undefined;
let notifyFn: ((text: string, count: number) => void) | undefined;
let resolvedFn: (() => void) | undefined;
// Called when a check finds the checkout current or an update was applied: the "new version" notice is no longer true.
export const onUpdateResolved = (fn: () => void) => void (resolvedFn = fn);
// Called once after local commits were saved and moved aside: the summary file, its text and the orchestrator turn text (main.ts asks the orchestrator to re-create the personal parts).
let localSavedFn: ((s: { file: string; text: string; turn: string }) => void) | undefined;
export const onLocalSaved = (fn: (s: { file: string; text: string; turn: string }) => void) => void (localSavedFn = fn);
const settled = (c: CheckResult) => {
	if (c.ok && c.incomingTotal === 0) resolvedFn?.();
};

// What auto_apply needs from main.ts: a worklog post, an alert, and the idle restart gate (never launchctl).
export type AutoHooks = { worklog: (text: string) => void; alert: (text: string) => void; restartIdle: () => string };
let autoHooks: AutoHooks | undefined;

const autoChoice = (): string =>
	issueBlock("dotz 자동 업데이트를 어떻게 할까요?", [
		{ name: "원인 확인", result: "업데이트 로그와 저장소 상태를 보고 원인과 고칠 방법을 알려드려요." },
		{ name: "자동 업데이트 끄기", result: "자동 적용을 꺼서 새 버전 알림만 받아요. 설정 → 업데이트에서 직접 적용해요." },
	]);

// auto_apply: runs only when upstream has something new, the checkout is clean and nothing is ahead of origin (check() lists
// both as `blocked`). A failed apply is not retried for the same upstream commit; a refusal is re-evaluated daily but alerted once.
async function autoApply(o: Options, c: CheckResult, s: State, hooks: AutoHooks): Promise<void> {
	const remoteHead = c.remoteHead as string;
	const { logDir } = resolve(o);
	const short = remoteHead.slice(0, 7);
	if (s.autoFailed === remoteHead) return;
	if (c.blocked.length) {
		record(logDir, `auto-apply: refused ${short}: ${c.blocked.join(" ")}`);
		if (s.autoRefused === remoteHead) return;
		s.autoRefused = remoteHead;
		hooks.alert(`dotz 자동 업데이트를 하지 않았어요 (새 커밋 ${c.incomingTotal}개, ${short}). ${c.blocked.join(" ")}\n${autoChoice()}`);
		return;
	}
	record(logDir, `auto-apply: applying ${short}`);
	const j = await apply(o, { auto: true });
	if (j.status === "running") return;
	if (j.status === "updated") {
		delete s.autoRefused;
		delete s.autoFailed;
		hooks.worklog(`dotz를 새 버전으로 자동 업데이트했어요 (${"commit" in c.version ? c.version.commit.short : "?"} → ${short}, 커밋 ${c.incomingTotal}개, 테스트 통과).${j.note ? ` ${j.note}` : ""} 하던 일이 모두 끝나면 다시 시작해요.`);
		hooks.restartIdle();
		return;
	}
	if (j.status === "failed") s.autoFailed = remoteHead;
	if (j.status === "refused") s.autoRefused = remoteHead;
	if (j.status === "current") return;
	hooks.alert(`dotz 자동 업데이트를 하지 못했어요 (${short}): ${j.message}\n${autoChoice()}`);
}

export async function autoCheck(o: Options, hooks: AutoHooks | undefined = autoHooks): Promise<void> {
	const c = await check(o);
	const s = readState();
	s.lastCheck = c;
	settled(c);
	if (settings().auto_apply && hooks && c.ok && c.incomingTotal > 0 && c.remoteHead) {
		await autoApply(o, c, s, hooks);
		saveState(s);
		return;
	}
	if (c.ok && c.incomingTotal > 0 && c.remoteHead && s.notified !== c.remoteHead) {
		s.notified = c.remoteHead;
		const text = `새 버전이 있어요: 커밋 ${c.incomingTotal}개 (${c.incoming[0]?.subject.slice(0, 60) ?? ""}). 설정 → 업데이트에서 적용해요.${c.keep ? ` ${c.keep.line}` : ""}`;
		record(resolve(o).logDir, `auto-check: notified ${c.remoteHead.slice(0, 7)}`);
		notifyFn?.(text, c.incomingTotal);
	}
	saveState(s);
}

function schedule(o: Options): void {
	if (autoTimer) clearTimeout(autoTimer);
	autoTimer = undefined;
	const s = settings();
	if (!s.auto_check) return;
	const [h, m] = s.at.split(":").map(Number);
	const d = new Date();
	d.setHours(h, m, 0, 0);
	if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
	autoTimer = setTimeout(async () => {
		await autoCheck(o).catch(e => log(`self-update auto-check failed: ${e}`));
		schedule(o);
	}, d.getTime() - Date.now());
	trackTimer("self update check", autoTimer);
}

// The gateway's start (main.ts, once it listens): a pending update of this code is marked healthy (the marker deleted) after a quiet
// settle while /api/health answers, which ends its watchdog; a rollback the watchdog did is told once through alert, and its version is
// not auto-applied again (autoFailed). Never a second rollback: the watchdog only acts on status "pending".
export const SETTLE_MS = 45_000;
const readPending = (file: string): Pending | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Pending;
	} catch {
		return undefined;
	}
};
export function updateBoot(hooks: { alert: (text: string) => void }, o: { dir?: string; dataDir?: string; settleMs?: number; health?: () => Promise<boolean> } = {}): void {
	const dir = o.dir ?? REPO_DIR;
	const data = o.dataDir ?? DATA_DIR;
	const file = join(data, PENDING_FILE);
	const logDir = join(data, "logs");
	const m = readPending(file);
	if (!m || m.dir !== dir) return;
	if (m.status === "rolled-back" || m.status === "rollback-failed") {
		const text = m.message ?? `업데이트 ${m.to.slice(0, 7)} 가 시작되지 않아 ${m.from.slice(0, 7)}으로 되돌렸어요.`;
		record(logDir, `boot: ${text}`);
		hooks.alert(text);
		const s = readState();
		s.autoFailed = m.to;
		saveState(s);
		rmSync(file, { force: true });
		return;
	}
	if (m.status !== "pending") return;
	const health = o.health ?? (() => fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { "x-dotz-token": HUB_TOKEN }, signal: AbortSignal.timeout(5000) }).then(r => r.status === 200, () => false));
	trackTimer("update settle", setTimeout(async () => {
		if (!(await health())) return record(logDir, `boot: ${m.to.slice(0, 7)} does not answer /api/health after the settle; leaving it pending`);
		const now = readPending(file);
		if (!now || now.to !== m.to || now.at !== m.at || now.status !== "pending") return;
		rmSync(file, { force: true });
		record(logDir, `boot: update ${m.from.slice(0, 7)} -> ${m.to.slice(0, 7)} is healthy`);
	}, o.settleMs ?? SETTLE_MS));
}

export async function startSelfUpdate(notify: (text: string, count: number) => void, o: Options = { dir: REPO_DIR }, auto?: AutoHooks): Promise<void> {
	notifyFn = notify;
	gatewayWatch = { pid: process.pid, port: PORT };
	autoHooks = auto;
	running = await version(o).catch(() => undefined);
	schedule(o);
}

function setSettings(values: { auto_check?: unknown; auto_apply?: unknown; at?: unknown }, o: Options = { dir: REPO_DIR }): ReturnType<typeof settings> {
	const next: Record<string, unknown> = {};
	if (typeof values.auto_check === "boolean") next.auto_check = values.auto_check;
	if (typeof values.auto_apply === "boolean") next.auto_apply = values.auto_apply;
	if (values.at !== undefined) {
		if (typeof values.at !== "string" || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(values.at)) throw new Error("시간은 HH:MM으로 적어 주세요");
		next.at = values.at;
	}
	const disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	disk.self_update = { ...disk.self_update, ...next };
	writeAtomic(CONFIG_FILE, `${JSON.stringify(disk, null, 2)}\n`);
	(cfg as Record<string, unknown>).self_update = { ...((cfg as Record<string, unknown>).self_update as object), ...next };
	schedule(o);
	return settings();
}

type RouteDeps = { boot: string; busy: () => string[]; restartIdle: () => string; restartNow: () => string; options?: Options };
const json = (data: unknown, status = 200) => Response.json(data, { status });

// /api/update*: settings → 업데이트. Same tailnet auth as every other /api route (checked by main.ts).
export async function updateRoute(req: Request, url: URL, deps: RouteDeps): Promise<Response | undefined> {
	if (url.pathname !== "/api/update" && !url.pathname.startsWith("/api/update/")) return undefined;
	const o = deps.options ?? { dir: REPO_DIR };
	const p = url.pathname;
	if (req.method === "GET" && p === "/api/update") {
		const disk = await version(o);
		running ??= disk;
		return json({ boot: deps.boot, running, disk, lastCheck: readState().lastCheck ?? null, job: job ?? null, busy: deps.busy(), settings: settings() });
	}
	if (req.method === "POST" && p === "/api/update/check") {
		const c = await check(o);
		saveState({ ...readState(), lastCheck: c });
		settled(c);
		return json(c);
	}
	if (req.method === "POST" && p === "/api/update/apply") {
		if (job?.status === "running") return json({ error: "업데이트가 이미 진행 중이에요", job }, 409);
		const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		void apply(o, { keep: b.keep === true }).then(j => j.check && saveState({ ...readState(), lastCheck: j.check }), e => log(`self-update failed: ${e}`));
		return json({ job }, 202);
	}
	if (req.method === "POST" && p === "/api/update/restart") {
		if (job?.status === "running") return json({ error: "업데이트가 아직 진행 중이에요" }, 409);
		const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		const now = b.when === "now";
		record(join(DATA_DIR, "logs"), `restart requested (${now ? "now" : "when idle"}; busy: ${deps.busy().join(", ") || "none"})`);
		return json({ ok: true, output: now ? deps.restartNow() : deps.restartIdle() });
	}
	if (req.method === "PUT" && p === "/api/update/settings") {
		try {
			return json({ ok: true, settings: setSettings((await req.json().catch(() => ({}))) as Record<string, unknown>, o) });
		} catch (e) {
			return json({ error: (e as Error).message }, 400);
		}
	}
	return json({ error: "unknown update route" }, 404);
}

if (import.meta.main) {
	// bun hub/selfupdate.ts --check|--apply [--dir PATH] [--test-cmd SHELL]: the same flow from a terminal (prints JSON).
	const i = process.argv.indexOf("--dir");
	const t = process.argv.indexOf("--test-cmd");
	const o: Options = { dir: i > 0 ? process.argv[i + 1] : REPO_DIR, ...(t > 0 ? { testCmd: ["sh", "-c", process.argv[t + 1]] } : {}) };
	if (process.argv.includes("--apply")) console.log(JSON.stringify(await apply(o, { keep: process.argv.includes("--keep") }), null, 2));
	else if (process.argv.includes("--check")) console.log(JSON.stringify(await check(o), null, 2));
	else console.log("usage: bun hub/selfupdate.ts --check|--apply [--keep] [--dir PATH] [--test-cmd SHELL]");
}
