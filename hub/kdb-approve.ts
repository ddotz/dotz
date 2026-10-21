#!/usr/bin/env bun
// Check of the dotz watch `kdb-login` (hub/kdb.ts): with the owner's approval (DOTZ_APPROVED=1) and the KDB watcher
// waiting, it touches the watcher's kdb-login-approve file (the watcher logs in and sends the FIDO push within ~10 s) and
// prints DOTZ_APPROVAL_USED so dotz drops its approval; one yes is one push. Without a waiting watcher the approval is
// dropped unused, so no stale yes can start a push later. Always exits 0: the watcher posts its own alerts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { kdbConfig, waitingApproval } from "./kdb.ts";

const c = kdbConfig({ dir: process.argv[2] ?? "~/.ddotz", mail_channel: "-", alert_channel: "-" })!;
const waiting = waitingApproval(c);
if (process.env.DOTZ_APPROVED === "1") {
	if (waiting) writeFileSync(join(c.dir, "kdb-login-approve"), "");
	console.log(`DOTZ_APPROVAL_USED ${waiting ? "handed to the KDB watcher" : "dropped: the watcher is not waiting"}`);
} else console.log(waiting ? "waiting for the owner's approval" : "not waiting");
