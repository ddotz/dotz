// One send at a time per approved draft, across processes: the CLI the bot runs for a 결정 답, a second answer replayed or tapped twice, and
// the gateway's own button all read the same draft as pending, so the status check alone lets two of them send. The claim is a file created
// with O_EXCL beside the draft store, holding the sender's pid; whoever creates it sends, the others are refused. A claim whose process is
// gone (a sender that crashed mid-send) may have sent already (the mailbox accepted the mail, the status was never written): it is not taken over
// by a plain claim, only by a caller that says the owner retried on purpose (`takeOver`). Pure fs, no clock and no config import (the CLIs use it).
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

/** Who holds the claim: nobody, a sender still running, or one that died without releasing it (the send may have gone out). */
export function claimHolder(file: string): "none" | "live" | "dead" {
	let holder: number;
	try {
		holder = Number(readFileSync(file, "utf8").trim());
	} catch {
		return "none";
	}
	return !Number.isInteger(holder) || holder <= 0 || alive(holder) ? "live" : "dead";
}

// The release function when this caller holds the claim now, undefined when another sender holds it (or died holding it and `takeOver` is not set).
export function claimSend(file: string, takeOver = false): (() => void) | undefined {
	mkdirSync(dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(file, "wx", 0o600);
			try {
				writeSync(fd, String(process.pid));
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
