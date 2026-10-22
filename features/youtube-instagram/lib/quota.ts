// YouTube Data API quota ledger shared by every script: units spent per Pacific day (the quota resets at midnight
// Pacific) in cache/quota.json, checked against the owner's daily budget before a call and added to when one is made.
// A 403 quotaExceeded marks the ledger exhausted until the next Pacific midnight; every write goes through a lock file
// (cache/quota.lock) so two scripts running at once cannot lose an update.
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Config, type Ctx, loadConfig, paths, readJson, writeJson } from "./config.ts";
import { TransientError, zonedDay, zonedParts, zonedToDate } from "./watchkit.ts";

// Google's quota cost table (developers.google.com/youtube/v3/determine_quota_cost) is the source of these numbers;
// videos.insert is the one that has been revised, so it stays a single constant.
export const VIDEO_INSERT_COST = 1600;
export const COSTS = { list: 1, update: 50, insertComment: 50, videoInsert: VIDEO_INSERT_COST } as const;

const QUOTA_ZONE = "America/Los_Angeles";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 200;
const LOCK_TRIES = 60;
type Ledger = { day: string; units: number; exhausted_until?: string; reported_day?: string };

const lockFile = () => join(paths.cache(), "quota.lock");

function read(ctx: Ctx): Ledger {
	const day = zonedDay(ctx.now(), QUOTA_ZONE);
	let l: Ledger | undefined;
	try {
		l = readJson<Ledger>(paths.quota());
	} catch {}
	return l?.day === day && Number.isFinite(l.units) ? l : { day, units: 0 };
}

// O_EXCL create; a lock older than LOCK_STALE_MS belongs to a process that died and is taken over.
function tryLock(): boolean {
	mkdirSync(paths.cache(), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			closeSync(openSync(lockFile(), "wx"));
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(lockFile()).mtimeMs <= LOCK_STALE_MS) return false;
				unlinkSync(lockFile());
			} catch {}
		}
	}
	return false;
}

// Read-modify-write under the lock. The first attempt runs synchronously, so an uncontended update has landed when the
// call returns; only a held lock waits (bounded, through the injected sleep).
async function update<R>(ctx: Ctx, change: (l: Ledger) => R): Promise<R> {
	let held = tryLock();
	for (let i = 0; !held && i < LOCK_TRIES; i++) {
		await ctx.sleep(LOCK_WAIT_MS);
		held = tryLock();
	}
	if (!held) throw new TransientError("quota ledger is locked");
	try {
		const l = read(ctx);
		const out = change(l);
		writeJson(paths.quota(), l);
		return out;
	} finally {
		try {
			unlinkSync(lockFile());
		} catch {}
	}
}

export const used = (ctx: Ctx): number => read(ctx).units;

export function isExhausted(ctx: Ctx): boolean {
	const until = read(ctx).exhausted_until;
	return until !== undefined && ctx.now().getTime() < Date.parse(until);
}

export function can(ctx: Ctx, cfg: Config, cost: number): boolean {
	return !isExhausted(ctx) && read(ctx).units + cost <= cfg.quota.daily_budget;
}

export async function spend(ctx: Ctx, cost: number): Promise<void> {
	await update(ctx, l => {
		l.units += cost;
	});
}

// The instant the Pacific day after `now` begins, when Google resets the quota.
function nextPacificMidnight(now: Date): Date {
	const p = zonedParts(now, QUOTA_ZONE);
	return zonedToDate(p.y, p.mo, p.d + 1, 0, 0, QUOTA_ZONE);
}

// Google said the day's quota is gone: units fill up to the budget and can() stays false until the next Pacific midnight.
export async function markExhausted(ctx: Ctx, cfg: Config = loadConfig()): Promise<void> {
	const until = nextPacificMidnight(ctx.now()).toISOString();
	await update(ctx, l => {
		l.units = Math.max(l.units, cfg.quota.daily_budget);
		l.exhausted_until = until;
	});
}

const pad = (n: number) => String(n).padStart(2, "0");

// `yt-quota-exhausted until=<HH:MM>` with the reset time on the owner's clock; undefined while the quota is fine.
export function exhaustedLine(ctx: Ctx, cfg: Config): string | undefined {
	const until = isExhausted(ctx) ? read(ctx).exhausted_until : undefined;
	if (!until) return undefined;
	const p = zonedParts(new Date(until), cfg.timezone);
	return `yt-quota-exhausted until=${pad(p.h)}:${pad(p.mi)}`;
}

// What a script prints when it ran into the limit: the line the first time in a Pacific day, nothing afterwards.
export async function announceExhausted(ctx: Ctx, cfg: Config): Promise<string[]> {
	if (!isExhausted(ctx)) await markExhausted(ctx, cfg);
	const first = await update(ctx, l => {
		if (l.reported_day === l.day) return false;
		l.reported_day = l.day;
		return true;
	});
	const line = first ? exhaustedLine(ctx, cfg) : undefined;
	return line ? [line] : [];
}
