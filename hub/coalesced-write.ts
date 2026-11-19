import { log } from "./config.ts";

/**
 * A file write that happens at most once per `everyMs`, however often `save` is called: the first `save` after a write starts the wait, the write at its end
 * covers every change made meanwhile. `flush` writes at once what is waiting (`force`: even when nothing is), and also runs when the process exits.
 * A failed timed write is logged and tried again by the next `save`.
 */
export function coalescedWrite(write: () => void, everyMs: number): { save: () => void; flush: (force?: boolean) => void } {
	let dirty = false;
	let timer: Timer | undefined;
	const flush = (force = false): void => {
		clearTimeout(timer);
		timer = undefined;
		if (!dirty && !force) return;
		write();
		dirty = false;
	};
	const flushLogged = (): void => {
		try {
			flush();
		} catch (error) {
			log(`coalesced write failed: ${(error as Error).message}`);
		}
	};
	process.on("exit", flushLogged);
	return {
		save: () => {
			dirty = true;
			timer ??= setTimeout(() => {
				timer = undefined;
				flushLogged();
			}, everyMs);
		},
		flush,
	};
}
