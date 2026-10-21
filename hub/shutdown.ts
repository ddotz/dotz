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

// Runs the stages in order (each awaited), then exits 0. One deadline covers the whole run: when it passes, the process
// exits 1 at once. A throwing stage is logged and the next one still runs; a second call while running is ignored.
export async function runShutdown(stages: Stage[], deadlineMs = 10_000): Promise<never> {
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
