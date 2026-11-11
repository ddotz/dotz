// State-machine regression: the orchestrator and lane scenarios (scenario.ts) must reproduce, step for step, the trace
// captured from the pre-adapter code. CAPTURE_GOLDEN=1 rewrites the golden instead of comparing (only for a deliberate change).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { cfg } from "../config.ts";
import { laneScenario, orchestratorScenario } from "./scenario.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "scenario.golden.json");

// The #hash in front of a long prompt hashes its whole text, so every prompt edit moved it (429b1cd2, 95f1eb14). Marks are compared by order of first
// appearance instead: each one must still be there, and a prompt sent twice in a run must carry the same mark twice.
const MARK = /^#([0-9a-z]+) (?=[^]*…$)/;
const marks = (trace: unknown) => {
	const seen = new Map<string, number>();
	return JSON.parse(JSON.stringify(trace), (_, v) => typeof v === "string" ? v.replace(MARK, (_m, h: string) => `#mark${seen.get(h) ?? seen.set(h, seen.size).get(h)} `) : v);
};

test("orchestrator and lane state machines keep their calls", async () => {
	// The golden was captured from the omp adapter; since OmO became the default the scenario names omp explicitly.
	const saved = cfg.runtime;
	cfg.runtime = "omp";
	const actual = await (async () => {
		try {
			return JSON.parse(JSON.stringify({ orchestrator: await orchestratorScenario(), lane: await laneScenario() }));
		} finally {
			cfg.runtime = saved;
		}
	})();
	if (process.env.CAPTURE_GOLDEN === "1") return void (await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`));
	const golden = marks(JSON.parse(await Bun.file(GOLDEN).text()));
	const got = marks(actual);
	expect(got.orchestrator).toEqual(golden.orchestrator);
	expect(got.lane).toEqual(golden.lane);
}, 60_000);
