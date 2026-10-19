// Single-instance lock: `${DATA_DIR}/gateway.lock` holds the pid of the running gateway. main.ts imports this module
// right after config.ts, so the lock is taken (or the process exits) before any other module loads and touches state.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log } from "./config.ts";

export const LOCK_FILE = join(DATA_DIR, "gateway.lock");

// Alive and still a gateway: after a crash the old pid can be reused by an unrelated process, which must not keep every
// new gateway exiting. The command line check is skipped (counts as a gateway) when ps cannot answer.
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (e) {
		// EPERM: the process exists but belongs to someone else.
		if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	try {
		return /hub\/main\.ts|\bdotz\b/.test(execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 }));
	} catch (e) {
		return !(e && typeof e === "object" && "status" in e && e.status === 1); // ps exits 1 when the pid is gone
	}
}

// Pid in the lock file; NaN when it is missing, empty or garbage. An empty file can be a holder between its
// exclusive create and its pid write, so that case is re-read a few times before it counts as stale.
function holder(): number {
	for (let i = 0; i < 5; i++) {
		let text = "";
		try {
			text = readFileSync(LOCK_FILE, "utf8").trim();
		} catch {
			return Number.NaN;
		}
		if (text) return /^\d+$/.test(text) ? Number(text) : Number.NaN;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	return Number.NaN;
}

function acquire(): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const fd = openSync(LOCK_FILE, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const pid = holder();
		if (pid !== process.pid && Number.isInteger(pid) && alive(pid)) {
			const line = `another gateway is running (pid ${pid}); exiting`;
			console.log(line);
			log(line);
			// Exit 0 on purpose. The launchd job (dev.dotz.gateway) has KeepAlive=true, which respawns on any exit code,
			// so the code cannot stop a restart; ThrottleInterval=10 bounds it to one start per 10 s, and a clean exit with
			// one log line keeps that loop quiet until the running gateway is gone and the next start can take the lock.
			process.exit(0);
		}
		// Dead holder, unreadable pid, or a pid that is ours (stale file from a previous life with a reused pid): take over.
		rmSync(LOCK_FILE, { force: true });
	}
	throw new Error(`cannot take ${LOCK_FILE}`);
}

acquire();

// Only remove the lock while it still holds our pid, so a take-over by a newer gateway is never undone.
process.on("exit", () => {
	if (holder() === process.pid) rmSync(LOCK_FILE, { force: true });
});
