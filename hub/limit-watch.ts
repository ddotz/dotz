// The slow check while a session waits out a usage limit: when a 리셋권 is spent somewhere else (Claude Code, the web page), nothing tells
// dotz, so every LIMIT_WATCH_MS it asks the check (hub/limit-lift.ts) whether the limit is over. The timer exists only while something is
// paused on a usage limit (the pause arms it), is unref'd, and stops itself at the first tick that finds nothing paused.
import { log } from "./config.ts";

export const LIMIT_WATCH_MS = 5 * 60_000;
type Hooks = { paused: () => number; tick: () => Promise<void> };
let hooks: Hooks | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

function stop(): void {
	clearInterval(timer);
	timer = undefined;
}
export function setLimitWatch(h: Hooks | undefined): void {
	hooks = h;
	stop();
}
export const limitWatchArmed = (): boolean => timer !== undefined;
export function armLimitWatch(): void {
	if (timer || !hooks) return;
	timer = setInterval(() => void run(), LIMIT_WATCH_MS);
	timer.unref?.();
}
// What a session's pause knows of the usage limit it waits on (not a billing/auth block, not a spend cap): set when the pause arms, with what its
// timer would do. lift runs that now, once, when the limit is over (hub/limit-lift.ts: a 리셋권 was spent, or the usage report is under its limit again).
export function limitPauseState() {
	let limit = false;
	let fire: (() => void) | undefined;
	return {
		armed: (): boolean => limit && Boolean(fire),
		clear: (): void => void (limit = false),
		set(isLimit: boolean, onTimer: () => void): void {
			[limit, fire] = [isLimit, onTimer];
			if (isLimit) armLimitWatch();
		},
		lift(before: () => void): boolean {
			if (!limit || !fire) return false;
			before();
			limit = false;
			fire();
			return true;
		},
	};
}
async function run(): Promise<void> {
	if (busy) return;
	if (!hooks?.paused()) return stop();
	busy = true;
	try {
		await hooks.tick();
	} catch (e) {
		log(`usage limit check failed: ${(e as Error).message}`);
	} finally {
		busy = false;
	}
	if (!hooks?.paused()) stop();
}
