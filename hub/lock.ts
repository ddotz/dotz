// Single-instance lock: an exclusive SQLite transaction on `${DATA_DIR}/gateway.lock.db`, held for the whole process
// life. The kernel drops the file lock the moment the process dies (even kill -9), so there is no stale state to
// detect and a restart never waits. main.ts imports this module right after config.ts, so the lock is taken (or the
// process exits) before any other module loads and touches state.
// `${DATA_DIR}/gateway.lock` only carries the holder's pid for the "already running" message; it never decides anything.
import { Database } from "bun:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, writeAtomic } from "./config.ts";

const PID_FILE = join(DATA_DIR, "gateway.lock");

// Pid text in the info file; "?" when it is missing or unreadable.
function readPid(): string {
	try {
		return readFileSync(PID_FILE, "utf8").trim() || "?";
	} catch {
		return "?";
	}
}

// Never closed and never dropped: closing the handle (or the process ending) is what releases the lock.
let holderDb: Database | undefined;

function acquire(): void {
	try {
		const db = new Database(join(DATA_DIR, "gateway.lock.db"), { create: true });
		db.run("PRAGMA busy_timeout=0");
		db.run("PRAGMA locking_mode=EXCLUSIVE");
		db.run("BEGIN EXCLUSIVE");
		holderDb = db;
	} catch (e) {
		const err = e as { code?: string; message?: string };
		if (!(err?.code === "SQLITE_BUSY" || err?.code === "SQLITE_LOCKED" || /database is locked|SQLITE_BUSY/i.test(err?.message ?? ""))) throw e;
		const line = `another gateway is running (pid ${readPid()}); exiting`;
		console.log(line);
		log(line);
		// Exit 0 on purpose. The launchd job (dev.dotz.gateway) has KeepAlive=true, which respawns on any exit code,
		// so the code cannot stop a restart; ThrottleInterval=10 bounds it to one start per 10 s, and a clean exit with
		// one log line keeps that loop quiet until the running gateway is gone and the next start can take the lock.
		process.exit(0);
	}
	writeAtomic(PID_FILE, String(process.pid));
}

acquire();
void holderDb;

// Only remove the info file while it still holds our pid.
process.on("exit", () => {
	if (readPid() === String(process.pid)) rmSync(PID_FILE, { force: true });
});
