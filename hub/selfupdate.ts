// Self-update of the dotz checkout the gateway runs from (settings → 업데이트). The check fetches the tracked branch
// (origin/main by default) and lists what is new; the update refuses while the checkout has uncommitted changes or local
// commits that are not on origin (it names them and never discards anything), then fast-forwards only, runs `bun install`
// when package.json or the lockfile changed, runs the test suite and goes back to the old commit if the tests fail. The
// restart itself is main.ts's restart gate (waits for running turns) or, on the owner's word, an immediate restart.
// A daily check (self_update.auto_check / self_update.at in config.json) only notifies, unless self_update.auto_apply is on
// (default off): then a new upstream commit on a clean checkout with nothing ahead of origin goes through the same apply()
// (ff-only, bun install, tests, revert on failure) and the idle restart gate; a refusal or failure goes to alert with a choice block.
// Every check and update leaves lines in ~/.dotz/logs/update-YYYYMMDD.log. A non-git install (install.sh tarball)
// cannot be updated from here; the check says so and names the installer command that upgrades it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { issueBlock } from "./choices.ts";
import { CONFIG_FILE, cfg, DATA_DIR, log, writeAtomic } from "./config.ts";
import { trackTimer } from "./shutdown.ts";

export type Exec = (cmd: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; out: string }>;
export type Commit = { sha: string; short: string; date: string; subject: string };
export type Version =
	| { kind: "git"; commit: Commit; branch: string }
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
	dirty: string[];
	blocked: string[];
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
};
export type Options = {
	dir: string;
	remote?: string;
	branch?: string;
	exec?: Exec;
	testCmd?: string[];
	logDir?: string;
};

const REPO_DIR = join(import.meta.dir, "..");
const STATE_FILE = join(DATA_DIR, "self-update.json");
const LOCK_FILES = ["package.json", "bun.lock", "bun.lockb"];
const LIST_MAX = 30;
const SEP = "\x1f";

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

const parseCommits = (out: string): Commit[] =>
	out
		.split("\n")
		.filter(l => l.includes(SEP))
		.map(l => {
			const [sha, short, date, ...rest] = l.split(SEP);
			return { sha, short, date, subject: rest.join(SEP).slice(0, 200) };
		});
const FORMAT = `--format=%H${SEP}%h${SEP}%cI${SEP}%s`;

function resolve(o: Options) {
	const s = settings();
	return { dir: o.dir, remote: o.remote ?? s.remote, branch: o.branch ?? s.branch, exec: o.exec ?? defaultExec, testCmd: o.testCmd ?? ["bun", "test"], logDir: o.logDir ?? join(DATA_DIR, "logs") };
}

// The version on disk: the checked-out commit, or the install.sh stamp for a tarball install.
export async function version(o: Options): Promise<Version> {
	const { dir, exec } = resolve(o);
	if (!existsSync(join(dir, ".git"))) {
		const stamp = join(dir, ".dotz-install");
		if (!existsSync(stamp)) return { kind: "unknown", detail: "git 저장소도 install.sh 설치본도 아니에요" };
		const kv = Object.fromEntries(readFileSync(stamp, "utf8").split("\n").map(l => l.split("=", 2) as [string, string]).filter(p => p.length === 2));
		return { kind: "install", source: scrub(kv.source ?? "?"), installed: kv.installed ?? "?" };
	}
	const [c, b] = await Promise.all([exec(["git", "log", "-1", FORMAT], dir, 15_000), exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], dir, 15_000)]);
	const commit = parseCommits(c.out)[0];
	if (c.code !== 0 || !commit) return { kind: "unknown", detail: lastLine(c.out) };
	return { kind: "git", commit, branch: b.code === 0 ? b.out.trim() : "?" };
}

// Fetch the tracked branch and compare. Never changes the working tree.
export async function check(o: Options): Promise<CheckResult> {
	const { dir, remote, branch, exec, logDir } = resolve(o);
	const upstream = `${remote}/${branch}`;
	const v = await version(o);
	const base: CheckResult = { at: new Date().toISOString(), version: v, ok: false, upstream, incoming: [], incomingTotal: 0, ahead: [], dirty: [], blocked: [] };
	if (v.kind !== "git") {
		const r = {
			...base,
			error: {
				reason: v.kind === "install" ? "install.sh로 설치한 사본이라 git으로 확인할 수 없어요." : "업데이트할 수 있는 dotz 사본이 아니에요.",
				fix: "설치 스크립트를 다시 실행하면 최신으로 바뀌어요: `curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh` (비공개 저장소면 먼저 `gh auth login`)",
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
		dirty: dirty.out.split("\n").filter(Boolean).slice(0, 40),
	};
	if (v.branch !== branch) r.blocked.push(`지금 브랜치가 ${v.branch}이에요. ${branch}에서만 업데이트해요.`);
	if (r.dirty.length) r.blocked.push(`커밋하지 않은 변경 ${r.dirty.length}개가 있어요. 커밋하거나 치운 뒤 업데이트해요 (지우지 않아요).`);
	if (r.ahead.length) r.blocked.push(`${upstream}에 없는 로컬 커밋 ${r.ahead.length}개가 있어요. 먼저 push하거나 정리해 주세요 (지우지 않아요).`);
	record(logDir, `check: ${v.commit.short} vs ${upstream} ${r.remoteHead?.slice(0, 7)}: ${r.incomingTotal} incoming, ${r.ahead.length} local-only, ${r.dirty.length} dirty`);
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

export async function apply(o: Options): Promise<Job> {
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
	if (!c.ok || c.version.kind !== "git") return end("failed", `확인 실패: ${c.error?.reason ?? "?"}`);
	const from = c.version.commit.sha;
	j.from = from;
	if (c.blocked.length) {
		const what = [...c.dirty.map(d => `변경: ${d}`), ...c.ahead.map(a => `로컬 커밋: ${a.short} ${a.subject}`)].slice(0, 20);
		return end("refused", `업데이트하지 않았어요. ${c.blocked.join(" ")}${what.length ? `\n${what.join("\n")}` : ""}`);
	}
	if (!c.incomingTotal || !c.remoteHead) return end("current", `이미 최신이에요 (${c.version.commit.short}).`);
	const to = c.remoteHead;
	j.to = to;

	step("병합", `${c.version.commit.short} → ${to.slice(0, 7)} fast-forward (${c.incomingTotal}개 커밋)`);
	const m = await exec(["git", "merge", "--ff-only", to], dir, 60_000);
	if (m.code !== 0) return end("failed", `fast-forward로 합칠 수 없어요: ${lastLine(m.out)}`);

	const back = async (why: string, deps: boolean) => {
		step("되돌리기", `${why} → ${c.version.commit.short}로 되돌려요`);
		// --keep moves HEAD and the files the merge changed only; it refuses rather than overwrite anything else.
		const r = await exec(["git", "reset", "--keep", from], dir, 60_000);
		if (r.code !== 0) return end("failed", `${why}. 되돌리기도 실패했어요(지금 ${to.slice(0, 7)}): ${lastLine(r.out)} — 터미널에서 \`git reset --keep ${from.slice(0, 12)}\`로 되돌려 주세요.`);
		if (deps) {
			const i = await exec(["bun", "install"], dir, 10 * 60_000);
			if (i.code !== 0) step("되돌리기", `이전 의존성 bun install 실패: ${lastLine(i.out)}`);
		}
		return end("failed", `${why}. 이전 버전(${c.version.commit.short})에 그대로 있어요.`);
	};

	const changed = await exec(["git", "diff", "--name-only", from, to], dir, 15_000);
	const deps = changed.out.split("\n").some(f => LOCK_FILES.includes(f.trim()));
	if (deps) {
		step("의존성", "package.json/lockfile이 바뀌어 bun install을 실행해요");
		const i = await exec(["bun", "install"], dir, 10 * 60_000);
		if (i.code !== 0) return back(`bun install 실패: ${lastLine(i.out)}`, true);
	}

	step("테스트", `${testCmd.join(" ")} 실행 중`);
	const t = await exec(testCmd, dir, 20 * 60_000);
	const summary = t.out.split("\n").filter(l => /^\s*\d+ (pass|fail)\b/.test(l)).map(l => l.trim()).join(", ");
	if (t.code !== 0) {
		const blocks = failureBlocks(t.out);
		if (blocks) record(logDir, `update #${j.id}: failed tests\n${blocks}`);
		record(logDir, `update #${j.id}: test output (tail)\n${t.out.split("\n").slice(-40).join("\n")}`);
		const names = failedTestNames(t.out);
		return back(`테스트 실패${summary ? ` (${summary})` : ` (exit ${t.code})`}${names.length ? `: ${names.join(" / ")}` : ""}`, deps);
	}
	return end("updated", `${c.version.commit.short} → ${to.slice(0, 7)} 받았어요${summary ? ` (테스트 ${summary})` : ""}. 재시작하면 적용돼요.`);
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
	const j = await apply(o);
	if (j.status === "running") return;
	if (j.status === "updated") {
		delete s.autoRefused;
		delete s.autoFailed;
		hooks.worklog(`dotz를 새 버전으로 자동 업데이트했어요 (${c.version.kind === "git" ? c.version.commit.short : "?"} → ${short}, 커밋 ${c.incomingTotal}개, 테스트 통과). 하던 일이 모두 끝나면 다시 시작해요.`);
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
		const text = `dotz 새 버전이 있어요: 커밋 ${c.incomingTotal}개 (${c.incoming[0]?.subject.slice(0, 60) ?? ""}). 설정 → 업데이트에서 적용해요.`;
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

export async function startSelfUpdate(notify: (text: string, count: number) => void, o: Options = { dir: REPO_DIR }, auto?: AutoHooks): Promise<void> {
	notifyFn = notify;
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
		void apply(o).then(j => j.check && saveState({ ...readState(), lastCheck: j.check }), e => log(`self-update failed: ${e}`));
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
	// bun hub/selfupdate.ts --check|--apply [--dir PATH]: the same flow from a terminal (prints JSON).
	const i = process.argv.indexOf("--dir");
	const o: Options = { dir: i > 0 ? process.argv[i + 1] : REPO_DIR };
	if (process.argv.includes("--apply")) console.log(JSON.stringify(await apply(o), null, 2));
	else if (process.argv.includes("--check")) console.log(JSON.stringify(await check(o), null, 2));
	else console.log("usage: bun hub/selfupdate.ts --check|--apply [--dir PATH]");
}
