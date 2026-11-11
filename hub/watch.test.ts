// dotz_watch robustness from the earlier secretary's launchd watchers: process-group SIGKILL deadline, per-kind retry, owner-approval gate.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, paths } from "./config.ts";
import { advance, clock } from "./runtime/test-clock.ts";
import type { ReloginOpts, ReloginResult } from "./autologin.ts";
import { addWatch, allWatches, approveWatch, exec, learnLife, listWatches, patchWatch, putWatchScript, reloadWatches, removeWatch, runWatch, sessionGapMs, setSessionIo, startWatches, wakeTarget, watchScript, watchShell } from "./watch.ts";

const notes: { name: string; reason: string }[] = [];
let waiter: (() => void) | undefined;
const nextNote = () => new Promise<void>(r => (waiter = r));
beforeAll(() =>
	startWatches((w, reason) => {
		notes.push({ name: w.name, reason });
		waiter?.();
	}),
);
afterEach(() => {
	for (const w of allWatches()) removeWatch(w.id);
	notes.length = 0;
});
const state = (name: string) => allWatches().find(w => w.name === name)!.state;
const approval = (name: string) => join(DATA_DIR, "approvals", name);

// No wall-clock waits: the shell reports the grandchild's pid through a FIFO once it runs, and only then is the deadline
// reached. The read can only finish once every holder of the output pipe is gone (the read grace is a fake-clock timer
// nobody advances), so the run settling proves the grandchild exited; ps then sees that pid gone or a zombie, never
// running. A name match (pgrep) also saw unreaped zombies and other runs' sleeps.
test("without zsh a command runs in bash, without bash in sh, and the shell really runs it", async () => {
	expect(watchShell(p => p === "/bin/zsh" || p === "/bin/bash")).toBe("/bin/zsh");
	expect(watchShell(p => p === "/bin/bash")).toBe("/bin/bash");
	expect(watchShell(() => false)).toBe("/bin/sh");
	const { code, output } = await exec([watchShell(p => p === "/bin/bash"), "-lc", "echo ${BASH_VERSION:+bash}"], undefined, 5000);
	expect([code, output.trim()]).toEqual([0, "bash"]);
});

test("the deadline SIGKILLs the whole process group, so a background grandchild cannot hold the read", async () => {
	const fifo = join(mkdtempSync(join(tmpdir(), "dotz-pgkill-")), "pid");
	expect((await Bun.spawn(["mkfifo", fifo]).exited)).toBe(0);
	const run = exec(["/bin/sh", "-c", `sleep 600 & echo $! > ${fifo}; wait`], undefined, 1000);
	const pid = Number((await readFile(fifo, "utf8")).trim());
	expect(pid).toBeGreaterThan(0);
	await advance(1000);
	const r = await run;
	expect(r.timedOut).toBe(true);
	expect(r.output).toContain("killed after 1 s");
	const ps = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" });
	const stat = (await new Response(ps.stdout).text()).trim();
	expect(stat === "" || stat.startsWith("Z")).toBe(true);
});

test("each failure kind waits its own retry minutes, the last one repeats, and an empty list stops the watch", async () => {
	const out = join(DATA_DIR, "watch-kind.txt");
	writeFileSync(out, "DOTZ_FAIL retry\n");
	addWatch({ name: "t-retry", command: `cat '${out}'; exit 1`, on: "fail", to: "alert", retry: { retry: [2, 5], badpw: [] } }, "");
	await runWatch("t-retry");
	expect(state("t-retry")).toMatchObject({ kind: "retry", kindFails: 1, nextAt: Date.now() + 2 * 60_000 });
	await runWatch("t-retry");
	await runWatch("t-retry");
	expect(state("t-retry")).toMatchObject({ kindFails: 3, nextAt: Date.now() + 5 * 60_000 });
	writeFileSync(out, "DOTZ_FAIL badpw\n");
	await runWatch("t-retry");
	expect(state("t-retry").paused).toBe("badpw");
	expect(notes.at(-1)?.reason).toContain("stopped after a badpw failure");
	const runs = state("t-retry").lastRun;
	clock.now += 1000;
	await runWatch("t-retry");
	expect(state("t-retry").lastRun).toBe(runs);
});

test("the approval gate asks the owner once, the check sees the approval, and the step consumes it", async () => {
	const cmd = `if [ "$DOTZ_APPROVED" = 1 ]; then echo DOTZ_APPROVAL_USED; echo DOTZ_FAIL fido; exit 1; fi; echo DOTZ_FAIL approval; exit 1`;
	addWatch({ name: "t-approve", command: cmd, on: "fail", to: "alert", approval_minutes: 30, retry: { fido: [30] } }, "");
	await runWatch("t-approve");
	await runWatch("t-approve");
	expect(notes.filter(n => n.reason.includes("needs the owner's approval"))).toHaveLength(1);
	approveWatch("t-approve");
	expect(existsSync(approval("t-approve"))).toBe(true);
	await runWatch("t-approve");
	expect(existsSync(approval("t-approve"))).toBe(false);
	expect(state("t-approve")).toMatchObject({ kind: "fido", nextAt: Date.now() + 30 * 60_000 });
});

test("a second yes while the approved check still runs cancels it and starts over with the new approval", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dotz-reapprove-")), started = join(dir, "started"), finished = join(dir, "finished"), seen = join(dir, "seen"), first = join(dir, "first");
	for (const f of [started, finished]) expect(await Bun.spawn(["mkfifo", f]).exited).toBe(0);
	// The first approved run waits (a login waiting on the phone); the second one finishes at once.
	const cmd = `echo "$DOTZ_APPROVED" >> '${seen}'; if [ ! -e '${first}' ]; then touch '${first}'; echo up > '${started}'; sleep 600; fi; echo DOTZ_APPROVAL_USED; echo done > '${finished}'`;
	addWatch({ name: "t-reapprove", command: cmd, on: "fail", to: "alert", approval_minutes: 30 }, "");
	approveWatch("t-reapprove");
	expect((await readFile(started, "utf8")).trim()).toBe("up");
	approveWatch("t-reapprove");
	expect((await readFile(finished, "utf8")).trim()).toBe("done");
	// two approved runs and no third one; the cancelled run counted no failure (no runWatch here: it would start a third run)
	expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual(["1", "1"]);
	expect(state("t-reapprove").fails).toBe(0);
});

const stored = (name: string) => JSON.parse(readFileSync(paths.watches, "utf8")).find((w: { name: string }) => w.name === name);

test("a watch edit is persisted, validated, and the timer follows the new interval", async () => {
	const out = join(DATA_DIR, "watch-patch.txt");
	writeFileSync(out, "");
	const w = addWatch({ name: "t-patch", command: `echo run >> '${out}'; wc -l < '${out}'`, every_minutes: 60, on: "change", to: "alert" }, "");
	await runWatch("t-patch");
	const view = patchWatch(w.id, { every_minutes: 5, on: "match", pattern: "^2$" });
	expect(view).toMatchObject({ every_minutes: 5, on: "match", pattern: "^2$" });
	expect(stored("t-patch")).toMatchObject({ every_minutes: 5, on: "match", pattern: "^2$" });
	const second = nextNote();
	await advance(6 * 60_000);
	await second;
	expect(notes.at(-1)).toEqual({ name: "t-patch", reason: "matched /^2$/" });
	expect(readFileSync(out, "utf8")).toBe("run\nrun\n");
	expect(patchWatch("t-patch", { on: "change" })).not.toHaveProperty("pattern");
	for (const bad of [{ every_minutes: 0 }, { every_minutes: 10081 }, { every_minutes: 2.5 }, { every_minutes: "5" }, { on: "sometimes" }, { pattern: "x" }, { on: "match", pattern: "(" }, { paused: "yes" }]) expect(() => patchWatch(w.id, bad)).toThrow();
	expect(stored("t-patch")).toMatchObject({ every_minutes: 5, on: "change" });
	expect(() => patchWatch("nope", { paused: true })).toThrow("no watch");
});

test("a paused watch stays listed and persisted but stops running; resuming arms it again", async () => {
	const out = join(DATA_DIR, "watch-pause.txt");
	writeFileSync(out, "");
	const w = addWatch({ name: "t-pause", command: `echo run >> '${out}'; wc -l < '${out}'`, every_minutes: 5, on: "change", to: "alert" }, "");
	await runWatch("t-pause");
	patchWatch(w.id, { paused: true });
	await advance(30 * 60_000);
	await runWatch("t-pause");
	expect(readFileSync(out, "utf8")).toBe("run\n");
	expect(notes).toEqual([]);
	expect(listWatches().find(x => x.name === "t-pause")).toMatchObject({ paused: true });
	expect(stored("t-pause").paused).toBe(true);
	const resumed = nextNote();
	patchWatch(w.id, { paused: false });
	expect(listWatches().find(x => x.name === "t-pause")).not.toHaveProperty("paused");
	await advance(5 * 60_000);
	await resumed;
	expect(readFileSync(out, "utf8")).toBe("run\nrun\n");
});

test("an approval expires after approval_minutes", async () => {
	const seen = join(DATA_DIR, "watch-approved.txt");
	writeFileSync(seen, "");
	addWatch({ name: "t-expire", command: `echo $DOTZ_APPROVED >> '${seen}'`, on: "fail", to: "alert", approval_minutes: 30 }, "");
	await runWatch("t-expire");
	approveWatch("t-expire");
	await runWatch("t-expire");
	clock.now += 31 * 60_000;
	await runWatch("t-expire");
	expect(readFileSync(seen, "utf8")).toBe("0\n1\n0\n");
	expect(existsSync(approval("t-expire"))).toBe(false);
	expect(() => addWatch({ name: "t-bad", command: "true", retry: { fido: [0] } }, "")).toThrow("retry.fido");
});

const stateDirOf = (id: string) => join(DATA_DIR, "watches", id);
const script = (body: string, mode = 0o755) => {
	const file = join(mkdtempSync(join(tmpdir(), "dotz-script-")), "check.sh");
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, mode);
	return file;
};

test("every watch gets its own state folder (DOTZ_WATCH_STATE_DIR), a baseline there survives a gateway restart, and remove deletes the folder", async () => {
	const cmd = `n=$(cat "$DOTZ_WATCH_STATE_DIR/runs" 2>/dev/null || echo 0); echo $((n + 1)) > "$DOTZ_WATCH_STATE_DIR/runs"; echo "$DOTZ_WATCH_STATE_DIR"`;
	const w = addWatch({ name: "t-state", command: cmd, on: "fail", to: "alert" }, "");
	await runWatch("t-state");
	const dir = stateDirOf(w.id);
	expect(existsSync(dir)).toBe(true);
	expect(readFileSync(join(dir, "runs"), "utf8").trim()).toBe("1");
	expect(state("t-state").hash).toBe(new Bun.CryptoHasher("sha256").update(dir).digest("hex").slice(0, 16));
	reloadWatches();
	expect(allWatches().find(x => x.name === "t-state")?.id).toBe(w.id);
	await runWatch("t-state");
	expect(readFileSync(join(dir, "runs"), "utf8").trim()).toBe("2");
	const other = addWatch({ name: "t-state-2", command: "true", on: "fail", to: "alert" }, "");
	await runWatch("t-state-2");
	expect(stateDirOf(other.id)).not.toBe(dir);
	expect(existsSync(stateDirOf(other.id))).toBe(true);
	removeWatch("t-state");
	expect(existsSync(dir)).toBe(false);
	expect(existsSync(stateDirOf(other.id))).toBe(true);
});

test("the approval env and the state folder env reach the check together", async () => {
	const seen = join(DATA_DIR, "watch-env.txt");
	addWatch({ name: "t-env", command: `echo "$DOTZ_APPROVED $(basename "$DOTZ_WATCH_STATE_DIR")" > '${seen}'`, on: "fail", to: "alert", approval_minutes: 30 }, "");
	await runWatch("t-env");
	expect(readFileSync(seen, "utf8")).toBe(`0 ${allWatches().find(w => w.name === "t-env")!.id}\n`);
});

test("a script watch is validated, run directly in its folder with the state folder, and listed with its script", async () => {
	const file = script('pwd -P > "$DOTZ_WATCH_STATE_DIR/cwd"; echo "ran $0" >> "$DOTZ_WATCH_STATE_DIR/log"');
	for (const [bad, why] of [[{ script: "check.sh" }, "absolute"], [{ script: join(file, "..", "missing.sh") }, "does not exist"], [{ script: join(file, "..") }, "not a file"], [{ script: script("true", 0o644) }, "not executable"], [{ script: file, command: "true" }, "not both"]] as const) {
		expect(() => addWatch({ name: "t-script-bad", on: "fail", ...bad }, "")).toThrow(why);
	}
	expect(allWatches().find(w => w.name === "t-script-bad")).toBeUndefined();
	const w = addWatch({ name: "t-script", script: file, on: "fail", to: "alert" }, "");
	expect(w).toMatchObject({ script: file, command: file, cwd: join(file, "..") });
	await runWatch("t-script");
	expect(readFileSync(join(stateDirOf(w.id), "cwd"), "utf8").trim()).toBe(realpathSync(join(file, "..")));
	expect(readFileSync(join(stateDirOf(w.id), "log"), "utf8")).toBe(`ran ${file}\n`);
	expect(listWatches().find(x => x.name === "t-script")).toMatchObject({ script: file });
	expect(stored("t-script")).toMatchObject({ script: file });
	const elsewhere = addWatch({ name: "t-script-cwd", script: file, cwd: tmpdir(), on: "fail", to: "alert" }, "");
	expect(elsewhere.cwd).toBe(tmpdir());
});

test("GET returns the script of a script watch; PUT replaces it atomically, keeps its mode, and the next run uses it", async () => {
	const file = script('echo old >> "$DOTZ_WATCH_STATE_DIR/log"', 0o750);
	const w = addWatch({ name: "t-edit", script: file, on: "fail", to: "alert" }, "");
	await runWatch("t-edit");
	expect(watchScript("t-edit")).toEqual({ path: file, text: readFileSync(file, "utf8") });
	expect(putWatchScript(w.id, '#!/bin/sh\necho new >> "$DOTZ_WATCH_STATE_DIR/log"\n')).toMatchObject({ path: file });
	expect(statSync(file).mode & 0o777).toBe(0o750);
	expect(watchScript(w.id).text).toContain("echo new");
	await runWatch("t-edit");
	expect(readFileSync(join(stateDirOf(w.id), "log"), "utf8")).toBe("old\nnew\n");
	expect(() => putWatchScript("t-edit", "x".repeat(64 * 1024 + 1))).toThrow("64 KB");
	expect(() => putWatchScript("t-edit", 5)).toThrow("string");
	expect(() => putWatchScript("t-edit", "a\0b")).toThrow("text");
	expect(watchScript("t-edit").text).toContain("echo new");
	const plain = addWatch({ name: "t-plain", command: "true", on: "fail", to: "alert" }, "");
	expect(() => watchScript(plain.id)).toThrow("not a script watch");
	expect(() => putWatchScript(plain.id, "x")).toThrow("not a script watch");
	expect(() => watchScript("nope")).toThrow("no watch");
	writeFileSync(file, Buffer.from([0x7f, 0x45, 0x00, 0x4c]));
	expect(() => watchScript("t-edit")).toThrow("not a text file");
	expect(() => putWatchScript("t-edit", "#!/bin/sh\n")).toThrow("not a text file");
});

// A restart used to arm every watch a whole interval from boot, so a 120-minute watch restarted before its time never ran
// (gateway restarts at 07:38 and 07:56 left nas-php-node-patch idle for hours). At boot the interval counts from lastRun.
// Each run prints a new number, so every run after the first is a reported change; the note is the signal that a run happened.
async function bootWithLastRun(name: string, agoMinutes: number) {
	const counter = join(DATA_DIR, `watch-${name}.txt`);
	writeFileSync(counter, "0");
	addWatch({ name, command: `n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'; echo $n`, every_minutes: 120, on: "change", to: "alert" }, "");
	await runWatch(name);
	state(name).lastRun = new Date(clock.now - agoMinutes * 60_000).toISOString();
	patchWatch(name, {}); // persists the state; the timer is re-armed, then the restart replaces it
	reloadWatches();
}

test("a watch that is overdue at boot runs at once instead of a whole interval later", async () => {
	await bootWithLastRun("t-overdue", 121);
	const ran = nextNote();
	await advance(1);
	await ran;
	expect(notes).toEqual([{ name: "t-overdue", reason: "output changed" }]);
});

test("a watch that is not yet due at boot waits only what is left of its interval", async () => {
	await bootWithLastRun("t-left", 100);
	await advance(19 * 60_000);
	expect(notes).toEqual([]);
	const ran = nextNote();
	await advance(60_000);
	await ran;
	expect(notes).toEqual([{ name: "t-left", reason: "output changed" }]);
});

// A check that fails and passes on and off (a flaky network) told the owner of every failure and every recovery. Now one episode is one
// failure alert and one recovery; a failure that comes back soon after stays quiet unless it lasts the flap window (an hour here), and a
// failure after the watch has been healthy longer than that is news again.
test("a flapping watch tells the owner once per episode; a refail that lasts, or one after a healthy stretch, is news again", async () => {
	const code = join(DATA_DIR, "watch-flap.txt");
	const set = (c: number) => writeFileSync(code, String(c));
	addWatch({ name: "t-flap", command: `exit $(cat '${code}')`, every_minutes: 5, on: "fail", to: "alert" }, "");
	const step = async (c: number, minutes = 5) => {
		set(c);
		clock.now += minutes * 60_000;
		await runWatch("t-flap");
	};
	await step(1);
	await step(1);
	await step(0);
	expect(notes.map(n => n.reason)).toEqual(["failed 2 times in a row (exit 1)", "recovered"]);
	await step(1);
	await step(1);
	await step(0);
	expect(notes).toHaveLength(2);
	await step(1, 1);
	await step(1, 30);
	expect(notes).toHaveLength(2);
	await step(1, 31);
	expect(notes.at(-1)!.reason).toBe("failed 3 times in a row (exit 1)");
	await step(0);
	expect(notes.at(-1)!.reason).toBe("recovered");
	await step(1, 120);
	await step(1);
	expect(notes.map(n => n.reason)).toEqual(["failed 2 times in a row (exit 1)", "recovered", "failed 3 times in a row (exit 1)", "recovered", "failed 2 times in a row (exit 1)"]);
});

// The shape of a one-shot gate: the check fails until its condition holds, then prints one constant line. There is no second, different output
// to compare with, so the match itself is the event (dotz-rewrite-ready passed for 40 minutes unreported and was never removed).
test("a once match fires on a constant first success, after failures or at once, beside its recovery note, and is removed", async () => {
	const flag = join(DATA_DIR, "watch-gate.flag");
	rmSync(flag, { force: true });
	addWatch({ name: "t-gate", command: `[ -e '${flag}' ] && echo ready`, on: "match", pattern: "ready", to: "alert", once: true }, "");
	await runWatch("t-gate");
	await runWatch("t-gate");
	writeFileSync(flag, "");
	await runWatch("t-gate");
	expect(notes.map(n => n.reason)).toEqual(["failed 2 times in a row (exit 1)", "recovered", "matched /ready/"]);
	expect(allWatches().some(w => w.name === "t-gate")).toBe(false);
	notes.length = 0;
	addWatch({ name: "t-ready", command: "echo ready", on: "match", pattern: "ready", to: "alert", once: true }, "");
	await runWatch("t-ready");
	expect(notes).toEqual([{ name: "t-ready", reason: "matched /ready/" }]);
	expect(allWatches().some(w => w.name === "t-ready")).toBe(false);
});

test("a first output stays the baseline of a recurring match, also after failures, and of a once change watch", async () => {
	const out = join(DATA_DIR, "watch-base.txt"), steady = join(DATA_DIR, "watch-base-steady.txt");
	rmSync(out, { force: true });
	writeFileSync(steady, "old items\n");
	addWatch({ name: "t-feed", command: `cat '${out}'`, on: "match", pattern: ".", to: "alert" }, "");
	addWatch({ name: "t-once-change", command: `cat '${steady}'`, on: "change", to: "alert", once: true }, "");
	await runWatch("t-feed");
	await runWatch("t-once-change");
	writeFileSync(out, "old items\n");
	await runWatch("t-feed");
	expect(notes).toEqual([]);
	writeFileSync(out, "new item\n");
	writeFileSync(steady, "new item\n");
	await runWatch("t-feed");
	await runWatch("t-once-change");
	expect(notes.map(n => n.reason)).toEqual(["matched /./", "output changed"]);
	expect(allWatches().map(w => w.name)).toEqual(["t-feed"]);
});

// A kept login the gateway signs in again itself (hub/autologin.ts through sessionRun). The Aside check and sign-in are swapped for scripted
// ones: `answers` is what the check page says on each call, `verdicts` what each sign-in attempt ends with.
function fakeSession(answers: ("ok" | "lost")[], verdicts: ReloginResult[]) {
	const calls: { url: string; o: ReloginOpts }[] = [];
	setSessionIo({
		ready: async () => {},
		renew: async () => {},
		check: async () => ({ state: answers.shift() ?? "ok", output: "DOTZ_SESSION_LOST 302 /login" }),
		relogin: async (url, o = {}) => (calls.push({ url, o }), verdicts.shift() ?? "failed"),
	});
	return calls;
}
const addLogin = (name: string, extra: Record<string, unknown> = {}) => addWatch({ name, session_url: "https://site.example/secure", ...extra }, "");

test("a lost kept login is signed in again by the gateway: the login form and the secret are used, the check passes, nobody is told", async () => {
	const calls = fakeSession(["lost", "ok"], ["in"]);
	putSecret("site-login");
	const w = addLogin("login-relog", { login_url: "https://site.example/login", secret: "site-login" });
	await runWatch(w.name);
	expect(calls).toEqual([{ url: "https://site.example/login", o: { secret: "site-login" } }]);
	const s = state(w.name);
	expect([s.fails, !!s.lastOk, !!s.reloginAt]).toEqual([0, true, true]);
	expect(notes).toEqual([]);
	expect([w.approval_minutes, w.retry?.password]).toEqual([30, []]);
});

// a fake dotz_auth secret file (the scripted sign-in never reads it; only its presence counts)
const secretFile = (name: string) => join(DATA_DIR, "secrets", name);
function putSecret(name: string): void {
	mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
	writeFileSync(secretFile(name), "fixture\n");
}

test("a rejected dotz_auth login stops at once, its secret is removed, and a second rejection ends signing in for good", async () => {
	const calls = fakeSession(["lost", "lost", "lost", "ok", "lost"], ["rejected-secret", "rejected", "in"]);
	putSecret("bad-login");
	const w = addLogin("login-rejected", { secret: "bad-login" });
	await runWatch(w.name);
	expect([existsSync(secretFile("bad-login")), state(w.name).paused, state(w.name).rejected]).toEqual([false, "password", 1]);
	expect(notes.length).toBe(1);
	await runWatch(w.name); // paused: the same value is never typed again by the 30-minute keeper
	approveWatch(w.name); // 다시 연결 without a new value: the removed secret is not passed
	await runWatch(w.name);
	expect(calls.map(c => c.o.secret)).toEqual(["bad-login", undefined]);
	expect(state(w.name).rejected).toBe(2);
	putSecret("bad-login"); // the owner enters a new value and presses 다시 연결 again: two rejections already, nothing is typed
	approveWatch(w.name);
	await runWatch(w.name);
	expect(calls.length).toBe(2);
	expect(notes.at(-1)?.reason.startsWith("stopped after a password failure")).toBe(true);
	approveWatch(w.name); // the owner signed in himself: the check passes, the count is cleared and the keeper may sign in again
	await runWatch(w.name);
	expect(state(w.name).rejected).toBeUndefined();
	approveWatch(w.name);
	await runWatch(w.name);
	expect(calls.map(c => c.o.secret)).toEqual(["bad-login", undefined, "bad-login"]);
});

test("a login form nothing fills stops the login with one notice until the owner says 다시 연결", async () => {
	const calls = fakeSession(["lost", "lost"], ["need-password"]);
	const w = addLogin("login-nopass");
	await runWatch(w.name);
	expect([state(w.name).kind, state(w.name).paused]).toEqual(["password", "password"]);
	expect(notes.map(n => n.reason.split(";")[0])).toEqual(["stopped after a password failure"]);
	await runWatch(w.name);
	expect(calls.length).toBe(1);
	expect(notes.length).toBe(1);
});

test("a second factor is asked once, and only the owner's yes runs the sign-in that waits for it", async () => {
	const calls = fakeSession(["lost", "lost", "lost", "ok"], ["need-2fa", "in"]);
	const w = addLogin("login-2fa");
	await runWatch(w.name);
	expect(calls.map(c => c.o.allow2fa ?? false)).toEqual([false]);
	expect(notes.map(n => n.reason.slice(0, 50))).toEqual(["needs the owner's approval for a second factor (다시"]);
	await runWatch(w.name);   // waiting for the owner: the form is not submitted again (a submit could send the push), nothing new is said
	expect([calls.length, notes.length]).toEqual([1, 1]);
	approveWatch(w.name);
	await runWatch(w.name);
	expect(calls.map(c => c.o.allow2fa ?? false)).toEqual([false, true]);
	expect(state(w.name).fails).toBe(0);
	expect(existsSync(approval(w.name))).toBe(false);
});

test("a login's learned life sets its next check and renewal at half of it, never under 10 minutes", () => {
	const t0 = 1_000_000_000_000, min = 60_000;
	const st: { fails: number; refreshedAt?: number; reloginAt?: number; lifeMs?: number } = { fails: 0, refreshedAt: t0 };
	learnLife(st, t0 + 120 * min);
	expect(st.lifeMs).toBe(120 * min);
	learnLife({ ...st, refreshedAt: undefined, reloginAt: undefined }, t0);
	expect(sessionGapMs({ every_minutes: 30, session: { url: "https://x", refresh_hours: 6 }, state: st })).toEqual({ check: 30 * min, refresh: 60 * min });
	st.reloginAt = t0 + 200 * min;
	learnLife(st, t0 + 240 * min);
	expect(st.lifeMs).toBe(40 * min);
	expect(sessionGapMs({ every_minutes: 30, session: { url: "https://x", refresh_hours: 6 }, state: st })).toEqual({ check: 20 * min, refresh: 20 * min });
	st.lifeMs = 8 * min;
	expect(sessionGapMs({ every_minutes: 30, session: { url: "https://x", refresh_hours: 6 }, state: st }).check).toBe(10 * min);
});

test("a watch keeps the owner its add request names (nested or flat), and a bad key is refused", () => {
	expect(addWatch({ name: "owned-flat", command: "true", every_minutes: 60, app: "mail", internal: true }, "").owner).toEqual({ app: "mail", internal: true });
	expect(addWatch({ name: "owned-nested", command: "true", every_minutes: 60, owner: { project: "ch:42" } }, "").owner).toEqual({ project: "ch:42" });
	expect(addWatch({ name: "owner-none", command: "true", every_minutes: 60 }, "").owner).toBeUndefined();
	expect(() => addWatch({ name: "owner-bad", command: "true", every_minutes: 60, app: "Mail App" }, "")).toThrow("app must be");
	expect(() => addWatch({ name: "owner-bad", command: "true", every_minutes: 60, project: "x".repeat(61) }, "")).toThrow("project must be");
	expect(allWatches().some(w => w.name === "owner-bad")).toBe(false);
});

// A check that fails on purpose for a whole slot (the release-slot watch, up to 6 hours) must keep alerting, so only a failure that lasted a day pauses.
const failRuns = async (name: string, runs: number, gapMs: number) => {
	for (let i = 0; i < runs; i++) {
		clock.now += gapMs;
		await runWatch(name);
	}
};
const stopNotes = () => notes.filter(n => n.reason.startsWith("stopped after"));

test("a 1-minute watch that fails for 6 hours keeps running", async () => {
	addWatch({ name: "t-fail-6h", command: "exit 1", every_minutes: 1, on: "fail", to: "alert" }, "");
	await failRuns("t-fail-6h", 12, 30 * 60_000);
	expect(state("t-fail-6h").fails).toBe(12);
	expect(state("t-fail-6h").paused).toBeUndefined();
	expect(stopNotes()).toHaveLength(0);
});

test("a watch that failed for a day in 10 or more runs pauses once, tells the owner once, and approve resumes it", async () => {
	addWatch({ name: "t-fail-day", command: "exit 1", every_minutes: 1, on: "fail", to: "alert", approval_minutes: 30 }, "");
	await failRuns("t-fail-day", 12, 3 * 3600_000);
	expect(state("t-fail-day").paused).toBe("fail");
	await failRuns("t-fail-day", 2, 3600_000);
	expect(stopNotes()).toHaveLength(1);
	approveWatch("t-fail-day");
	expect(state("t-fail-day").paused).toBeUndefined();
	const before = state("t-fail-day").fails;
	await runWatch("t-fail-day");
	expect(state("t-fail-day").fails).toBeGreaterThan(before);
});

test("a day of failures in fewer than 10 runs does not pause, and a watch without an approval gate can be approved back", async () => {
	addWatch({ name: "t-fail-few", command: "exit 1", every_minutes: 1440, on: "fail", to: "alert" }, "");
	await failRuns("t-fail-few", 3, 25 * 3600_000);
	expect(state("t-fail-few").paused).toBeUndefined();
	await failRuns("t-fail-few", 8, 3600_000);
	expect(state("t-fail-few").paused).toBe("fail");
	approveWatch("t-fail-few");
	expect(state("t-fail-few").paused).toBeUndefined();
});

test("a watch made in a conversation session belongs to it; the wake target is conv, then the first channel, then a ch: project", () => {
	const inCh = addWatch({ name: "t-conv-session", command: "echo a", session: "ch:7" }, "");
	const inMain = addWatch({ name: "t-conv-main", command: "echo b", session: "main" }, "");
	const named = addWatch({ name: "t-conv-named", command: "echo c", conv: "th:4", channels: ["9"] }, "");
	const chan = addWatch({ name: "t-conv-chan", command: "echo d", channels: ["9", "8"] }, "");
	const proj = addWatch({ name: "t-conv-proj", command: "echo e", project: "ch:3" }, "");
	const folder = addWatch({ name: "t-conv-folder", command: "echo f", project: "some-folder" }, "");
	expect(inCh.conv).toBe("ch:7");
	expect(inMain.conv).toBeUndefined();
	expect([inCh, inMain, named, chan, proj, folder].map(wakeTarget)).toEqual(["ch:7", undefined, "th:4", "ch:9", "ch:3", undefined]);
	expect(() => addWatch({ name: "t-conv-bad", command: "echo g", conv: "nope" }, "")).toThrow("conv must be a conversation target");
});
