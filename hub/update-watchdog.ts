// The update watchdog: rolls an applied update back when the restarted gateway never comes up healthy. hub/selfupdate.ts writes
// <data>/update-pending.json after an update is applied and, when the running gateway applied it, writes a copy of THIS file (the text
// the running, old version loaded at start) to <data>/update-watchdog.ts and starts it detached (its own session, outside the service's
// process group; under systemd in a unit of its own). So the watchdog never runs from the code it may have to take back, and it covers
// every way the gateway restarts (the idle restart gate, 지금 재시작, launchctl, a crash). Self-contained on purpose: node builtins only.
//   1. wait until the gateway that applied the update (marker.gatewayPid) is gone (at most TIMES.waitMaxMs: an update never restarted is left alone);
//   2. give the new gateway TIMES.deadlineMs to mark the update healthy (hub/selfupdate.ts updateBoot deletes the marker after a quiet settle);
//   3. still pending: if anything answers HTTP on the gateway's port, wait TIMES.graceMs once more and never roll back a gateway process that
//      answered all through it; otherwise roll back once (git: `git reset --keep <from>` + bun install when the lockfiles changed; tarball: swap <dir> and
//      <dir>.prev), mark the marker rolled-back (the restored gateway posts the alert once and deletes it) and stop the gateway's
//      process so the service manager (launchd KeepAlive / systemd Restart=always) starts the restored code.
// A marker that changed (another update, a status other than pending) ends the watchdog without doing anything: one rollback at most.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Pending = {
	kind: "git" | "tarball";
	dir: string;
	from: string;
	to: string;
	prev?: string;
	deps?: boolean;
	at: string;
	status: "pending" | "rolling-back" | "rolled-back" | "rollback-failed";
	gatewayPid?: number;
	port?: number;
	message?: string;
};
export type Outcome = "superseded" | "healthy" | "answering" | "never-restarted" | "rolled-back" | "rollback-failed";
export type Deps = {
	alive: (pid: number) => boolean;
	exec: (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;
	answers: (port: number) => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	kill: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
	rename: (from: string, to: string) => void;
	// The pid of the gateway running now (gateway.lock next to the marker), to stop it after the rollback.
	runningPid: () => number | undefined;
	log: (text: string) => void;
};
export const TIMES = { pollMs: 2000, waitMaxMs: 48 * 3600_000, deadlineMs: 3 * 60_000, graceMs: 90_000, stopMs: 15_000 };

const short = (sha: string) => sha.slice(0, 7);
export const read = (file: string): Pending | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Pending;
	} catch {
		return undefined;
	}
};
const write = (file: string, p: Pending) => {
	writeFileSync(`${file}.tmp`, `${JSON.stringify(p)}\n`);
	renameSync(`${file}.tmp`, file);
};
const same = (a: Pending | undefined, b: Pending) => !!a && a.to === b.to && a.at === b.at && a.status === "pending";

export async function watch(file: string, d: Deps, t = TIMES): Promise<Outcome> {
	const m = read(file);
	if (!m || m.status !== "pending") return "superseded";
	d.log(`watchdog: update ${short(m.from)} -> ${short(m.to)} (${m.kind}), waiting for gateway pid ${m.gatewayPid ?? "-"} to restart`);
	const waitUntil = d.now() + t.waitMaxMs;
	while (m.gatewayPid && d.alive(m.gatewayPid)) {
		if (!same(read(file), m)) return "superseded";
		if (d.now() >= waitUntil) {
			d.log("watchdog: the gateway was not restarted in time; leaving the update alone");
			return "never-restarted";
		}
		await d.sleep(t.pollMs);
	}
	let until = d.now() + t.deadlineMs;
	let graced: number | undefined;
	for (;;) {
		const now = read(file);
		if (!now) return "healthy";
		if (!same(now, m)) return "superseded";
		if (d.now() >= until) {
			const answers = m.port ? await d.answers(m.port) : false;
			if (!answers) break;
			if (graced !== undefined) {
				// The same process answering all through the grace is up, whatever kept it from marking the update: never rolled back.
				// A different pid means it kept restarting (a crash loop that answers between starts): rolled back below.
				if (d.runningPid() !== graced) break;
				d.log(`watchdog: the gateway answers on port ${m.port} but did not mark ${short(m.to)} healthy; not rolling back a gateway that answers`);
				return "answering";
			}
			graced = d.runningPid() ?? -1;
			until = d.now() + t.graceMs;
		}
		await d.sleep(t.pollMs);
	}
	return rollback(file, m, d, t);
}

async function rollback(file: string, m: Pending, d: Deps, t: typeof TIMES): Promise<Outcome> {
	write(file, { ...m, status: "rolling-back" });
	d.log(`watchdog: ${short(m.to)} did not come up healthy within ${Math.round(t.deadlineMs / 1000)} s; rolling back to ${short(m.from)}`);
	let failed = "";
	if (m.kind === "git") {
		const r = await d.exec(["git", "reset", "--keep", m.from], m.dir);
		if (r.code !== 0) failed = `git reset --keep ${short(m.from)} 실패: ${r.out.trim().split("\n").pop() ?? ""} — 터미널에서 \`git -C ${m.dir} reset --keep ${m.from.slice(0, 12)}\`로 되돌려 주세요.`;
		else if (m.deps) {
			const i = await d.exec(["bun", "install"], m.dir);
			if (i.code !== 0) d.log(`watchdog: bun install after the rollback failed: ${i.out.trim().split("\n").pop() ?? ""}`);
		}
	} else {
		const prev = m.prev ?? `${m.dir}.prev`;
		const aside = `${m.dir}.rollback`;
		try {
			d.rename(m.dir, aside);
			try {
				d.rename(prev, m.dir);
			} catch (e) {
				d.rename(aside, m.dir);
				throw e;
			}
			d.rename(aside, prev);
		} catch (e) {
			failed = `폴더를 되돌리지 못했어요 (${String(e).split("\n")[0]}) — ${prev}를 ${m.dir}로 옮겨 주세요.`;
		}
	}
	const message = failed ? `업데이트 ${short(m.to)} 가 시작되지 않았는데 ${short(m.from)}으로 되돌리지 못했어요: ${failed}` : `업데이트 ${short(m.to)} 가 시작되지 않아 ${short(m.from)}으로 되돌렸어요.`;
	write(file, { ...m, status: failed ? "rollback-failed" : "rolled-back", message });
	d.log(`watchdog: ${message}`);
	const pid = d.runningPid();
	if (pid && d.alive(pid)) {
		d.kill(pid, "SIGTERM");
		const stopBy = d.now() + t.stopMs;
		while (d.alive(pid) && d.now() < stopBy) await d.sleep(500);
		if (d.alive(pid)) d.kill(pid, "SIGKILL");
		d.log(`watchdog: stopped gateway pid ${pid}; the service manager starts the ${failed ? "current" : "restored"} code`);
	}
	return failed ? "rollback-failed" : "rolled-back";
}

export function realDeps(file: string): Deps {
	const data = dirname(file);
	const logDir = join(data, "logs");
	return {
		alive: pid => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (e) {
				return (e as { code?: string }).code === "EPERM";
			}
		},
		exec: async (cmd, cwd) => {
			const p = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
			const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			return { code, out: `${out}\n${err}` };
		},
		// Any HTTP answer counts: /api/health sits behind the owner check (403 without a login), but a 403 still means the gateway is up and routing.
		answers: port => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) }).then(() => true, () => false),
		sleep: ms => Bun.sleep(ms),
		now: () => Date.now(),
		kill: (pid, sig) => {
			try {
				process.kill(pid, sig);
			} catch {
				// already gone
			}
		},
		rename: renameSync,
		runningPid: () => {
			const n = existsSync(join(data, "gateway.lock")) ? Number(readFileSync(join(data, "gateway.lock"), "utf8").trim()) : 0;
			return n > 0 ? n : undefined;
		},
		log: text => {
			try {
				mkdirSync(logDir, { recursive: true });
				appendFileSync(join(logDir, `update-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`), `${new Date().toISOString()} ${text}\n`);
			} catch {
				// nowhere to log to: the marker still carries the outcome
			}
		},
	};
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) {
		console.log("usage: bun update-watchdog.ts <data dir>/update-pending.json");
		process.exit(2);
	}
	const d = realDeps(file);
	await watch(file, d).then(o => d.log(`watchdog: done (${o})`), e => d.log(`watchdog: failed: ${e}`));
}
