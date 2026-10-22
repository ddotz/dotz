// YouTube Data API quota ledger shared by every script: units spent per Pacific day (the quota resets at midnight
// Pacific) in cache/quota.json, checked against the owner's daily budget before a call and added to when one is made.
import { type Config, type Ctx, paths, readJson, writeJson } from "./config.ts";
import { zonedDay } from "./watchkit.ts";

// Google's quota cost table (developers.google.com/youtube/v3/determine_quota_cost) is the source of these numbers;
// videos.insert is the one that has been revised, so it stays a single constant.
export const VIDEO_INSERT_COST = 1600;
export const COSTS = { list: 1, update: 50, insertComment: 50, videoInsert: VIDEO_INSERT_COST } as const;

const QUOTA_ZONE = "America/Los_Angeles";
type Ledger = { day: string; units: number };

function read(ctx: Ctx): Ledger {
	const day = zonedDay(ctx.now(), QUOTA_ZONE);
	let l: Ledger | undefined;
	try {
		l = readJson<Ledger>(paths.quota());
	} catch {}
	return l?.day === day && Number.isFinite(l.units) ? l : { day, units: 0 };
}

export const used = (ctx: Ctx): number => read(ctx).units;

export function can(ctx: Ctx, cfg: Config, cost: number): boolean {
	return read(ctx).units + cost <= cfg.quota.daily_budget;
}

export function spend(ctx: Ctx, cost: number): void {
	const l = read(ctx);
	l.units += cost;
	writeJson(paths.quota(), l);
}
