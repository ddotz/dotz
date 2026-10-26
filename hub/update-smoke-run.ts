// The update gate on the owner's machine (hub/update-gate.json runs `bun test ./hub/update-smoke-run.ts` in the folder being installed):
// the new version's gateway starts and serves the app (hub/update-smoke.ts), well under a minute. A version that passes this but still
// does not come up after the restart is rolled back by the update watchdog (hub/update-watchdog.ts). The full suite is the developer's
// gate before pushing (hub/update-gate-run.ts). Not named *.test.ts, so a plain `bun test` does not run it twice.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { smoke } from "./update-smoke.ts";

test("the gateway of this version starts and serves the app", async () => {
	const r = await smoke(join(import.meta.dir, ".."));
	if (!r.ok) console.log(`update smoke check failed after ${r.ms} ms: ${r.why}\n${r.out}`);
	else console.log(`update smoke check passed in ${r.ms} ms: ${r.checked.join(" ")}`);
	expect(r.ok ? "" : r.why).toBe("");
}, 3 * 60_000);
