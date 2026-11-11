import { expect, test } from "bun:test";
import { failedFiles, guardRun } from "./update-gate-files.ts";

// The update gate runs only the files that failed a second time: a failed test and a file that errored while loading both count, a file that passed does not.
test("failed and errored files are found from bun's output; passing files are not", () => {
	const out = ["hub/a.test.ts:", "(pass) x [1ms]", "hub/b-web.test.ts:", "38 | const v = new Bun.WebView()", "error: Failed to spawn WebView host process", "hub/c.test.ts:", "(pass) y", "(fail) z [1ms]", "hub/d.test.ts:", "# Unhandled error between tests", "hub/e.test.ts:", "(pass) ok"].join("\n");
	expect(failedFiles(out)).toEqual(["hub/b-web.test.ts", "hub/c.test.ts", "hub/d.test.ts"]);
	expect(failedFiles("hub/a.test.ts:\n(pass) x\n")).toEqual([]);
});


const MIN = 60_000;
// A clock of its own: sleep moves it, nothing waits in real time.
const world = (heldFrom: number | undefined, exitAt = Infinity) => {
	let t = 0;
	let killedAt: number | undefined;
	let exit = () => {};
	const exited = new Promise<void>(r => (exit = r));
	return {
		killedAt: () => killedAt,
		g: {
			exited,
			held: () => heldFrom !== undefined && t >= heldFrom,
			kill: () => void (killedAt = t),
			runMs: 20 * MIN,
			waitMs: 45 * MIN,
			now: () => t,
			sleep: async (ms: number) => {
				await new Promise(r => setImmediate(r));
				t += ms;
				if (t >= exitAt) exit();
			},
		},
	};
};

test("the run limit does not count the wait for the slot: a run that got it after 30 min is killed 20 min after that", async () => {
	const w = world(30 * MIN);
	expect(await guardRun(w.g)).toBe("run");
	expect(w.killedAt()).toBe(50 * MIN);
});

test("a run that never gets the slot is killed at the wait bound, so the gate cannot hang for good", async () => {
	const w = world(undefined);
	expect(await guardRun(w.g)).toBe("wait");
	expect(w.killedAt()).toBe(45 * MIN);
});

test("a run that ends first is never killed", async () => {
	const w = world(5 * MIN, 12 * MIN);
	expect(await guardRun(w.g)).toBeUndefined();
	expect(w.killedAt()).toBeUndefined();
});
