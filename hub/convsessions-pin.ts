import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import { runtimeIdOf } from "./runtime/runtime-id.ts";

/** The model pin of conversations on their own model: OmO workers read it from a file at each spawn; an omp session gets its workers' model at its start, so there it is only remembered, to tell when main's workers moved. */
export function createWorkerPins(dirOf: (key: string) => string, pinFor: (key: string) => string | undefined) {
	const pinned = new Map<string, string>();
	const ompWorkers = (): boolean => runtimeIdOf("orchestrator") === "omp";
	return {
		sync(key: string): void {
			const pin = pinFor(key) ?? "";
			const file = join(dirOf(key), "worker-pin");
			pinned.set(key, pin);
			if (pin && !ompWorkers()) writeAtomic(file, `${pin}\n`);
			else rmSync(file, { force: true });
		},
		/** Re-pins and tells whether an omp session's workers moved (its process must restart to follow). */
		movedOnOmp(key: string): boolean {
			const before = pinned.get(key);
			this.sync(key);
			return ompWorkers() && pinned.get(key) !== before;
		},
		forget: (key: string): boolean => pinned.delete(key),
	};
}
