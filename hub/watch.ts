// Monitoring without waking the model (as the earlier secretary's watchers and session-keeper): the gateway runs a check command on an
// interval and only reports when something happened. Failure policy from session-keeper: 2 consecutive failures -> one
// alert per watch per 12h, and one recovery note when it passes again.
// From the earlier secretary's launchd watchers (a login watcher): every check runs in its own process group under a hard SIGKILL
// deadline; a failing check may name its kind on a line `DOTZ_FAIL <kind>` and `retry` gives each kind its own wait in
// minutes (one per consecutive failure, the last repeats; an empty list stops the watch until the owner approves); and a
// watch with `approval_minutes` gates its human step (a 2FA push) on an owner-approval file that expires after that time:
// the check gets DOTZ_APPROVED=1 while it is valid, prints `DOTZ_APPROVAL_USED` once the step went out (the file is
// consumed), and `DOTZ_FAIL approval` asks the owner once until they approve (dotz_watch approve).
// Script-first, as OmO's monitor contract: the check does its own waiting and filtering and prints only what matters; every
// watch has its own state folder <DATA_DIR>/watches/<id>/ (env DOTZ_WATCH_STATE_DIR) where the check keeps its baseline, so
// the next run, also after a gateway restart, misses nothing. A watch may name a `script` (an executable file in the
// project's folder) instead of a shell `command`; the gateway runs it directly and the project page can read and edit it.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, type FSWatcher, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch as fsWatch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blockedBy } from "../extension/index.ts";
import { ensureAside, replInTab } from "./aside.ts";
import { type Relogin, relogin } from "./autologin.ts";
import { josa } from "./account-rules.ts";
import { issueBlock } from "./choices.ts";
import { cfg, DATA_DIR, log, now, paths, readJsonOrQuarantine, TZ, writeAtomic } from "./config.ts";
import { blockedByFeatures } from "./featuredirs.ts";
import { msg } from "./i18n.ts";
import { convTargetOf } from "./session-key.ts";
import { backupFile, classifyFailure, type FailClass, healTarget, type NotifyInfo, readHealNote } from "./watch-heal.ts";
import { deriveLabel, isKeyLabel, plainLabel, watchReasonKo } from "./watchtext.ts";

export type WatchOwner = { app?: string; project?: string; internal?: true };
export type Watch = {
	id: string;
	name: string;
	label?: string; // what the owner reads instead of the [a-z0-9-] name: given, else derived once (deriveLabel) and kept
	command: string;
	script?: string;
	cwd?: string;
	every_minutes: number;
	on: "change" | "match" | "fail";
	pattern?: string;
	session?: { url: string; expect?: string; refresh_hours: number; host?: string; profile?: string; login_url?: string; secret?: string };
	channels?: string[];
	/** The conversation (ch:/th:/mail:/settings: target) it was made in or for: its wake goes to that conversation's session (wakeTarget). */
	conv?: string;
	// Who the watch serves (hub/watch-scope.ts): an app instance key, a project (ch:<id> or a project folder) or the gateway's own housekeeping; none = a standalone monitor.
	owner?: WatchOwner;
	to: string;
	created: string;
	timeout_seconds?: number;
	retry?: Record<string, number[]>;
	approval_minutes?: number;
	once?: boolean; // one-shot: removed after its first change/match report; on=match fires on any matching output, also the first (a recurring watch has no flag and stays)
	paused?: boolean;
	// The owner's notification switches of this monitor (hub/watch-settings.ts): `notify: false` keeps its reports out of the bell (hub/app-off.ts newsMuted),
	// `push: false` off the phone (hub/push.ts setWatchPushOff); `discord` decides whether its own posts also go to Discord (missing: the 새 소식 class switch).
	notify?: false;
	push?: false;
	discord?: boolean;
	state: {
		hash?: string; last?: string; fails: number; failAlertAt?: number; failSince?: number; recoveredAt?: number; lastRun?: string; lastOk?: string; lastChanged?: boolean; refreshedAt?: number;
		kind?: string; kindFails?: number; nextAt?: number; paused?: string; approvalAskedAt?: number;
		reloginAt?: number; lifeMs?: number; // the last sign-in the gateway did itself, and the shortest session it has seen live
		rejected?: number; // sign-ins the site rejected since the login last held: after 2 the gateway never types it again (accounts lock)
		twoFactor?: boolean; // the site asked for a second factor: its form is never submitted again without the owner's yes (a submit may send the push)
		healing?: { at: number; tries: number }; // a heal turn is out for the check script (hub/watch-heal.ts): failing runs only count until it is checked again
		healDay?: string; healN?: number; // heal turns started on that day (install time zone), at most HEAL_MAX_TRIES
	};
};

const RUN_TIMEOUT_MS = 120_000;
// Watch commands run in zsh where it is installed (macOS default); Linux machines often have only bash, a slim one only sh.
export const watchShell = (has: (path: string) => boolean = existsSync): string => ["/bin/zsh", "/bin/bash"].find(has) ?? "/bin/sh";
const WATCH_SHELL = watchShell();
const READ_GRACE_MS = 2_000;
export const FAIL_ALERT_EVERY_MS = 12 * 3600_000;
// A watch that has failed this long in a row and in at least this many runs stops until the owner approves it again. A day, not a count of runs:
// the release-slot watch fails on purpose for a whole slot (up to 6 hours) to keep alerting, and a 1-minute watch would reach any count in minutes.
const FAIL_PAUSE_AFTER_MS = 24 * 3600_000;
const FAIL_PAUSE_RUNS = 10;
export const FAIL_ALERT_AFTER = 2; // failures in a row before the first alert
// One episode of a check that fails and passes on and off is one failure alert and one recovery. A failure that starts within the flap window
// after a recovery is the same episode: quiet, unless it lasts the window (then it is an outage again). The window is an hour, or three intervals.
const flapWindow = (w: Watch) => Math.max(3600_000, 3 * w.every_minutes * 60_000);
// The owner was told of a failure and not yet of its recovery (older state has no recoveredAt: a set failAlertAt alone means down).
const toldDown = (s: Watch["state"]) => s.failAlertAt !== undefined && !(s.recoveredAt !== undefined && s.recoveredAt >= s.failAlertAt);
// A notify reason that is an issue the owner decides on: repeated failures, a stopped watch, one waiting for approval. Output changes,
// matches and "recovered" are not.
export const isWatchIssue = (reason: string): boolean => /^(?:failed \d+ times|stopped after|needs the owner)/.test(reason);
// The question says what happened when the reason is given (가격 확인: 2번 연속 실패했어요), so the 알림 row reads without opening it.
export const watchChoice = (name: string, reason = ""): string =>
	issueBlock(reason ? `${name}: ${watchReasonKo(reason).split(". ")[0]}. 어떻게 할까요?` : `모니터링 ${name}${/[가-힣]$/.test(name) ? josa(name, "을", "를") : "을(를)"} 어떻게 할까요?`, [{ name: "원인 확인", result: "출력을 보고 원인과 고칠 방법을 알려드려요." }, { name: "모니터링 끄기", result: "고칠 때까지 이 모니터링을 멈춰 둬요." }]);
const loadItems = (): Watch[] => readJsonOrQuarantine<Watch[]>(paths.watches, () => []);
const items: Watch[] = loadItems();
// A kept login signs itself in again (sessionRun), so it has the gate for the one human step: a second factor waits for the owner's yes
// (approval), and a site with no saved password stops until the owner saves one and says so (retry password: []). Older stored logins get both.
const LOGIN_APPROVAL_MINUTES = 30;
const loginGate = (w: Watch): boolean => {
	if (!w.session || (w.approval_minutes && w.retry?.password)) return false;
	w.approval_minutes ??= LOGIN_APPROVAL_MINUTES;
	w.retry = { ...w.retry, password: w.retry?.password ?? [] };
	return true;
};
if (items.map(loginGate).some(Boolean)) writeAtomic(paths.watches, `${JSON.stringify(items, null, 2)}\n`);
const SCRIPT_MAX_BYTES = 64 * 1024;
const LAST_MAX = 2000; // the last output is kept so the next change can be told as what was added or gone
const stateDir = (w: Watch) => join(DATA_DIR, "watches", w.id);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<void>>();
// The process group of a running check (approveWatch kills it to start over) and the runs cancelled that way (their result is not counted).
const killers = new Map<string, () => void>();
const cancelled = new Set<string>();
let stopped = false;
// An app the owner switched off on this install keeps its watches registered but they do not run (hub/app-off.ts); main.ts sets the check.
let offGate: (name: string) => boolean = () => false;
export const setWatchGate = (fn: (name: string) => boolean) => void (offGate = fn);
const save = () => writeAtomic(paths.watches, `${JSON.stringify(items, null, 2)}\n`);
let notify: (w: Watch, reason: string, output: string, prev?: string, info?: NotifyInfo) => void = () => {};

// Self-healing (design: a failing check script gets one model turn to fix the file; the gateway runs the same check again and a pass is one worklog line).
export const HEAL_WAIT_MS = 30 * 60_000;
const HEAL_MAX_TRIES = 2;
const HEAL_BACKUPS = 5;
const NOTE_MAX = 300;
const NOTE_POLL_MS = 20_000;
const PKG_DIR = join(import.meta.dir, "..");
let healHandler: (w: Watch, turn: string) => void = () => {};
let healedHandler: (w: Watch, note: string) => void = () => {};
export const setHealHandler = (fn: (w: Watch, turn: string) => void) => void (healHandler = fn);
export const setHealedHandler = (fn: (w: Watch, note: string) => void) => void (healedHandler = fn);
const healTimers = new Map<string, ReturnType<typeof setTimeout>>();
const healWatchers = new Map<string, FSWatcher>();
const healNotes = new Map<string, string>();
const healChecking = new Set<string>();
const notePath = (w: Watch) => join(stateDir(w), "heal-note.txt");
const failLog = (w: Watch) => join(stateDir(w), "last-fail.log");
const today = () => new Date(Date.now()).toLocaleDateString("en-CA", { timeZone: TZ });
const healTriesToday = (w: Watch) => (w.state.healDay === today() ? (w.state.healN ?? 0) : 0);
// Read at use, so a changed setting applies to the next failure.
const healEnabled = () => (Reflect.get(cfg, "watch") as { self_heal?: unknown } | undefined)?.self_heal !== false;
const readNote = (w: Watch): string => readHealNote(notePath(w), NOTE_MAX);
function stopHeal(id: string): void {
	clearTimeout(healTimers.get(id));
	healTimers.delete(id);
	healWatchers.get(id)?.close();
	healWatchers.delete(id);
}
function stopAllHeals(): void {
	for (const id of [...healTimers.keys(), ...healWatchers.keys()]) stopHeal(id);
}
// The wait for the turn: the note appearing in the state folder, or the time running out. A note already there (a restart) is taken at once.
function armHeal(w: Watch, wait: number): void {
	stopHeal(w.id);
	const at = w.state.healing?.at;
	const go = () => {
		if (healTimers.has(w.id) && w.state.healing?.at === at) void finishHeal(w);
	};
	// fs.watch can miss a write (seen on macOS when the note lands right after the watcher starts), so the note is also looked for every NOTE_POLL_MS.
	const deadline = Date.now() + wait;
	const tick = () => {
		if (readNote(w) || Date.now() >= deadline) return go();
		healTimers.set(w.id, setTimeout(tick, Math.min(NOTE_POLL_MS, deadline - Date.now())));
	};
	healTimers.set(w.id, setTimeout(tick, 0));
	try {
		healWatchers.set(w.id, fsWatch(stateDir(w), (_event, name) => {
			if ((!name || name === "heal-note.txt") && readNote(w)) go();
		}));
	} catch (error) {
		log(`watch ${w.name} self-heal: cannot watch the state folder, waiting for the time limit: ${error}`);
	}
}
const resumeHeal = (w: Watch) => {
	if (w.state.healing) armHeal(w, Math.max(0, w.state.healing.at + HEAL_WAIT_MS - Date.now()));
};
// The same check once more: the next run of the watch counts as the verdict (runOnce reads healChecking).
async function finishHeal(w: Watch): Promise<void> {
	stopHeal(w.id);
	if (stopped || !items.includes(w) || !w.state.healing) return;
	const note = readNote(w);
	healNotes.set(w.id, note);
	log(`watch ${w.name} self-heal: ${note ? "note written" : "no note after the wait"}, checking again`);
	await running.get(w.id);
	healChecking.add(w.id);
	await run(w);
	if (healChecking.delete(w.id)) {
		w.state.healing = undefined;
		healNotes.delete(w.id);
		save();
	}
}
// Backs the file up, asks for the turn and starts waiting. false = no heal (setting off, no file to fix, or today's tries are used); the caller then notifies.
function startHeal(w: Watch, output: string, code: number, cls: FailClass, tried: string): boolean {
	if (!healEnabled()) return false;
	const target = healTarget(w, PKG_DIR, DATA_DIR);
	if ("refuse" in target) {
		log(`watch ${w.name} self-heal: not started (${target.refuse})`);
		return false;
	}
	if (healTriesToday(w) >= HEAL_MAX_TRIES) {
		log(`watch ${w.name} self-heal: not started (${HEAL_MAX_TRIES} tries today)`);
		return false;
	}
	const backup = backupFile(target.file, join(stateDir(w), "heal"), HEAL_BACKUPS);
	rmSync(notePath(w), { force: true });
	const n = healTriesToday(w) + 1;
	w.state.healDay = today();
	w.state.healN = n;
	w.state.healing = { at: Date.now(), tries: n };
	save();
	log(`watch ${w.name} self-heal: turn ${n} of ${HEAL_MAX_TRIES} today for ${target.file}, backup ${backup}`);
	armHeal(w, HEAL_WAIT_MS);
	const lastOk = w.state.lastOk;
	const turn = msg().selfHealTurn({
		label: plainLabel(w.label ?? w.name), code, cls, file: target.file, backup, tail: output, lastOk,
		scriptAfterOk: lastOk ? statSync(target.file).mtimeMs > Date.parse(lastOk) : undefined,
		okLines: (w.state.last ?? "").split("\n").slice(0, 5).join("\n").slice(0, 400),
		attempt: n, max: HEAL_MAX_TRIES, notePath: notePath(w), ...(tried ? { tried } : {}),
	});
	try {
		healHandler(w, turn);
	} catch (error) {
		log(`watch ${w.name} self-heal: the turn could not be sent: ${error}`);
	}
	return true;
}

// The check gets its own process group and the deadline SIGKILLs the whole group: killing only the shell left a
// grandchild holding the output pipe, so the read waited for it (measured: `sleep 3 &` held a 0.5 s kill for 3 s).
// What the check leaves running after it exits is killed too, and the read gets a short grace after the exit.
export async function exec(argv: string[], cwd?: string, timeoutMs = RUN_TIMEOUT_MS, env?: Record<string, string>, maxOutput = 1500, onKill?: (kill: () => void) => void): Promise<{ code: number; output: string; timedOut: boolean }> {
	const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
	const killGroup = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {}
	};
	onKill?.(killGroup);
	let timedOut = false;
	const kill = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, timeoutMs);
	let stdout = "";
	let stderr = "";
	const reading = Promise.all([new Response(proc.stdout).text().then(t => (stdout = t)), new Response(proc.stderr).text().then(t => (stderr = t))]);
	const code = await proc.exited;
	clearTimeout(kill);
	killGroup();
	await Promise.race([reading, new Promise(r => setTimeout(r, READ_GRACE_MS))]);
	const output = `${stdout}${stderr ? `\n${stderr}` : ""}${timedOut ? `\n(killed after ${Math.round(timeoutMs / 1000)} s)` : ""}`;
	return { code, timedOut, output: output.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-maxOutput) };
}

const KIND = /^DOTZ_FAIL[ =:]([a-z0-9-]{1,20})\b/m;
const failKind = (output: string) => KIND.exec(output)?.[1] ?? "fail";
const approvalFile = (w: Watch) => join(DATA_DIR, "approvals", w.name);

// Valid while younger than approval_minutes. The file holds the approval time (ms), so a hand-made `touch` counts by mtime.
function approved(w: Watch): boolean {
	if (!w.approval_minutes) return false;
	const file = approvalFile(w);
	if (!existsSync(file)) return false;
	const at = Number(readFileSync(file, "utf8").trim()) || statSync(file).mtimeMs;
	if (Date.now() - at <= w.approval_minutes * 60_000) return true;
	rmSync(file, { force: true });
	log(`watch ${w.name}: owner approval expired`);
	return false;
}

// Login keeping in the owner's Aside browser, no model calls. A REPL fetch sends the stored cookies (enough to check
// the login and to extend server-side sliding sessions) but does not store Set-Cookie (measured 2026-10-16), so every
// refresh_hours a real tab load renews rotating cookies. On this machine's default profile the local Aside is started in
// the background when it is stopped (aside.ts), and the load is a background `openTab()` tab that is closed at once: the
// front app and the owner's active tabs stay as they were, so it needs no waiting. A remote host or another profile is not
// started from here and still loads the tab only while Aside is not the front app (the owner is not looking at it).
// The check, and the sign-in the gateway does itself when it finds the login lost (hub/autologin.ts). Tests swap them (setSessionIo).
type Check = (s: NonNullable<Watch["session"]>, where: string[]) => Promise<{ state: "ok" | "lost" | "error"; output: string }>;
const asideCheck: Check = async (s, where) => {
	const check = `const dz = await fetch(${JSON.stringify(s.url)}, { redirect: 'manual' }); const dzBody = dz.status === 200 ? await dz.text() : ''; const dzOk = dz.status === 200 && ${s.expect ? `new RegExp(${JSON.stringify(s.expect)}, 'i').test(dzBody)` : "true"}; console.log(dzOk ? 'DOTZ_SESSION_OK' : 'DOTZ_SESSION_LOST', dz.status, dz.headers.get('location') ?? '');`;
	const r = await exec(["aside", "repl", ...where, check]);
	return { state: r.output.includes("DOTZ_SESSION_OK") ? "ok" : r.output.includes("DOTZ_SESSION_LOST") ? "lost" : "error", output: r.output };
};
let checkSession: Check = asideCheck;
let signIn: Relogin = relogin;
let asideReady: () => Promise<void> = ensureAside;
let renewTab: (url: string) => Promise<unknown> = url => replInTab(url, "return 'DOTZ_REFRESHED';");
export function setSessionIo(io: { check?: Check; relogin?: Relogin; ready?: () => Promise<void>; renew?: (url: string) => Promise<unknown> }): void {
	checkSession = io.check ?? asideCheck;
	signIn = io.relogin ?? relogin;
	asideReady = io.ready ?? ensureAside;
	renewTab = io.renew ?? (url => replInTab(url, "return 'DOTZ_REFRESHED';"));
}

// How long a login lived: from the last time it was renewed (a tab load or a sign-in) to the run that found it lost. The shortest one seen is
// kept, and the login is then checked and renewed at half of it (never under 10 minutes), so the next one is renewed before it runs out.
const MIN_GAP_MS = 10 * 60_000;
export function learnLife(state: Watch["state"], at = Date.now()): void {
	const renewed = Math.max(state.refreshedAt ?? 0, state.reloginAt ?? 0);
	if (!renewed || at <= renewed) return;
	state.lifeMs = Math.min(state.lifeMs ?? Number.POSITIVE_INFINITY, at - renewed);
}
export const sessionGapMs = (w: Pick<Watch, "every_minutes" | "session" | "state">): { check: number; refresh: number } => {
	const half = w.state.lifeMs ? Math.max(MIN_GAP_MS, w.state.lifeMs / 2) : Number.POSITIVE_INFINITY;
	return { check: Math.min(w.every_minutes * 60_000, half), refresh: Math.min((w.session?.refresh_hours ?? 6) * 3600_000, half) };
};

// Login keeping in the owner's Aside browser, no model calls. A REPL fetch sends the stored cookies (enough to check
// the login and to extend server-side sliding sessions) but does not store Set-Cookie (measured 2026-10-16), so a real tab load renews
// rotating cookies, every refresh_hours or at half the session's learned life. On this machine's default profile the local Aside is started in
// the background when it is stopped (aside.ts), and the load is a background `openTab()` tab that is closed at once: the
// front app and the owner's active tabs stay as they were, so it needs no waiting. A remote host or another profile is not
// started from here and still loads the tab only while Aside is not the front app (the owner is not looking at it).
// A lost login on this machine's default profile is signed in again right here (owner 2026-10-28): the browser's saved password, else the
// `dotz_auth` secret; a second factor only with the owner's yes (`approved`, the approval file 다시 연결 writes); a site with no password stops.
async function sessionRun(w: Watch, approvedNow = false): Promise<{ code: number; output: string }> {
	const s = w.session!;
	const where = [...(s.host ? ["--host", s.host] : []), ...(s.profile ? ["--profile", s.profile] : [])];
	const dedicated = !s.profile && (!s.host || s.host === "local");
	if (dedicated) {
		try {
			await asideReady();
		} catch (error) {
			return { code: 1, output: `check could not run: ${String(error).slice(-400)}` };
		}
	}
	const r = await checkSession(s, where);
	if (r.state === "error") return { code: 1, output: `check could not run (is Aside running?): ${r.output.slice(-400)}` };
	if (r.state === "lost") {
		const lost = `logged out: ${r.output.match(/DOTZ_SESSION_LOST.*/)?.[0] ?? "the check page answered signed out"}`;
		learnLife(w.state);
		if (!dedicated) return { code: 1, output: lost };
		if (w.state.twoFactor && !approvedNow) return { code: 1, output: `DOTZ_FAIL approval\n${lost}\nthe site asks for a second factor; 다시 연결 sends it` };
		const used = approvedNow ? "\nDOTZ_APPROVAL_USED" : "";
		if ((w.state.rejected ?? 0) >= 2) return { code: 1, output: `DOTZ_FAIL password\n${lost}\nthe site rejected the login twice: the gateway does not sign in again (accounts lock). Tell the owner; it is kept again once he signs in himself in Aside${used}` };
		// a secret removed after a rejection (or never stored) is not passed: the browser's saved password may still fill the form
		const secretFile = s.secret ? join(DATA_DIR, "secrets", s.secret) : "";
		const v = await signIn(s.login_url ?? s.url, { ...(approvedNow ? { allow2fa: true } : {}), ...(secretFile && existsSync(secretFile) ? { secret: s.secret } : {}) });
		log(`watch ${w.name}: signed out, signing in again by itself: ${v}`);
		if (v === "need-2fa") w.state.twoFactor = true;
		if (v === "need-2fa") return { code: 1, output: `DOTZ_FAIL approval\n${lost}\nthe site asks for a second factor; 다시 연결 sends it${used}` };
		if (v === "need-password") return { code: 1, output: `DOTZ_FAIL password\n${lost}\nno saved password filled the login form (Mac Passwords or dotz_auth)${used}` };
		if (v === "rejected" || v === "rejected-secret") {
			// One rejection stops the keeper (DOTZ_FAIL password pauses it with one notice); the rejected dotz_auth value is removed so nothing types it again.
			const n = (w.state.rejected = (w.state.rejected ?? 0) + 1);
			if (v === "rejected-secret") rmSync(secretFile, { force: true });
			const what = v === "rejected-secret" ? `the username or password of the dotz_auth secret ${s.secret} (removed, never typed again)` : "the password the browser filled in (Mac Passwords)";
			const next = n >= 2 ? "rejected twice: the gateway stops signing in (accounts lock). Tell the owner, do not ask again" : v === "rejected-secret" ? `ask the owner once for a new one (dotz_auth kind secret, site ${s.secret}, saying the last one was rejected), then 다시 연결` : "the owner corrects the saved password, then 다시 연결";
			return { code: 1, output: `DOTZ_FAIL password\n${lost}\nthe site rejected ${what} (rejection ${n} of 2)\n${next}${used}` };
		}
		if (v === "failed") return { code: 1, output: `${lost}\nsigning in again did not finish${used}` };
		const again = await checkSession(s, where);
		if (again.state !== "ok") return { code: 1, output: `${lost}\nsigned in, but the check page still answers signed out${used}` };
		w.state.reloginAt = Date.now();
		w.state.rejected = undefined;
		return { code: 0, output: `logged in (signed in again by the gateway)${used}` };
	}
	w.state.rejected = undefined;
	const due = !w.state.refreshedAt || Date.now() - w.state.refreshedAt > sessionGapMs(w).refresh;
	if (due) {
		if (dedicated) {
			try {
				await renewTab(s.url);
				w.state.refreshedAt = Date.now();
				log(`watch ${w.name} refreshed cookies with a background tab load`);
			} catch (error) {
				log(`watch ${w.name} tab refresh failed: ${String(error).slice(-300)}`);
			}
		} else {
			const front = s.host && s.host !== "local" ? { code: 0, output: "remote host" } : await exec(["osascript", "-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
			if (front.code === 0 && front.output !== "Aside") {
				const t = await exec(["aside", "repl", ...where, `const dzTab = await openTab(${JSON.stringify(s.url)}); await closeTab(dzTab); console.log('DOTZ_REFRESHED');`]);
				if (t.output.includes("DOTZ_REFRESHED")) {
					w.state.refreshedAt = Date.now();
					log(`watch ${w.name} refreshed cookies with a tab load`);
				} else log(`watch ${w.name} tab refresh failed: ${t.output.slice(-300)}`);
			} else log(`watch ${w.name} tab refresh postponed (front app: ${front.code === 0 ? front.output : `unknown, ${front.output.slice(-200)}`})`);
		}
	}
	return { code: 0, output: "logged in" };
}

let asideQueue: Promise<unknown> = Promise.resolve();
function serialSessionRun(w: Watch, approvedNow: boolean): Promise<{ code: number; output: string }> {
	const next = asideQueue.then(() => sessionRun(w, approvedNow));
	asideQueue = next.catch(() => undefined);
	return next;
}

// One run at a time per watch; a caller asking while one is in flight gets that run. Every run arms the next one.
function run(w: Watch): Promise<void> {
	const busy = running.get(w.id);
	if (busy) return busy;
	const p = runOnce(w).finally(() => {
		running.delete(w.id);
		save();
		if (!stopped && items.includes(w)) arm(w);
	});
	running.set(w.id, p);
	return p;
}

async function runOnce(w: Watch): Promise<void> {
	try {
		if (w.paused || offGate(w.name)) return;
		const ok = approved(w);
		if (w.state.paused && !ok) return;
		if (w.state.paused) w.state.paused = undefined;
		mkdirSync(stateDir(w), { recursive: true });
		const env = { DOTZ_WATCH_STATE_DIR: stateDir(w), ...(w.approval_minutes ? { DOTZ_APPROVED: ok ? "1" : "0", DOTZ_APPROVAL_FILE: approvalFile(w) } : {}) };
		const argv = w.script ? [w.script] : [WATCH_SHELL, "-lc", w.command];
		const res = w.session ? await serialSessionRun(w, ok) : await exec(argv, w.cwd, (w.timeout_seconds ?? RUN_TIMEOUT_MS / 1000) * 1000, env, undefined, k => killers.set(w.id, k));
		const { code, output } = res;
		const timedOut = "timedOut" in res && res.timedOut === true;
		killers.delete(w.id);
		if (cancelled.delete(w.id)) {
			log(`watch ${w.name}: the running check was cancelled for a fresh approved run`);
			return;
		}
		const verifying = healChecking.delete(w.id);
		w.state.lastRun = now();
		w.state.nextAt = undefined;
		if (/^DOTZ_APPROVAL_USED\b/m.test(output)) rmSync(approvalFile(w), { force: true });
		if (code !== 0) {
			const kind = failKind(output);
			w.state.kindFails = w.state.kind === kind ? (w.state.kindFails ?? 0) + 1 : 1;
			w.state.kind = kind;
			if (!w.state.fails) w.state.failSince = Date.now();
			w.state.fails++;
			const cls = classifyFailure({ output, code, timedOut, kind });
			log(`watch ${w.name} failed (${code}, ${kind}, ${w.state.fails} in a row) ${cls}`);
			try {
				writeAtomic(failLog(w), output);
			} catch (error) {
				log(`watch ${w.name} could not write last-fail.log: ${error}`);
			}
			const info: NotifyInfo = { cls, log: failLog(w) };
			if (verifying) {
				const note = healNotes.get(w.id) ?? "";
				healNotes.delete(w.id);
				w.state.healing = undefined;
				if (cls === "script" && startHeal(w, output, code, cls, note)) return;
				log(`watch ${w.name} self-heal: the check still fails, telling the owner`);
				w.state.failAlertAt = Date.now();
				notify(w, `failed ${w.state.fails} times in a row (exit ${code})`, output, undefined, { ...info, ...(note ? { note } : {}) });
				return;
			}
			if (w.state.healing) return;
			if (kind === "approval" && w.approval_minutes) {
				if (!w.state.approvalAskedAt) {
					w.state.approvalAskedAt = Date.now();
					notify(w, w.session ? `needs the owner's approval for a second factor (다시 연결 or dotz_watch approve ${w.name}, valid ${w.approval_minutes} min)` : `needs the owner's approval first (dotz_watch approve ${w.name}, valid ${w.approval_minutes} min)`, output, undefined, info);
				}
				return;
			}
			if (w.state.fails >= FAIL_PAUSE_RUNS && Date.now() - (w.state.failSince ?? Date.now()) >= FAIL_PAUSE_AFTER_MS) {
				w.state.paused = kind;
				notify(w, `stopped after ${w.state.fails} failures in a row over a day; it runs again once the owner approves (dotz_watch approve ${w.name}) or the watch is added again`, output, undefined, info);
				return;
			}
			const wait = w.retry?.[kind];
			if (wait && !wait.length) {
				w.state.paused = kind;
				notify(w, `stopped after a ${kind} failure; it runs again once the owner approves (dotz_watch approve ${w.name}) or the watch is added again`, output, undefined, info);
				return;
			}
			if (wait) w.state.nextAt = Date.now() + wait[Math.min(wait.length, w.state.kindFails) - 1] * 60_000;
			const since = w.state.failSince ?? Date.now();
			const flapping = w.state.recoveredAt !== undefined && since - w.state.recoveredAt < flapWindow(w);
			const due = toldDown(w.state) ? Date.now() - w.state.failAlertAt! > FAIL_ALERT_EVERY_MS : !flapping || Date.now() - since >= flapWindow(w);
			if (w.state.fails >= FAIL_ALERT_AFTER && due) {
				if (cls === "script" && startHeal(w, output, code, cls, "")) return;
				w.state.failAlertAt = Date.now();
				notify(w, `failed ${w.state.fails} times in a row (exit ${code})`, output, undefined, info);
			}
			return;
		}
		const healedBy = verifying && w.state.healing ? (healNotes.get(w.id) ?? "") : undefined;
		healNotes.delete(w.id);
		if (healedBy === undefined && toldDown(w.state)) notify(w, "recovered", output);
		if (w.state.fails && w.state.failAlertAt !== undefined) w.state.recoveredAt = Date.now();
		w.state.fails = 0;
		w.state.failSince = undefined;
		w.state.kind = w.state.kindFails = w.state.approvalAskedAt = undefined;
		w.state.lastOk = now();
		if (healedBy !== undefined) {
			w.state.healing = undefined;
			log(`watch ${w.name} self-heal: the check passes again`);
			healedHandler(w, healedBy);
		}
		// a kept login with a learned life is checked again at half of it (sessionGapMs), not only every every_minutes
		if (w.session && w.state.lifeMs) w.state.nextAt = Date.now() + sessionGapMs(w).check;
		const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
		const changed = w.state.hash !== undefined && hash !== w.state.hash;
		const prev = w.state.last;
		w.state.hash = hash;
		w.state.last = output.slice(0, LAST_MAX);
		w.state.lastChanged = false;
		if (w.on === "change" && changed) {
			w.state.lastChanged = true;
			notify(w, "output changed", output, prev);
		}
		// A first output is a recurring watch's baseline (a feed's old items are not news). A once match is a gate, as a sentinel line of OmO's monitor:
		// it may print one constant line, or already hold on its first run, so the match alone is the event.
		if (w.on === "match" && (changed || w.once) && new RegExp(w.pattern!, "i").test(output)) {
			w.state.lastChanged = true;
			notify(w, `matched /${w.pattern}/`, output, prev);
		}
		if (w.once && w.state.lastChanged) {
			log(`watch ${w.name} was one-shot and has reported: removed`);
			removeWatch(w.id);
		}
	} catch (error) {
		log(`watch ${w.name} could not run: ${error}`);
	}
}

// What is left of the interval since the last run; 0 when it is overdue or never ran.
const dueIn = (w: Watch): number => {
	const last = w.state.lastRun ? Date.parse(w.state.lastRun) : Number.NaN;
	return Number.isFinite(last) ? Math.max(0, last + w.every_minutes * 60_000 - Date.now()) : 0;
};

// The next run: at the retry time a failure kind set, else every_minutes after this one. At boot (a restart has no run in
// flight) the interval counts from the last run, so an overdue watch runs at once and a restart never pushes a run back.
function arm(w: Watch, boot = false): void {
	clearTimeout(timers.get(w.id));
	if (w.paused) return;
	const wait = w.state.nextAt ? Math.max(0, w.state.nextAt - Date.now()) : boot ? dueIn(w) : w.every_minutes * 60_000;
	timers.set(w.id, setTimeout(() => void run(w), wait));
}

// Shutdown: no watch runs again.
export function stopWatches(): void {
	stopped = true;
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	stopAllHeals();
}

export function runWatch(idOrName: string): Promise<void> {
	const w = items.find(x => x.id === idOrName || x.name === idOrName);
	return w ? run(w) : Promise.resolve();
}

// The owner said yes: write the approval file (valid for approval_minutes), start a fresh round of retries, run now. A yes while
// a check of the watch is still running (다시 연결 pressed again during a login that waits on the phone) cancels that check and
// starts over with the new approval, so the owner gets a fresh second factor instead of a tap that does nothing (owner 2026-10-27).
export function approveWatch(idOrName: string): Watch {
	const w = items.find(x => x.id === idOrName || x.name === idOrName);
	if (!w) throw new Error(`no watch ${idOrName}`);
	if (!w.approval_minutes && !w.state.paused) throw new Error(`watch ${w.name} has no approval gate (add it with approval_minutes)`);
	if (w.approval_minutes) {
		mkdirSync(join(DATA_DIR, "approvals"), { recursive: true });
		writeFileSync(approvalFile(w), String(Date.now()));
	}
	if (w.state.paused && w.state.fails) w.state.failSince = Date.now(); // a stopped failure starts its day over, so one more failed run does not stop it again
	w.state.paused = w.state.approvalAskedAt = w.state.nextAt = undefined;
	w.state.kindFails = 0;
	save();
	const busy = running.get(w.id), kill = killers.get(w.id);
	if (busy && kill) {
		cancelled.add(w.id);
		kill();
		void busy.then(() => run(w));
	} else void run(w);
	return w;
}

export function startWatches(handler: typeof notify): void {
	notify = handler;
	stopped = false;   // a start after stopWatches (tests share this module) re-arms edits and resumes too
	for (const w of items) {
		arm(w, true);
		resumeHeal(w);
	}
}

// What a gateway restart does: the watches come back from watches.json (their state folders stay on disk) and are armed again.
export function reloadWatches(): void {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	stopAllHeals();
	items.splice(0, items.length, ...loadItems());
	for (const w of items) {
		arm(w, true);
		resumeHeal(w);
	}
}

// The first comment line of a script ("# 재고 확인"), which says what the check is for; "" when there is none.
function scriptHeader(path: string): string {
	try {
		if (!path.startsWith("/") || /\s/.test(path)) return "";
		for (const l of readFileSync(path, "utf8").slice(0, 2000).split("\n").slice(0, 12)) if (/^\s*(?:#|\/\/)(?!!)\s*\S/.test(l)) return l.replace(/^\s*(?:#|\/\/)\s*/, "");
	} catch {
		// unreadable: no header
	}
	return "";
}

// Gives the watches that have no readable name one, once: the name is stored, so every list, notice and bell reads the same words.
// `projectOf` is the project (channel) name a watch belongs to. Returns how many were named.
export function relabelWatches(projectOf: (w: Watch) => string | undefined): number {
	let n = 0;
	for (const w of items) {
		if (w.label && !isKeyLabel(w.label)) {
			const plain = plainLabel(w.label);
			if (plain !== w.label) { w.label = plain; n++; }
			continue;
		}
		const site = w.session ? new URL(w.session.url).hostname.replace(/^www\./, "") : undefined;
		const index = Number(/^ch-\d+-(\d+)$/.exec(w.name)?.[1]) || undefined;
		w.label = deriveLabel({ name: w.name, project: projectOf(w), header: scriptHeader(w.script ?? w.command), site, index });
		n++;
	}
	if (n) save();
	return n;
}

// The owner an add request names: `owner: {...}` or the flat app / project / internal fields (dotz_watch passes flat); a key is [a-z0-9._:~-], up to 60 chars.
const OWNER_KEY = /^[a-z0-9._:~-]{1,60}$/;
function ownerOf(input: Record<string, any>): WatchOwner | undefined {
	const given = input.owner && typeof input.owner === "object" ? input.owner : {};
	const out: WatchOwner = {};
	for (const k of ["app", "project"] as const) {
		const v = input[k] ?? given[k];
		if (v === undefined || v === null || v === "") continue;
		if (typeof v !== "string" || !OWNER_KEY.test(v)) throw new Error(`${k} must be [a-z0-9._:~-], up to 60 chars`);
		out[k] = v;
	}
	const internal = input.internal ?? given.internal;
	if (internal === true) out.internal = true;
	else if (internal !== undefined && internal !== false) throw new Error("internal must be true or false");
	return Object.keys(out).length ? out : undefined;
}

/** The target an orchestrator-bound wake is delivered to: its conversation, else its first work channel, else a ch: project; none = main. */
export const wakeTarget = (w: Watch): string | undefined => w.conv ?? (w.channels?.length ? `ch:${w.channels[0]}` : undefined) ?? (w.owner?.project?.startsWith("ch:") ? w.owner.project : undefined);

export function addWatch(input: Record<string, any>, rulesText: string): Watch {
	const name = String(input.name ?? "").trim();
	if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("name must be [a-z0-9-], up to 40 chars");
	const url = input.session_url ? String(input.session_url) : "";
	if (url && !/^https:\/\//.test(url)) throw new Error("session_url must be https://");
	if (url && input.expect) new RegExp(String(input.expect));
	const loginUrl = input.login_url ? String(input.login_url) : "";
	if (loginUrl && !/^https:\/\//.test(loginUrl)) throw new Error("login_url must be https://");
	if (input.secret !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(input.secret))) throw new Error("secret must be the dotz_auth secret's file name ([A-Za-z0-9._-])");
	const session = url ? { url, ...(input.expect ? { expect: String(input.expect) } : {}), refresh_hours: Math.max(1, Number(input.refresh_hours ?? 6)), ...(input.host ? { host: String(input.host) } : {}), ...(input.profile ? { profile: String(input.profile) } : {}), ...(loginUrl ? { login_url: loginUrl } : {}), ...(input.secret ? { secret: String(input.secret) } : {}) } : undefined;
	const script = input.script ? String(input.script) : "";
	if (script && (input.command || session)) throw new Error("give script or command, not both");
	if (script) {
		if (!script.startsWith("/")) throw new Error("script must be an absolute path");
		if (!existsSync(script) || !statSync(script).isFile()) throw new Error(`script ${script} does not exist or is not a file`);
		if (!(statSync(script).mode & 0o111)) throw new Error(`script ${script} is not executable (chmod +x)`);
	}
	const command = session ? `session check ${url}` : script || String(input.command ?? "").trim();
	if (!command) throw new Error("command, script or session_url required");
	if (session) {
		input.on = "fail";
		input.every_minutes ??= 30;
	}
	const blocked = blockedBy(command, rulesText) ?? blockedByFeatures(DATA_DIR, command)?.reason;
	if (blocked) throw new Error(`blocked by the owner's rule: ${blocked}`);
	const every = Number(input.every_minutes ?? 10);
	if (!(every >= 1)) throw new Error("every_minutes must be at least 1");
	const on = input.on === "match" || input.on === "fail" ? input.on : "change";
	if (on === "match") new RegExp(String(input.pattern ?? ""));
	if (on === "match" && !input.pattern) throw new Error("on=match needs pattern");
	const timeout = input.timeout_seconds === undefined ? undefined : Number(input.timeout_seconds);
	if (timeout !== undefined && !(timeout >= 1 && timeout <= 3600)) throw new Error("timeout_seconds must be 1-3600");
	const approval = input.approval_minutes === undefined ? undefined : Number(input.approval_minutes);
	if (approval !== undefined && !(approval >= 1 && approval <= 1440)) throw new Error("approval_minutes must be 1-1440");
	const retry = input.retry === undefined ? undefined : (input.retry as Record<string, unknown>);
	for (const [kind, wait] of Object.entries(retry ?? {})) {
		if (!/^[a-z0-9-]{1,20}$/.test(kind)) throw new Error(`retry kind ${kind} must be [a-z0-9-], up to 20 chars`);
		if (!Array.isArray(wait) || !wait.every(m => typeof m === "number" && m >= 1)) throw new Error(`retry.${kind} must be a list of minutes (>= 1 each; [] stops the watch until the owner approves)`);
	}
	const owner = ownerOf(input);
	const conv = convTargetOf({ conv: input.conv, session: input.session });
	const old = items.findIndex(w => w.name === name);
	if (old >= 0) removeWatch(items[old].id);
	const site = session ? new URL(session.url).hostname.replace(/^www\./, "") : undefined;
	const label = String(input.label ?? "").trim().slice(0, 60) || deriveLabel({ name, header: scriptHeader(script), site });
	const w: Watch = { id: randomBytes(3).toString("hex"), name, ...(label ? { label } : {}), command, ...(script ? { script } : {}), ...(input.cwd ? { cwd: String(input.cwd) } : script ? { cwd: dirname(script) } : {}), every_minutes: every, on, ...(on === "match" ? { pattern: String(input.pattern) } : {}), ...(session ? { session } : {}), ...(Array.isArray(input.channels) && input.channels.length ? { channels: input.channels.map(String) } : {}), ...(conv ? { conv } : {}), ...(owner ? { owner } : {}), to: String(input.to ?? "orchestrator"), created: now(), ...(timeout ? { timeout_seconds: timeout } : {}), ...(retry ? { retry: retry as Record<string, number[]> } : {}), ...(approval ? { approval_minutes: approval } : {}), ...(input.once === true ? { once: true } : {}), state: { fails: 0 } };
	loginGate(w);
	items.push(w);
	save();
	void run(w);
	return w;
}

export function removeWatch(idOrName: string): boolean {
	const i = items.findIndex(w => w.id === idOrName || w.name === idOrName);
	if (i < 0) return false;
	clearTimeout(timers.get(items[i].id));
	timers.delete(items[i].id);
	stopHeal(items[i].id);
	healNotes.delete(items[i].id);
	healChecking.delete(items[i].id);
	rmSync(stateDir(items[i]), { recursive: true, force: true });
	items.splice(i, 1);
	save();
	return true;
}

// The script of a script watch, for the project page. Only the file registered to the watch, only text up to 64 KB.
function scriptFile(idOrName: string): { w: Watch; path: string } {
	const w = items.find(x => x.id === idOrName || x.name === idOrName);
	if (!w) throw new Error(`no watch ${idOrName}`);
	if (!w.script) throw new Error(`watch ${w.name} is not a script watch`);
	if (!existsSync(w.script) || !statSync(w.script).isFile()) throw new Error(`script ${w.script} is gone`);
	return { w, path: realpathSync(w.script) };
}

export function watchScript(idOrName: string): { path: string; text: string } {
	const { w, path } = scriptFile(idOrName);
	if (statSync(path).size > SCRIPT_MAX_BYTES) throw new Error(`script is over ${SCRIPT_MAX_BYTES / 1024} KB`);
	const text = readFileSync(path, "utf8");
	if (text.includes("\0")) throw new Error("script is not a text file");
	return { path: w.script!, text };
}

// Atomic: write next to the file, keep its mode, rename over it. The next run (also one in flight started earlier) sees the old or the new file whole.
export function putWatchScript(idOrName: string, text: unknown): { path: string; bytes: number } {
	if (typeof text !== "string") throw new Error("text must be a string");
	if (Buffer.byteLength(text) > SCRIPT_MAX_BYTES) throw new Error(`script is over ${SCRIPT_MAX_BYTES / 1024} KB`);
	if (text.includes("\0")) throw new Error("script is not a text file");
	const shown = watchScript(idOrName).path; // refuses a script that is not text up to 64 KB, so a binary is never overwritten
	const { path } = scriptFile(idOrName);
	const mode = statSync(path).mode & 0o7777;
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	chmodSync(tmp, mode);
	renameSync(tmp, path);
	return { path: shown, bytes: Buffer.byteLength(text) };
}

export const allWatches = () => [...items];

const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const everyMinutes = (v: unknown): number => {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_EVERY_MINUTES) throw new Error(`every_minutes must be an integer from 1 to ${MAX_EVERY_MINUTES}`);
	return v;
};

// The owner's edit from the project page (PATCH /api/watches/<id>): persisted, the timer re-armed with the new interval, and
// `paused` stops the timer without deleting the watch (state.paused is the unrelated stop-until-approval of a failure kind).
export function patchWatch(idOrName: string, input: Record<string, unknown>): ReturnType<typeof listWatches>[number] {
	const w = items.find(x => x.id === idOrName || x.name === idOrName);
	if (!w) throw new Error(`no watch ${idOrName}`);
	const every = input.every_minutes === undefined ? w.every_minutes : everyMinutes(input.every_minutes);
	if (input.on !== undefined && input.on !== "change" && input.on !== "match" && input.on !== "fail") throw new Error("on must be change, match or fail");
	const on = (input.on as Watch["on"] | undefined) ?? w.on;
	if (input.pattern !== undefined && typeof input.pattern !== "string") throw new Error("pattern must be a string");
	const pattern = (input.pattern as string | undefined) ?? w.pattern;
	if (on === "match") {
		if (!pattern) throw new Error("on=match needs pattern");
		new RegExp(pattern);
	} else if (input.pattern !== undefined) throw new Error("pattern only applies to on=match");
	if (input.paused !== undefined && typeof input.paused !== "boolean") throw new Error("paused must be true or false");
	if (input.label !== undefined && (typeof input.label !== "string" || !input.label.trim() || input.label.length > 60)) throw new Error("label must be 1-60 chars");
	if (input.to !== undefined && (typeof input.to !== "string" || !/^[a-z0-9:-]{1,40}$/.test(input.to))) throw new Error("to must be orchestrator, alert or chat");
	for (const k of ["notify", "push", "discord"] as const) if (input[k] !== undefined && typeof input[k] !== "boolean") throw new Error(`${k} must be true or false`);
	if (input.notify === true) delete w.notify;
	else if (input.notify === false) w.notify = false;
	if (input.push === true) delete w.push;
	else if (input.push === false) w.push = false;
	if (input.discord !== undefined) w.discord = input.discord as boolean;
	w.every_minutes = every;
	if (input.label !== undefined) w.label = (input.label as string).trim();
	if (input.to !== undefined) w.to = input.to as string;
	w.on = on;
	if (on === "match") w.pattern = pattern;
	else delete w.pattern;
	if (input.paused !== undefined) {
		if (input.paused) w.paused = true;
		else delete w.paused;
	}
	save();
	if (w.paused) {
		clearTimeout(timers.get(w.id));
		timers.delete(w.id);
	} else if (!running.has(w.id) && !stopped) arm(w);
	return watchView(w);
}

export function setWatchChannels(id: string, channels: string[]): void {
	const w = items.find(x => x.id === id);
	if (!w) return;
	w.channels = channels;
	save();
}

// `paused` is the failure kind that stopped the watch until approval, or true when the owner paused it.
const watchView = ({ state, paused, ...w }: Watch) => ({ ...w, fails: state.fails, lastRun: state.lastRun, lastOk: state.lastOk, ...(state.kind ? { kind: state.kind } : {}), ...(state.nextAt ? { nextAt: new Date(state.nextAt).toISOString() } : {}), ...(state.paused || paused ? { paused: state.paused ?? true } : {}), ...(state.approvalAskedAt ? { awaitingApproval: true } : {}) });

export const listWatches = () => items.map(watchView);
