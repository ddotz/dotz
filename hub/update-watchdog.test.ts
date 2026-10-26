// The update rollback: the watchdog (hub/update-watchdog.ts) with fake process, exec, HTTP and time, on a real marker file and real
// temp dirs for the tarball swap; and the gateway's boot side (selfupdate.ts updateBoot) on the test clock.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { advance } from "./runtime/test-clock.ts";
import { updateBoot } from "./selfupdate.ts";
import { type Deps, type Pending, read, TIMES, watch } from "./update-watchdog.ts";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
let root: string, file: string;
const marker = (p: Partial<Pending> = {}): Pending => ({ kind: "git", dir: join(root, "dotz"), from: FROM, to: TO, at: "2026-10-26T00:00:00.000Z", status: "pending", gatewayPid: 100, port: 47111, ...p });
const put = (p: Pending) => writeFileSync(file, `${JSON.stringify(p)}\n`);

// The gateway that applied the update (pid 100) exits after 10 s; whatever runs after it is `running` (a pid or nothing).
function fake(o: { running?: () => number | undefined; answers?: boolean; at?: (t: number) => void; oldExitsAt?: number } = {}) {
	let t = 0;
	const alive = new Set([100]);
	const exec: string[] = [];
	const kills: string[] = [];
	const logs: string[] = [];
	const d: Deps = {
		alive: pid => alive.has(pid) || (pid !== 100 && o.running?.() === pid && !kills.some(k => k.endsWith(` ${pid}`))),
		exec: async (cmd, cwd) => (exec.push(`${cmd.join(" ")} @${cwd}`), { code: 0, out: "" }),
		answers: async () => o.answers ?? false,
		sleep: async ms => {
			t += ms;
			if (t >= (o.oldExitsAt ?? 10_000)) alive.delete(100);
			o.at?.(t);
		},
		now: () => t,
		kill: (pid, sig) => void kills.push(`${sig} ${pid}`),
		rename: renameSync,
		runningPid: () => o.running?.(),
		log: l => void logs.push(l),
	};
	return { d, exec, kills, logs, time: () => t };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotz-watchdog-"));
	file = join(root, "update-pending.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("watchdog", () => {
	test("a git update whose gateway never marks it healthy is reset to the old commit once, 3 minutes after the restart, and the hung gateway is stopped", async () => {
		put(marker());
		let firstExecAt = 0;
		const f = fake({ running: () => 200 });
		const exec = f.d.exec;
		f.d.exec = async (cmd, cwd) => ((firstExecAt ||= f.time()), exec(cmd, cwd));
		expect(await watch(file, f.d)).toBe("rolled-back");
		expect(f.exec).toEqual([`git reset --keep ${FROM} @${join(root, "dotz")}`]);
		expect(firstExecAt).toBeGreaterThanOrEqual(10_000 + TIMES.deadlineMs);
		expect(read(file)).toMatchObject({ status: "rolled-back", message: "업데이트 bbbbbbb 가 시작되지 않아 aaaaaaa으로 되돌렸어요." });
		expect(f.kills[0]).toBe("SIGTERM 200");
		// a second watchdog on the same marker does nothing: one rollback at most
		const again = fake({ running: () => 200 });
		expect(await watch(file, again.d)).toBe("superseded");
		expect(again.exec).toEqual([]);
	});

	test("lockfile changes run bun install after the reset; a failed reset says how to fix it by hand", async () => {
		put(marker({ deps: true }));
		const f = fake();
		expect(await watch(file, f.d)).toBe("rolled-back");
		expect(f.exec.map(c => c.split(" @")[0])).toEqual([`git reset --keep ${FROM}`, "bun install"]);
		put(marker({ at: "2026-10-26T01:00:00.000Z" }));
		const g = fake();
		g.d.exec = async () => ({ code: 1, out: "error: Entry 'x' not uptodate. Cannot merge." });
		expect(await watch(file, g.d)).toBe("rollback-failed");
		expect(read(file)?.message).toContain("git -C");
	});

	test("a tarball update swaps <dir> and <dir>.prev back", async () => {
		const dir = join(root, "dotz");
		mkdirSync(dir);
		mkdirSync(`${dir}.prev`);
		writeFileSync(join(dir, "version"), "new\n");
		writeFileSync(join(`${dir}.prev`, "version"), "old\n");
		put(marker({ kind: "tarball", prev: `${dir}.prev` }));
		const f = fake();
		expect(await watch(file, f.d)).toBe("rolled-back");
		expect(readFileSync(join(dir, "version"), "utf8")).toBe("old\n");
		expect(readFileSync(join(`${dir}.prev`, "version"), "utf8")).toBe("new\n");
		expect(existsSync(`${dir}.rollback`)).toBe(false);
		expect(f.exec).toEqual([]);
	});

	test("a gateway that marks the update healthy (deletes the marker) before the deadline is never rolled back", async () => {
		put(marker());
		const f = fake({ at: t => t >= 60_000 && rmSync(file, { force: true }) });
		expect(await watch(file, f.d)).toBe("healthy");
		expect(f.exec).toEqual([]);
		expect(f.kills).toEqual([]);
	});

	test("the same gateway process answering all through the grace is left alone; one that keeps restarting is rolled back", async () => {
		put(marker());
		const steady = fake({ answers: true, running: () => 300 });
		expect(await watch(file, steady.d)).toBe("answering");
		expect(steady.exec).toEqual([]);
		expect(read(file)?.status).toBe("pending");
		let n = 400;
		const looping = fake({ answers: true, running: () => n++ });
		expect(await watch(file, looping.d)).toBe("rolled-back");
		expect(looping.exec).toHaveLength(1);
	});

	test("another update (a new marker) or a gateway never restarted ends the watchdog without a rollback", async () => {
		put(marker());
		const f = fake({ oldExitsAt: Number.POSITIVE_INFINITY, at: t => t >= 4000 && put(marker({ to: "c".repeat(40) })) });
		expect(await watch(file, f.d)).toBe("superseded");
		put(marker());
		const g = fake({ oldExitsAt: Number.POSITIVE_INFINITY });
		expect(await watch(file, g.d, { ...TIMES, waitMaxMs: 60_000 })).toBe("never-restarted");
		expect([...f.exec, ...g.exec]).toEqual([]);
	});
});

describe("updateBoot (the gateway's start)", () => {
	const dir = () => join(root, "dotz");
	test("a pending update of this code is cleared after the settle while /api/health answers, not before and not when it does not", async () => {
		put(marker());
		updateBoot({ alert: () => {} }, { dir: dir(), dataDir: root, settleMs: 45_000, health: async () => false });
		await advance(45_000);
		expect(read(file)?.status).toBe("pending");
		updateBoot({ alert: () => {} }, { dir: dir(), dataDir: root, settleMs: 45_000, health: async () => true });
		await advance(44_000);
		expect(existsSync(file)).toBe(true);
		await advance(1000);
		expect(existsSync(file)).toBe(false);
	});

	test("a marker for another code folder is left alone", async () => {
		put(marker({ dir: "/somewhere/else" }));
		updateBoot({ alert: () => {} }, { dir: dir(), dataDir: root, settleMs: 0, health: async () => true });
		await advance(1000);
		expect(read(file)?.status).toBe("pending");
	});

	test("the restored gateway tells the rollback once, and auto-apply skips that version", async () => {
		put(marker({ status: "rolled-back", message: "업데이트 bbbbbbb 가 시작되지 않아 aaaaaaa으로 되돌렸어요." }));
		const alerts: string[] = [];
		updateBoot({ alert: t => void alerts.push(t) }, { dir: dir(), dataDir: root });
		updateBoot({ alert: t => void alerts.push(t) }, { dir: dir(), dataDir: root });
		expect(alerts).toEqual(["업데이트 bbbbbbb 가 시작되지 않아 aaaaaaa으로 되돌렸어요."]);
		expect(existsSync(file)).toBe(false);
		expect(JSON.parse(readFileSync(join(DATA_DIR, "self-update.json"), "utf8")).autoFailed).toBe(TO);
	});
});
