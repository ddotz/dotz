// Monitoring without waking the model (as 오모냥's watchers and session-keeper): the gateway runs a check command on an
// interval and only reports when something happened. Failure policy from session-keeper: 2 consecutive failures -> one
// alert per watch per 12h, and one recovery note when it passes again.
// From 오모냥's launchd watchers (a login watcher): every check runs in its own process group under a hard SIGKILL
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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blockedBy } from "../extension/index.ts";
import { ensureAside, replInTab } from "./aside.ts";
import { issueBlock } from "./choices.ts";
import { DATA_DIR, log, now, paths, writeAtomic } from "./config.ts";
import { blockedByFeatures } from "./featuredirs.ts";

export type Watch = {
	id: string;
	name: string;
	command: string;
	script?: string;
	cwd?: string;
	every_minutes: number;
	on: "change" | "match" | "fail";
	pattern?: string;
	session?: { url: string; expect?: string; refresh_hours: number; host?: string; profile?: string };
	channels?: string[];
	to: string;
	created: string;
	timeout_seconds?: number;
	retry?: Record<string, number[]>;
	approval_minutes?: number;
	paused?: boolean;
	state: {
		hash?: string; fails: number; failAlertAt?: number; lastRun?: string; lastOk?: string; lastChanged?: boolean; refreshedAt?: number;
		kind?: string; kindFails?: number; nextAt?: number; paused?: string; approvalAskedAt?: number;
	};
};

const RUN_TIMEOUT_MS = 120_000;
const READ_GRACE_MS = 2_000;
export const FAIL_ALERT_EVERY_MS = 12 * 3600_000;
export const FAIL_ALERT_AFTER = 2; // failures in a row before the first alert
// A notify reason that is an issue the owner decides on: repeated failures, a stopped watch, one waiting for approval. Output changes,
// matches and "recovered" are not.
export const isWatchIssue = (reason: string): boolean => /^(?:failed \d+ times|stopped after|needs the owner)/.test(reason);
export const watchChoice = (name: string): string =>
	issueBlock(`모니터링 ${name}을(를) 어떻게 할까요?`, [{ name: "원인 확인", result: "출력을 보고 원인과 고칠 방법을 알려드려요." }, { name: "모니터링 끄기", result: "고칠 때까지 이 모니터링을 멈춰 둬요." }]);
const loadItems = (): Watch[] => (existsSync(paths.watches) ? JSON.parse(readFileSync(paths.watches, "utf8")) : []);
const items: Watch[] = loadItems();
const SCRIPT_MAX_BYTES = 64 * 1024;
const stateDir = (w: Watch) => join(DATA_DIR, "watches", w.id);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<void>>();
let stopped = false;
const save = () => writeAtomic(paths.watches, `${JSON.stringify(items, null, 2)}\n`);
let notify: (w: Watch, reason: string, output: string) => void = () => {};

// The check gets its own process group and the deadline SIGKILLs the whole group: killing only the shell left a
// grandchild holding the output pipe, so the read waited for it (measured: `sleep 3 &` held a 0.5 s kill for 3 s).
// What the check leaves running after it exits is killed too, and the read gets a short grace after the exit.
export async function exec(argv: string[], cwd?: string, timeoutMs = RUN_TIMEOUT_MS, env?: Record<string, string>, maxOutput = 1500): Promise<{ code: number; output: string; timedOut: boolean }> {
	const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
	const killGroup = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {}
	};
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
async function sessionRun(w: Watch): Promise<{ code: number; output: string }> {
	const s = w.session!;
	const check = `const dz = await fetch(${JSON.stringify(s.url)}, { redirect: 'manual' }); const dzBody = dz.status === 200 ? await dz.text() : ''; const dzOk = dz.status === 200 && ${s.expect ? `new RegExp(${JSON.stringify(s.expect)}, 'i').test(dzBody)` : "true"}; console.log(dzOk ? 'DOTZ_SESSION_OK' : 'DOTZ_SESSION_LOST', dz.status, dz.headers.get('location') ?? '');`;
	const where = [...(s.host ? ["--host", s.host] : []), ...(s.profile ? ["--profile", s.profile] : [])];
	const dedicated = !s.profile && (!s.host || s.host === "local");
	if (dedicated) {
		try {
			await ensureAside();
		} catch (error) {
			return { code: 1, output: `check could not run: ${String(error).slice(-400)}` };
		}
	}
	const r = await exec(["aside", "repl", ...where, check]);
	if (!r.output.includes("DOTZ_SESSION_OK")) return { code: 1, output: r.output.includes("DOTZ_SESSION_LOST") ? `logged out: ${r.output.match(/DOTZ_SESSION_LOST.*/)?.[0]}` : `check could not run (is Aside running?): ${r.output.slice(-400)}` };
	const due = !w.state.refreshedAt || Date.now() - w.state.refreshedAt > s.refresh_hours * 3600_000;
	if (due) {
		if (dedicated) {
			try {
				await replInTab(s.url, "return 'DOTZ_REFRESHED';");
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
function serialSessionRun(w: Watch): Promise<{ code: number; output: string }> {
	const next = asideQueue.then(() => sessionRun(w));
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
		if (w.paused) return;
		const ok = approved(w);
		if (w.state.paused && !ok) return;
		if (w.state.paused) w.state.paused = undefined;
		mkdirSync(stateDir(w), { recursive: true });
		const env = { DOTZ_WATCH_STATE_DIR: stateDir(w), ...(w.approval_minutes ? { DOTZ_APPROVED: ok ? "1" : "0", DOTZ_APPROVAL_FILE: approvalFile(w) } : {}) };
		const argv = w.script ? [w.script] : ["/bin/zsh", "-lc", w.command];
		const { code, output } = w.session ? await serialSessionRun(w) : await exec(argv, w.cwd, (w.timeout_seconds ?? RUN_TIMEOUT_MS / 1000) * 1000, env);
		w.state.lastRun = now();
		w.state.nextAt = undefined;
		if (/^DOTZ_APPROVAL_USED\b/m.test(output)) rmSync(approvalFile(w), { force: true });
		if (code !== 0) {
			const kind = failKind(output);
			w.state.kindFails = w.state.kind === kind ? (w.state.kindFails ?? 0) + 1 : 1;
			w.state.kind = kind;
			w.state.fails++;
			log(`watch ${w.name} failed (${code}, ${kind}, ${w.state.fails} in a row)`);
			if (kind === "approval" && w.approval_minutes) {
				if (!w.state.approvalAskedAt) {
					w.state.approvalAskedAt = Date.now();
					notify(w, `needs the owner's approval first (dotz_watch approve ${w.name}, valid ${w.approval_minutes} min)`, output);
				}
				return;
			}
			const wait = w.retry?.[kind];
			if (wait && !wait.length) {
				w.state.paused = kind;
				notify(w, `stopped after a ${kind} failure; it runs again once the owner approves (dotz_watch approve ${w.name}) or the watch is added again`, output);
				return;
			}
			if (wait) w.state.nextAt = Date.now() + wait[Math.min(wait.length, w.state.kindFails) - 1] * 60_000;
			const due = !w.state.failAlertAt || Date.now() - w.state.failAlertAt > FAIL_ALERT_EVERY_MS;
			if (w.state.fails >= FAIL_ALERT_AFTER && due) {
				w.state.failAlertAt = Date.now();
				notify(w, `failed ${w.state.fails} times in a row (exit ${code})`, output);
			}
			return;
		}
		if (w.state.failAlertAt) notify(w, "recovered", output);
		w.state.fails = 0;
		w.state.failAlertAt = undefined;
		w.state.kind = w.state.kindFails = w.state.approvalAskedAt = undefined;
		w.state.lastOk = now();
		const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
		const changed = w.state.hash !== undefined && hash !== w.state.hash;
		w.state.hash = hash;
		w.state.lastChanged = false;
		if (w.on === "change" && changed) {
			w.state.lastChanged = true;
			notify(w, "output changed", output);
		}
		if (w.on === "match" && changed && new RegExp(w.pattern!, "i").test(output)) {
			w.state.lastChanged = true;
			notify(w, `matched /${w.pattern}/`, output);
		}
	} catch (error) {
		log(`watch ${w.name} could not run: ${error}`);
	}
}

// The next run: at the retry time a failure kind set, else every_minutes after this one.
function arm(w: Watch): void {
	clearTimeout(timers.get(w.id));
	if (w.paused) return;
	const wait = w.state.nextAt ? Math.max(0, w.state.nextAt - Date.now()) : w.every_minutes * 60_000;
	timers.set(w.id, setTimeout(() => void run(w), wait));
}

// Shutdown: no watch runs again.
export function stopWatches(): void {
	stopped = true;
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
}

export function runWatch(idOrName: string): Promise<void> {
	const w = items.find(x => x.id === idOrName || x.name === idOrName);
	return w ? run(w) : Promise.resolve();
}

// The owner said yes: write the approval file (valid for approval_minutes), start a fresh round of retries, run now.
export function approveWatch(idOrName: string): Watch {
	const w = items.find(x => x.id === idOrName || x.name === idOrName);
	if (!w) throw new Error(`no watch ${idOrName}`);
	if (!w.approval_minutes) throw new Error(`watch ${w.name} has no approval gate (add it with approval_minutes)`);
	mkdirSync(join(DATA_DIR, "approvals"), { recursive: true });
	writeFileSync(approvalFile(w), String(Date.now()));
	w.state.paused = w.state.approvalAskedAt = w.state.nextAt = undefined;
	w.state.kindFails = 0;
	save();
	void run(w);
	return w;
}

export function startWatches(handler: typeof notify): void {
	notify = handler;
	for (const w of items) arm(w);
}

// What a gateway restart does: the watches come back from watches.json (their state folders stay on disk) and are armed again.
export function reloadWatches(): void {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	items.splice(0, items.length, ...loadItems());
	for (const w of items) arm(w);
}

export function addWatch(input: Record<string, any>, rulesText: string): Watch {
	const name = String(input.name ?? "").trim();
	if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("name must be [a-z0-9-], up to 40 chars");
	const url = input.session_url ? String(input.session_url) : "";
	if (url && !/^https:\/\//.test(url)) throw new Error("session_url must be https://");
	if (url && input.expect) new RegExp(String(input.expect));
	const session = url ? { url, ...(input.expect ? { expect: String(input.expect) } : {}), refresh_hours: Math.max(1, Number(input.refresh_hours ?? 6)), ...(input.host ? { host: String(input.host) } : {}), ...(input.profile ? { profile: String(input.profile) } : {}) } : undefined;
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
	const old = items.findIndex(w => w.name === name);
	if (old >= 0) removeWatch(items[old].id);
	const w: Watch = { id: randomBytes(3).toString("hex"), name, command, ...(script ? { script } : {}), ...(input.cwd ? { cwd: String(input.cwd) } : script ? { cwd: dirname(script) } : {}), every_minutes: every, on, ...(on === "match" ? { pattern: String(input.pattern) } : {}), ...(session ? { session } : {}), ...(Array.isArray(input.channels) && input.channels.length ? { channels: input.channels.map(String) } : {}), to: String(input.to ?? "orchestrator"), created: now(), ...(timeout ? { timeout_seconds: timeout } : {}), ...(retry ? { retry: retry as Record<string, number[]> } : {}), ...(approval ? { approval_minutes: approval } : {}), state: { fails: 0 } };
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
	w.every_minutes = every;
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
