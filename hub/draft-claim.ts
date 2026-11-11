// One send at a time per approved draft, across processes: the CLI the bot runs for a 결정 답, a second answer replayed or tapped twice, and
// the gateway's own button all read the same draft as pending, so the status check alone lets two of them send. The claim is a file created
// with O_EXCL beside the draft store, holding the sender's pid; whoever creates it sends, the others are refused. A claim whose process is
// gone (a sender that crashed mid-send) may have sent already (the mailbox accepted the mail, the status was never written): it is not taken over
// by a plain claim, only by a caller that says the owner retried on purpose (`takeOver`). The claim holds the pid and that process's start time, so a pid the system gave
// to another process does not count as the sender. No clock and no config import (the CLIs use it).
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

// When a process started, as ps says it; undefined when ps cannot say (then a claim falls back to the pid alone: a false "dead" lets a retry send next to a live sender).
const startOf = (pid: number): string | undefined => {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim() || undefined;
	} catch {
		return undefined;
	}
};
let ownStart: string | undefined;
const ownClaim = (): string => {
	ownStart ??= startOf(process.pid);
	return ownStart ? `${process.pid} ${ownStart}` : String(process.pid);
};

/** Who holds the claim: nobody, a sender still running, or one that died without releasing it (the send may have gone out). */
export function claimHolder(file: string): "none" | "live" | "dead" {
	let claim: string;
	try {
		claim = readFileSync(file, "utf8").trim();
	} catch {
		return "none";
	}
	const id = claim.split(" ", 1)[0]!, holder = Number(id), started = claim.slice(id.length + 1);
	if (!Number.isInteger(holder) || holder <= 0) return "live";
	if (!alive(holder)) return "dead";
	const now = started ? startOf(holder) : undefined;
	return now && now !== started ? "dead" : "live";
}

// The release function when this caller holds the claim now, undefined when another sender holds it (or died holding it and `takeOver` is not set).
export function claimSend(file: string, takeOver = false): (() => void) | undefined {
	mkdirSync(dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(file, "wx", 0o600);
			try {
				writeSync(fd, ownClaim());
			} finally {
				closeSync(fd);
			}
			return () => rmSync(file, { force: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const who = claimHolder(file);
		if (who === "none") continue;
		if (who === "live" || !takeOver) return undefined;
		rmSync(file, { force: true });
	}
	return undefined;
}
