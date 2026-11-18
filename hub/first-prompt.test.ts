// The orchestrator's pinned first prompt and its system note: the MODE section on mail and calendar is there only while zele is enabled; identity and MODE
// are in the first prompt, or in the system note on a runtime that keeps its system prompt through compaction and resume (caps.modeInSystem: omp).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as Lanes from "./lanes.ts";
import type * as Orchestrator from "./orchestrator.ts";
import { cfg, HUB_TOKEN, IDENTITY_FILE, NAME } from "./config.ts";
import { isNote, modeFile } from "./i18n.ts";
import { claude } from "./runtime/claude.ts";
import { adapters } from "./runtime/index.ts";
import { omo } from "./runtime/omo.ts";
import { omp } from "./runtime/omp.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter, SendMode, SpawnOpts } from "./runtime/types.ts";
import { steerContract, steerToken } from "./steer-mark.ts";

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
	constructor(readonly opts: SpawnOpts) {}
}

const started: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start(opts: SpawnOpts) {
		const agent = new FakeAgent(opts);
		started.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => undefined,
};
// What omp's adapter declares (hub/runtime/omp.ts), on the same fake: identity and MODE go into the system prompt.
const fakeSystem: RuntimeAdapter = { ...fake, caps: { ...fake.caps, modeInSystem: true } };

const savedCfg = { orchestrator: cfg.orchestrator, lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	adapters["fake-system"] = fakeSystem;
	cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	delete adapters["fake-system"];
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

// Identity and MODE are the static part of the contract. On a runtime that keeps its system prompt through a compaction and a resume (caps.modeInSystem: omp)
// they ride in the spawn's system note, built from files only, so the note is the same at every spawn of a session and its prompt cache holds; the first
// prompt then carries the daily rest. Any other runtime (OmO, claude) keeps the old layout: the note is the steer contract alone, the first prompt holds all.
describe("identity and MODE: system note or first prompt", () => {
	const identity = "identity marker 7f3a: speaks plainly";
	const token = steerToken(HUB_TOKEN, "orchestrator:main");
	const mode = () => readFileSync(modeFile(), "utf8");
	// Headings of the shipped MODE.md that only the contract writes (no owner file or feature text does).
	const headings = ["## Message layout", "## Confirmation gates", "## Routing"];
	const session = join(DATA, "first-prompt-session.jsonl");
	beforeAll(() => {
		mkdirSync(dirname(IDENTITY_FILE), { recursive: true });
		writeFileSync(IDENTITY_FILE, identity);
		writeFileSync(session, "{}\n");
	});
	afterAll(() => {
		for (const file of [IDENTITY_FILE, session, join(DATA, "state.json"), join(DATA, "orchestrator.json")]) rmSync(file, { force: true });
		cfg.orchestrator = { ...cfg.orchestrator, runtime: "fake" };
	});
	// One spawn on `runtime`, stopped again at once; `resumeFrom` is a saved session file, which makes it a resume (no first prompt).
	async function spawn(runtime: string, resumeFrom?: string): Promise<FakeAgent> {
		rmSync(join(DATA, "orchestrator.json"), { force: true });
		if (resumeFrom) writeFileSync(join(DATA, "orchestrator.json"), JSON.stringify({ sessionFile: resumeFrom }));
		cfg.orchestrator = { ...cfg.orchestrator, runtime };
		o.start();
		const agent = started.at(-1)!;
		o.stop();
		await flush();
		await advance(1000);
		return agent;
	}

	test("a runtime that keeps its system prompt gets identity and MODE in the system note behind the steer contract, and not in the first prompt", async () => {
		const agent = await spawn("fake-system");
		const note = agent.opts.systemNote!;
		const first = agent.sent[0]!.text;
		expect(note.startsWith(`${steerContract(token)}\n\n`)).toBe(true);
		expect(note).toContain(identity);
		expect(note).toContain(mode());
		expect(agent.opts.env.DOTZ_MODE_IN_SYSTEM).toBe("1"); // the extension then leaves both out of its re-read after a compaction
		expect(first).not.toContain(identity);
		for (const heading of headings) {
			expect(note).toContain(heading);
			expect(first).not.toContain(heading);
		}
		// What the first prompt keeps: the lead the gateway recognises it by (hub/gateway-added.ts) and the owner rules.
		expect(isNote(first, "youAre")).toBe(true);
		expect(first).toContain("Owner rules (");
	});

	test("the system note is the same at every spawn of a session: state.json, the clock and a resume change the first prompt, never the note", async () => {
		const state = (id: string) => writeFileSync(join(DATA, "state.json"), JSON.stringify({ open_tasks: [{ id, what: `work of ${id}` }] }));
		state("t-one");
		const one = await spawn("fake-system");
		clock.now += 26 * 3600_000; // a day later
		state("t-two");
		const two = await spawn("fake-system");
		state("t-three");
		const resumed = await spawn("fake-system", session);
		const note = one.opts.systemNote!;
		expect(note).toContain(identity);
		expect(note).toContain(mode());
		expect(two.opts.systemNote).toBe(note);
		expect(resumed.opts.systemNote).toBe(note);
		expect(resumed.opts.resume).toBe(session);
		expect(resumed.sent).toHaveLength(0);
		expect(one.sent[0]!.text).toContain("t-one");
		expect(two.sent[0]!.text).toContain("t-two");
		expect(note).not.toContain("t-one");
		expect(note).not.toContain("t-two");
	});

	test("the Mail and calendar section is in the system note only while zele is enabled", async () => {
		const heading = "## Mail and calendar";
		try {
			(cfg as { zele?: unknown }).zele = { enabled: false };
			expect((await spawn("fake-system")).opts.systemNote).not.toContain(heading);
			(cfg as { zele?: unknown }).zele = { enabled: true };
			expect((await spawn("fake-system")).opts.systemNote).toContain(heading);
		} finally {
			delete (cfg as { zele?: unknown }).zele;
		}
	});

	test("a runtime without the flag keeps the old layout: the system note is the steer contract alone and the first prompt holds identity and MODE", async () => {
		const agent = await spawn("fake");
		expect(agent.opts.systemNote).toBe(steerContract(token));
		expect(agent.opts.env.DOTZ_MODE_IN_SYSTEM).toBeUndefined();
		expect(agent.sent[0]!.text.startsWith(`[dotz gateway] You are ${NAME}, the dotz orchestrator hosted headless by the gateway.\n\nIdentity (who you are and how you talk):\n${identity}\n\nContract:\n\n${mode()}\n\nOwner rules (`)).toBe(true);
		expect((await spawn("fake", session)).opts.systemNote).toBe(steerContract(token));
	});

	test("only omp keeps its contract in the system prompt", () => {
		expect(omp.caps.modeInSystem).toBe(true);
		expect(omo.caps.modeInSystem).toBeUndefined();
		expect(claude.caps.modeInSystem).toBeUndefined();
	});
});
