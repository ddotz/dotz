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
