import { watch } from "node:fs";

// Resolves when `ready()` holds, re-checked on each change of `file`. A fake process writes the file from outside the test, so how many
// event-loop turns that takes depends on machine load; the file's change event is the signal, and the bound only turns a miss into a
// clear failure naming `what`.
export async function fileLogged(file: string, ready: () => boolean, what: string, boundMs = 15_000): Promise<void> {
	let watcher: ReturnType<typeof watch> | undefined;
	const arrived = new Promise<void>(resolve => {
		watcher = watch(file, () => ready() && resolve());
		if (ready()) resolve();
	});
	try {
		const ok = await Promise.race([arrived.then(() => true), Bun.sleep(boundMs).then(() => false)]);
		if (!ok) throw new Error(`${what} did not happen within ${boundMs} ms`);
	} finally {
		watcher?.close();
	}
}

// The processes a test's injected spawn started and that have not exited yet. Each process's own `exited` promise is the signal, so a
// process killed before its script could log anything still counts as gone; the bound only turns a miss into a clear failure.
export function liveProcesses(what: string) {
	const live = new Set<Promise<unknown>>();
	let wake = () => {};
	const track = <P extends { exited: Promise<unknown> }>(proc: P): P => {
		const exited = proc.exited;
		live.add(exited);
		wake();
		void exited.finally(() => {
			live.delete(exited);
			wake();
		});
		return proc;
	};
	const aliveIs = async (n: number, boundMs = 15_000): Promise<void> => {
		const until = Date.now() + boundMs;
		while (live.size !== n) {
			const changed = new Promise<boolean>(resolve => (wake = () => resolve(true)));
			if (!(await Promise.race([changed, Bun.sleep(Math.max(0, until - Date.now())).then(() => false)]))) throw new Error(`${n} ${what} alive: ${live.size} after ${boundMs} ms`);
		}
	};
	return { track, aliveIs };
}
