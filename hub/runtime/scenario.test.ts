// State-machine regression: the orchestrator and lane scenarios (scenario.ts) must reproduce, step for step, the trace
// captured from the pre-adapter code. CAPTURE_GOLDEN=1 rewrites the golden instead of comparing (only for a deliberate change).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { laneScenario, orchestratorScenario } from "./scenario.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "scenario.golden.json");

test("orchestrator and lane state machines keep their calls", async () => {
	const actual = JSON.parse(JSON.stringify({ orchestrator: await orchestratorScenario(), lane: await laneScenario() }));
	if (process.env.CAPTURE_GOLDEN === "1") return void (await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`));
	const golden = JSON.parse(await Bun.file(GOLDEN).text());
	expect(actual.orchestrator).toEqual(golden.orchestrator);
	expect(actual.lane).toEqual(golden.lane);
}, 60_000);
