// The owner's manual account pick in dotz is also OmO's own pin: auth.json "anthropic-subscription".pinned (owner 2026-10-22:
// "omo 자체 고정값을 고치면 되는거잖아?"). Only that one key changes; tokens and every other key stay as OmO wrote them.
// Verified against the OmO (senpi) bundle, dist/core/auth-storage.js: the store is JSON.stringify(data, null, 2) with no trailing
// newline (:354); a writer takes a proper-lockfile lock on the file (lock dir `<file>.lock`, stale 30 s, sync wait budget 1 s:
// :90-107, core/lockfile-policy.js), re-reads under the lock, stages `<file>.<pid>.tmp` at 0o600, copies the old mode and renames
// it over the store (:71-77). OmO sets the pin by `{ ...credential, pinned: name }` and removes it by deleting the key
// (extensions/builtin/anthropic-subscription/accounts.js:77-82). dotz follows the same steps.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountsDir } from "./account-alias.ts";
import { authFile } from "./apikey-policy.ts";
import { log, TZ } from "./config.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_BUDGET_MS = 1_000;
const SUB = "anthropic-subscription";

// What dotz itself last wrote as the pin. account-sticky.ts does not read it as "the owner pinned X in OmO" (no echo, no alert).
export const ownPinFile = () => join(accountsDir(), "omo-pin.json");
export function ownPin(): string | undefined {
	try {
		const a = JSON.parse(readFileSync(ownPinFile(), "utf8"))?.account;
		return typeof a === "string" && a ? a : undefined;
	} catch {
		return undefined;
	}
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// proper-lockfile's scheme: the lock is the directory `<file>.lock`; an old one (mtime) is stale and taken over.
function lock(file: string): () => void {
	const dir = `${file}.lock`;
	const started = Date.now();
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(dir);
			return () => {
				try {
					rmdirSync(dir);
				} catch {}
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		try {
			if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
				rmdirSync(dir);
				continue;
			}
		} catch {
			continue; // released between the two calls
		}
		const waited = Date.now() - started;
		if (waited >= LOCK_BUDGET_MS) throw new Error(`OmO의 계정 파일이 ${waited}ms 동안 잠겨 있어요 (${dir})`);
		sleep(Math.min(100 * 2 ** attempt, 1000, LOCK_BUDGET_MS - waited));
	}
}

const dayStamp = (now: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

export type PinResult = "written" | "unchanged" | "skipped";

// Sets OmO's pin to `account`, or removes it with undefined. "skipped": OmO has no subscription entry to pin in.
export function writeOmoPin(account: string | undefined, now = Date.now()): PinResult {
	const file = authFile();
	if (!existsSync(file)) return "skipped";
	mkdirSync(accountsDir(), { recursive: true });
	const release = lock(file);
	try {
		const text = readFileSync(file, "utf8"); // read under the lock, right before writing
		const data = JSON.parse(text);
		const sub = data?.[SUB];
		if (!sub || typeof sub !== "object") return "skipped";
		if (sub.pinned === account) {
			writeOwn(account);
			return "unchanged";
		}
		if (account === undefined) delete sub.pinned;
		else sub.pinned = account;
		// one backup per change-day, of the bytes before the day's first change
		const backup = `${file}.dotz-pin-backup-${dayStamp(now)}`;
		if (!existsSync(backup)) {
			copyFileSync(file, backup);
			chmodSync(backup, 0o600);
		}
		writeOwn(account); // before the file changes, so the change is never seen without it
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(data, null, 2)}${text.endsWith("\n") ? "\n" : ""}`, { mode: 0o600 });
			chmodSync(tmp, statSync(file).mode & 0o777);
			renameSync(tmp, file);
		} catch (e) {
			rmSync(tmp, { force: true });
			throw e;
		}
		log(`OmO pin: ${account ?? "(cleared)"}`);
		return "written";
	} finally {
		release();
	}
}

// Removes one subscription account (a dead or unwanted login) from OmO's store: its entry in `accounts`, and the pin when it was the
// pinned one. Same lock and write as the pin; a copy of the file before the change is kept as auth.json.dotz-delete-<time> (0600).
// The last account is refused: that is a sign-out (공급자 → 로그아웃), not an account removal.
export function deleteOmoAccount(name: string, now = Date.now()): "deleted" | "missing" | "last" {
	const file = authFile();
	if (!existsSync(file)) return "missing";
	const release = lock(file);
	try {
		const text = readFileSync(file, "utf8");
		const data = JSON.parse(text);
		const sub = data?.[SUB];
		const accounts: { name?: unknown }[] = Array.isArray(sub?.accounts) ? sub.accounts : [];
		if (!accounts.some(a => a?.name === name)) return "missing";
		if (accounts.length <= 1) return "last";
		const backup = `${file}.dotz-delete-${now}`;
		copyFileSync(file, backup);
		chmodSync(backup, 0o600);
		sub.accounts = accounts.filter(a => a?.name !== name);
		if (sub.pinned === name) {
			delete sub.pinned;
			if (ownPin() === name) writeOwn(undefined);
		}
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(data, null, 2)}${text.endsWith("\n") ? "\n" : ""}`, { mode: 0o600 });
			chmodSync(tmp, statSync(file).mode & 0o777);
			renameSync(tmp, file);
		} catch (e) {
			rmSync(tmp, { force: true });
			throw e;
		}
		log(`OmO account deleted: ${name}`);
		return "deleted";
	} finally {
		release();
	}
}

function writeOwn(account: string | undefined): void {
	if (account === undefined) rmSync(ownPinFile(), { force: true });
	else writeFileSync(ownPinFile(), `${JSON.stringify({ account })}\n`);
}
