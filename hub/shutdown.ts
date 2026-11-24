import { log } from "./config.ts";

type Stage = { name: string; run: () => void | Promise<void> };

let running = false;
let ignoredLogged = false;
const tracked = new Map<string, Timer>();

// Modules with a self-rearming nightly timer register its latest handle here, so the shutdown can clear it.
export function trackTimer(key: string, handle: Timer): void {
	tracked.set(key, handle);
}

export function clearTrackedTimers(): void {
	for (const handle of tracked.values()) clearTimeout(handle);
	tracked.clear();
}

const finishing = new Map<string, { run: () => Promise<void>; busy: () => boolean }>();
/** Work an orderly stop finishes before anything else stops (an answer held for its undo window goes out): runShutdown runs each one first, before
 * its stages, and while `busy` says so stopWorkBusy names it, so a restart that waits for an idle gateway (main.ts busyNow) waits for it too. */
export function finishOnStop(name: string, run: () => Promise<void>, busy: () => boolean): void {
	finishing.set(name, { run, busy });
}
/** The names of the work registered with finishOnStop that is busy now. */
export const stopWorkBusy = (): string[] => [...finishing].filter(([, w]) => w.busy()).map(([name]) => name);

// Runs the stages in order (each awaited), then exits 0. One deadline covers the whole run: when it passes, the process
// exits 1 at once. A throwing stage is logged and the next one still runs; a second call while running is ignored.
export async function runShutdown(given: Stage[], deadlineMs = 10_000): Promise<never> {
	if (running) {
		if (!ignoredLogged) log("shutdown already running; ignoring repeated request");
		ignoredLogged = true;
		return new Promise<never>(() => {});
	}
	running = true;
	let current = "(start)";
	setTimeout(() => {
		log(`shutdown deadline ${deadlineMs / 1000}s passed during ${current}; forcing exit`);
		process.exit(1);
	}, deadlineMs);
	const stages: Stage[] = [...[...finishing].map(([name, w]) => ({ name, run: w.run })), ...given];
	for (const [i, stage] of stages.entries()) {
		current = stage.name;
		log(`shutdown ${i + 1}/${stages.length} ${stage.name}`);
		try {
			await stage.run();
		} catch (error) {
			log(`shutdown stage ${stage.name} failed: ${error}`);
		}
	}
	process.exit(0);
}
