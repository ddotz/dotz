// Shared runner of the watch scripts (DESIGN.md "Output contract"): state.json in $DOTZ_WATCH_STATE_DIR, quiet hours in the
// owner's time zone, transient-failure absorption (one in-script retry, then a fail counter that stays silent until the 3rd
// failed run in a row), the stable `DOTZ_FAIL <kind>` lines hub/watch.ts parses, and the once-a-day `yt-quota-exhausted`
// notice when YouTube says the quota is gone. Also the zone-time helpers other libs share.
import { join } from "node:path";
import { type Config, type Ctx, loadConfig, readJson, realCtx, SetupError, writeJson } from "./config.ts";
import { announceExhausted } from "./quota.ts";

export type Platform = "youtube" | "instagram";
export type RunResult = { lines: string[]; code: number };

export class AuthError extends Error {
	readonly platform: Platform;
	constructor(platform: Platform, message = `${platform} login was rejected`) {
		super(message);
		this.name = "AuthError";
		this.platform = platform;
	}
}

// YouTube answered 403 quotaExceeded / dailyLimitExceeded: retrying cannot help until the Pacific midnight reset.
export class QuotaError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`youtube 403 ${reason}`);
		this.name = "QuotaError";
		this.reason = reason;
	}
}

export class TransientError extends Error {
	constructor(message = "temporary network or server failure") {
		super(message);
		this.name = "TransientError";
	}
}

const RETRY_WAIT_MS = 3_000;
const FAILS_BEFORE_ALERT = 3;

export const fail = (kind: string, detail?: string): RunResult => ({ lines: detail ? [`DOTZ_FAIL ${kind}`, oneLine(detail, 200)] : [`DOTZ_FAIL ${kind}`], code: 1 });

export const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

// Maps the errors every script can meet to its DOTZ_FAIL result; anything else is a plain `error` with the message.
export function failFrom(e: unknown): RunResult {
	if (e instanceof AuthError) return fail(`${e.platform}-auth`, `${e.platform} login has to be redone`);
	if (e instanceof SetupError) return fail("setup", e.message);
	if (e instanceof TransientError) return fail("network", e.message);
	return fail("error", e instanceof Error ? e.message : "unexpected failure");
}

export function zonedParts(d: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
	const p = Object.fromEntries(parts.map(x => [x.type, Number(x.value)]));
	return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

const pad = (n: number) => String(n).padStart(2, "0");
export function zonedDay(d: Date, tz: string): string {
	const p = zonedParts(d, tz);
	return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

// The instant at which the wall clock of `tz` reads y-mo-d h:mi (two passes settle DST offsets).
export function zonedToDate(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
	const wall = Date.UTC(y, mo - 1, d, h, mi);
	let guess = wall;
	for (let i = 0; i < 2; i++) {
		const p = zonedParts(new Date(guess), tz);
		guess += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
	}
	return new Date(guess);
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(cfg: Config, now: Date): boolean {
	const q = cfg.quiet_hours;
	if (!q) return false;
	const p = zonedParts(now, cfg.timezone);
	const m = p.h * 60 + p.mi;
	const a = minutes(q.from);
	const b = minutes(q.to);
	if (a === b) return false;
	return a < b ? m >= a && m < b : m >= a || m < b;
}

type Stored<S> = { fails: number; data?: S };
export type WatchOutcome<S> = { lines: string[]; state?: S } | "skip";

function readState<S>(file: string): Stored<S> {
	try {
		const s = readJson<Stored<S>>(file);
		return { fails: Number(s?.fails) || 0, data: s?.data };
	} catch {
		return { fails: 0 };
	}
}

// `body` gets the config and the previous baseline (undefined on the first run, which must only record one). It returns the
// lines to print plus the new baseline, or "skip" to leave state untouched (quota short). Throw TransientError / AuthError /
// SetupError for the cases the contract names; a QuotaError prints the exhausted notice (first time in a Pacific day only),
// exits 0 and leaves the baseline where it was.
export async function runWatch<S>(ctx: Ctx, opts: { quiet?: boolean; body: (cfg: Config, prev: S | undefined) => Promise<WatchOutcome<S>> }): Promise<RunResult> {
	const dir = ctx.env.DOTZ_WATCH_STATE_DIR;
	if (!dir) return fail("setup", "DOTZ_WATCH_STATE_DIR is not set; run it as a dotz watch");
	const file = join(dir, "state.json");
	const stored = readState<S>(file);
	let cfg: Config | undefined;
	try {
		cfg = loadConfig();
		if (opts.quiet && inQuietHours(cfg, ctx.now())) return { lines: [], code: 0 };
		let out: WatchOutcome<S>;
		try {
			out = await opts.body(cfg, stored.data);
		} catch (e) {
			if (!(e instanceof TransientError)) throw e;
			await ctx.sleep(RETRY_WAIT_MS);
			out = await opts.body(cfg, stored.data);
		}
		if (out === "skip") return { lines: [], code: 0 };
		writeJson(file, { fails: 0, data: out.state ?? stored.data });
		return { lines: out.lines, code: 0 };
	} catch (e) {
		if (e instanceof QuotaError && cfg) return { lines: await announceExhausted(ctx, cfg), code: 0 };
		if (e instanceof TransientError) {
			const fails = stored.fails + 1;
			writeJson(file, { fails, data: stored.data });
			return fails >= FAILS_BEFORE_ALERT ? fail("network", e.message) : { lines: [], code: 0 };
		}
		return failFrom(e);
	}
}

export async function main(run: (ctx: Ctx, args: string[]) => Promise<RunResult>): Promise<never> {
	let res: RunResult;
	try {
		res = await run(realCtx(), process.argv.slice(2));
	} catch (e) {
		res = failFrom(e);
	}
	if (res.lines.length) console.log(res.lines.join("\n"));
	process.exit(res.code);
}
