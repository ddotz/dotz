import { rmSync } from "node:fs";
import type { Orchestrator } from "./orchestrator.ts";

const EXIT_POLL_MS = 100;
const EXIT_WAIT_MS = 30_000;

type Ending = { key: string; dir?: string; meta: { parked?: true }; o: Pick<Orchestrator, "orchestratorPid" | "heldCount" | "start" | "stop"> };
type Deps<C extends Ending> = { get: (key: string) => C | undefined; ensure: (key: string) => C; drop: (c: C) => void; log: (line: string) => void };

/**
 * How a conversation session's process ends for good or for a while (hub/convsessions.ts): a message that reaches a parked session before its
 * process has left is held by the real orchestrator and nothing starts it, so `reviveAfterExit` starts it again once the process is gone; and
 * `remove` deletes a conversation (process, state directory, registry entry). The runtime's own session transcript is left where it is.
 */
export function createConvEnd<C extends Ending>(d: Deps<C>) {
	const live = (c: C) => c.o.orchestratorPid() !== undefined;
	const exiting = new Set<string>();
	const untilExit = async (c: C): Promise<void> => {
		for (let waited = 0; live(c) && waited < EXIT_WAIT_MS; waited += EXIT_POLL_MS) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, EXIT_POLL_MS);
			await promise;
		}
	};
	function revive(c: C): boolean {
		if (!c.meta.parked || live(c) || c.o.heldCount() === 0 || d.get(c.key) !== c) return false;
		d.ensure(c.key);
		c.o.start();
		d.log(`conversation session ${c.key} started again: prompts reached it while it was parking`);
		return true;
	}
	async function reviveAfterExit(c: C): Promise<void> {
		if (exiting.has(c.key)) return;
		exiting.add(c.key);
		try {
			await untilExit(c);
			revive(c);
		} catch (e) {
			d.log(`conversation session ${c.key} could not start after its park: ${(e as Error).message}`);
		} finally {
			exiting.delete(c.key);
		}
	}
	async function remove(key: string): Promise<boolean> {
		const c = d.get(key);
		if (!c) return false;
		c.o.stop();
		await untilExit(c);
		if (d.get(key) !== c) return true;
		d.drop(c);
		rmSync(c.dir!, { recursive: true, force: true });
		d.log(`conversation session ${key} deleted`);
		return true;
	}
	return { revive, reviveAfterExit, remove };
}
