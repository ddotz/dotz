// One send at a time per approved draft, across processes: the CLI the bot runs for a 결정 답, a second answer replayed or tapped twice, and
// the gateway's own button all read the same draft as pending, so the status check alone lets two of them send. The claim is a file created
// with O_EXCL beside the draft store, holding the sender's pid; whoever creates it sends, the others are refused. A claim whose process is
// gone (a sender that crashed mid-send) may have sent already (the mailbox accepted the mail, the status was never written): it is not taken over
// by a plain claim, only by a caller that says the owner retried on purpose (`takeOver`). The claim holds the pid and that process's start time, so a pid the system gave
// to another process does not count as the sender. No clock and no config import (the CLIs use it).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
	const claim = contentOf(file);
	return claim === undefined ? "none" : holderOf(claim);
}

function holderOf(content: string): "live" | "dead" {
	const claim = content.split("\n", 1)[0]!.trim();
	const id = claim.split(" ", 1)[0]!, holder = Number(id), started = claim.slice(id.length + 1);
	if (!Number.isInteger(holder) || holder <= 0) return "live";
	if (!alive(holder)) return "dead";
	const now = started ? startOf(holder) : undefined;
	return now && now !== started ? "dead" : "live";
}

// The approval a run of this claim went under (hub/draft-approval.ts DraftVerdict `token`: the gateway's sealed `go`, or a pick no gateway holds), kept
// beside the claim and not removed with it: one approval lets one run through, and a sender killed mid-send leaves it behind, so a takeover cannot
// reuse it (qa-clean-8 N15).
export function claimToken(file: string): string | undefined {
	try {
		return readFileSync(`${file}.token`, "utf8").trim() || undefined;
	} catch {
		return undefined; // none kept: no run went under a token yet
	}
}
export function keepClaimToken(file: string, token: string): void {
	const tmp = `${file}.token.${process.pid}.tmp`;
	writeFileSync(tmp, token, { mode: 0o600 });
	renameSync(tmp, `${file}.token`);
}

function contentOf(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function retireDead(file: string, dead: string, mine: string): boolean {
	const lock = `${file}.takeover`;
	const tmp = `${lock}.${process.pid}.${randomUUID()}`;
	writeFileSync(tmp, ownClaim(), { mode: 0o600 });
	try {
		linkSync(tmp, lock);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		if (claimHolder(lock) === "dead") rmSync(lock, { force: true });
		return false;
	} finally {
		rmSync(tmp, { force: true });
	}
	try {
		if (contentOf(file) !== dead) return false;
		const next = `${file}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(next, mine, { mode: 0o600 });
		renameSync(next, file);
		return true;
	} finally {
		rmSync(lock, { force: true });
	}
}

/** The release function when this caller holds the claim now, undefined when another sender holds it (or died holding it and `takeOver` is not set).
 * A dead claim is replaced in place under the takeover lock (rename over it, after checking it still holds what was seen dead), so the file never
 * goes missing in between and a plain `wx` claim cannot slip in next to the taker. */
export function claimSend(file: string, takeOver = false): (() => void) | undefined {
	mkdirSync(dirname(file), { recursive: true });
	const mine = `${ownClaim()}\n${randomUUID()}`;
	const release = () => {
		if (contentOf(file) === mine) rmSync(file, { force: true });
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(file, "wx", 0o600);
			try {
				writeSync(fd, mine);
			} finally {
				closeSync(fd);
			}
			return release;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const seen = contentOf(file);
		if (seen === undefined) continue;
		if (holderOf(seen) === "live" || !takeOver) return undefined;
		return retireDead(file, seen, mine) ? release : undefined;
	}
	return undefined;
}
