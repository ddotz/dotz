// The orchestrator's pinned first prompt: the MODE section on mail and calendar is there only while zele is enabled.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { cfg } from "./config.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;

const o: typeof Orchestrator = await import("./orchestrator.ts?first-prompt");
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7200;
	sent: { text: string; mode: SendMode }[] = [];
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = (async function* (): AsyncGenerator<AgentEvent> {
		await new Promise(() => {});
	})();
	send(text: string, mode: SendMode): void {
		this.sent.push({ text, mode });
	}
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(_opts: SpawnOpts) {
		const agent = new FakeAgent();
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => undefined,
};

const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	delete (cfg as { zele?: unknown }).zele;
	Object.assign(cfg, savedCfg);
	l.shutdownLanes();
});

async function firstPrompt(zele: { enabled?: boolean } | undefined): Promise<string> {
	rmSync(join(DATA, "orchestrator.json"), { force: true });
	if (zele) (cfg as { zele?: unknown }).zele = zele;
	else delete (cfg as { zele?: unknown }).zele;
	o.start();
	const agent = started.at(-1)!;
	const text = agent.sent[0]!.text;
	o.stop();
	await flush();
	await advance(1000);
	return text;
}

test("state.json reaches the first prompt as a compact listing, not a raw slice", async () => {
	writeFileSync(join(DATA, "state.json"), JSON.stringify({ open_tasks: [{ id: "t1", what: "ship it", next: "test it" }], extra: 1 }, null, 2));
	try {
		const text = await firstPrompt(undefined);
		expect(text).toContain("- t1: ship it (next: test it)");
		expect(text).toContain("other keys: extra");
	} finally {
		rmSync(join(DATA, "state.json"), { force: true });
	}
});

test("the Mail and calendar section is in the first prompt only when zele is enabled (on by default)", async () => {
	const heading = "## Mail and calendar";
	expect(await firstPrompt({ enabled: false })).not.toContain(heading);
	expect(await firstPrompt({ enabled: true })).toContain(heading);
	expect(await firstPrompt(undefined)).toContain(heading);
});

describe("owner memory in prompts", () => {
	const lastBoundary = `- [2026-11-04] "last words" (the newest don't)`;
	const memory = join(DATA, "memory");
	const owner = join(memory, "owner.md");
	const boundaries = join(memory, "boundaries.md");
	beforeAll(() => {
		mkdirSync(memory, { recursive: true });
		writeFileSync(boundaries, `# Boundaries\n\n${Array.from({ length: 80 }, (_, i) => `- [2026-10-01] "old rule ${i}" (padding padding)`).join("\n")}\n${lastBoundary}\n`);
	});
	afterAll(() => {
		rmSync(owner, { force: true });
		rmSync(boundaries, { force: true });
	});

	test("the last boundary line reaches the first prompt", async () => {
		expect(await firstPrompt(undefined)).toContain(lastBoundary);
	});

	test("the last boundary line reaches the lane footer", () => {
		const cwd = mkdtempSync(join(tmpdir(), "dotz-footer-"));
		try {
			l.launch("footer-boundaries", cwd, "Polish the theme.\nDone when: owner approves");
			expect(started.at(-1)!.sent[0]!.text).toContain(lastBoundary);
		} finally {
			l.stopLane("footer-boundaries");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a long owner card keeps its newest lines and says what it left out", async () => {
		writeFileSync(owner, `# Owner\n\n${Array.from({ length: 200 }, (_, i) => `- [2026-10-01] fact number ${i}`).join("\n")}\n`);
		const text = await firstPrompt(undefined);
		expect(text).toContain("fact number 199");
		expect(text.indexOf("fact number 199")).toBeLessThan(text.indexOf("fact number 198"));
		expect(text).not.toContain("fact number 0\n");
		expect(text).toContain(`read ${owner} for the rest`);
	});
});
