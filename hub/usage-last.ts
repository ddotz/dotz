// The last good usage value per source ("omp:<provider>", "account:<name>") with the time it was read. A failed read shows that value
// (marked stale, with its read time) instead of dropping the row, and survives a gateway restart through a small file in the data
// dir's state folder, read once at startup and written only when a good read changed it. A failure streak writes ONE hub.log line
// with the reason, and the first good read after it one more. A limit whose window has reset since the read is not a number any more.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, log, writeAtomic } from "./config.ts";
import { runLimited } from "./run-limited.ts";
import type { QuotaLimit } from "./usage-account.ts";

type Saved = { report: Record<string, any>; readAt: number };
// An unchanged value is written again after this long, so the saved read time does not lag far behind.
const SAVE_AGAIN_MS = 10 * 60_000;
export const USAGE_LAST_FILE = join(DATA_DIR, "state", "usage-last.json");
const signature = (report: unknown): string => JSON.stringify(report, (k, v) => (k === "fetchedAt" ? undefined : v));

export class UsageLast {
	private held = new Map<string, Saved>();
	private streak = new Map<string, number>();
	constructor(private readonly file: string = USAGE_LAST_FILE, private readonly say: (msg: string) => void = log, readonly now: () => number = Date.now) {
		try {
			const saved = JSON.parse(readFileSync(file, "utf8"));
			for (const [key, v] of Object.entries<any>(saved ?? {})) if (v && typeof v.readAt === "number" && v.report && typeof v.report === "object") this.held.set(key, { report: v.report, readAt: v.readAt });
		} catch {
			// no saved value yet (first start) or an unreadable file: nothing to show until a read succeeds
		}
	}

	get<T>(key: string): { report: T; readAt: number } | undefined {
		return this.held.get(key) as { report: T; readAt: number } | undefined;
	}

	keys(prefix: string): string[] {
		return [...this.held.keys()].filter(k => k.startsWith(prefix));
	}

	failing(prefix: string): string[] {
		return [...this.streak.keys()].filter(k => k.startsWith(prefix));
	}

	// A good read: keeps it as the last value (saved when it changed) and closes a failure streak with one log line.
	good(key: string, report: object, readAt: number): void {
		this.ok(key);
		const prev = this.held.get(key);
		this.held.set(key, { report: report as Record<string, any>, readAt });
		if (prev && signature(prev.report) === signature(report) && readAt - prev.readAt < SAVE_AGAIN_MS) {
			this.held.set(key, { report: prev.report, readAt: prev.readAt });
			return;
		}
		this.save();
	}

	ok(key: string): void {
		const n = this.streak.get(key);
		if (n === undefined) return;
		this.streak.delete(key);
		this.say(`usage read ok again (${key}) after ${n} failed reads`);
	}

	// A failed read: logs the reason on the first of a streak and returns the value to show, if there is one.
	failed(key: string, reason: string): { report: Record<string, any>; readAt: number } | undefined {
		const n = (this.streak.get(key) ?? 0) + 1;
		this.streak.set(key, n);
		const held = this.held.get(key);
		if (n === 1) this.say(`usage read failed (${key}): ${reason}; ${held ? `showing the value read at ${new Date(held.readAt).toISOString()}` : "no earlier value to show"}`);
		return held;
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			writeAtomic(this.file, `${JSON.stringify(Object.fromEntries(this.held), null, 2)}\n`);
		} catch (e) {
			this.say(`usage-last could not be saved: ${(e as Error).message}`);
		}
	}
}

export const usageLast = new UsageLast();

// One `usage --json` read through the last-good store. `read` answers the reports, or why it could not. A failed read returns the
// held reports of every provider marked problem "failed" with their read time; nothing held: undefined (the caller reads again next time).
export async function readReports<R extends { provider: string; limits?: unknown[] }>(
	read: () => Promise<{ reports?: R[]; reason?: string }>,
	last: UsageLast = usageLast,
): Promise<(R & { problem?: "failed"; fetchedAt?: number })[] | undefined> {
	const r = await read();
	if (r.reports) {
		const at = last.now();
		for (const key of last.failing("omp:")) last.ok(key);
		for (const rep of r.reports) if (rep.limits?.length) last.good(`omp:${rep.provider}`, rep, at);
		return r.reports;
	}
	const reason = r.reason ?? "no answer";
	const keys = last.keys("omp:");
	if (!keys.length) {
		last.failed("omp:usage", reason);
		return undefined;
	}
	return keys.flatMap(key => {
		const held = last.failed(key, reason);
		return held ? [{ ...(held.report as R), problem: "failed" as const, fetchedAt: held.readAt }] : [];
	});
}

// `<bin> usage --json`, with why it failed (timeout, exit code, unparsable output) for the log.
const USAGE_READ_MS = 45_000;
export async function readUsageJson<R>(bin: string): Promise<{ reports?: R[]; reason?: string }> {
	const r = await runLimited([bin, "usage", "--json"], USAGE_READ_MS);
	if (r.timedOut) return { reason: `timed out after ${USAGE_READ_MS / 1000} s` };
	if (r.code !== 0) return { reason: `exit code ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]!.slice(0, 160)}` : ""}` };
	try {
		const reports = JSON.parse(r.stdout)?.reports;
		return Array.isArray(reports) ? { reports } : { reason: "output has no reports" };
	} catch {
		return { reason: "output is not valid JSON" };
	}
}

// Pure: a held limit whose window reset at or before `now` is no longer a number (the window rolled over): no used/remaining, status "reset".
export const heldLimits = (limits: QuotaLimit[], now: number): QuotaLimit[] =>
	limits.map(l => (l.resets_at !== null && l.resets_at <= now ? { ...l, used: null, limit: null, remaining: null, status: "reset" } : l));
