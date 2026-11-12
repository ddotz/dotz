// A conversation session that starts fresh because an owner message arrived must not list that message as an open request in its start
// prompt (the ledger block of the recall): it comes next as its own turn, and the first run has no prompt, so an answer made from the
// open-requests line goes to no message and the real turn answers it again (quick chat, web:quick: the owner got two answers). Older
// open requests that are not being delivered now stay listed. The orchestrator is a fake; the queue is the real one.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConvSessions, type BgWork, type Conv, type Prompts } from "./convsessions.ts";
import type { Orchestrator, OrchOpts } from "./orchestrator.ts";
import { createPrompts } from "./prompts.ts";
import { openRequestsBlock, type LedgerEntry } from "./recall-parts.ts";
import { MAIN } from "./session-key.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_000_000;
const entry = (id: string, target: string, text: string): LedgerEntry => ({ id, target, at: NOW - 60_000, text, state: "queued" });

// quick chat, a project channel (ch:), a mail conversation and a thread: the same rule for every conversation session.
for (const [target, key] of [["web:quick", "quick"], ["ch:1", "ch:1"], ["mail:m1", "mail:m1"], ["th:7", "th:7"]] as const) {
	test(`${key}: the message that starts the session is not an open request in its start prompt; an older open one still is`, () => {
		const dir = mkdtempSync(join(tmpdir(), "convs-owed-"));
		dirs.push(dir);
		let startBlock: string | undefined;
		const q = createPrompts({ deliver: () => (startBlock ??= block()), steer: () => true, working: () => false, note: (_t, _r, text) => text, isNote: () => false, post: async () => ({ delivered: true }), clearProgress: () => {}, persist: () => {}, log: () => {} });
		const fake = (): Orchestrator => ({ orch: { status: "idle", ctx: { tokens: 0, compaction: { state: "idle" } } }, orchestratorPid: () => undefined, heldCount: () => 0, lastTurnEndAt: () => 0, applyModelChange: () => "next-start" }) as unknown as Orchestrator;
		let made: OrchOpts | undefined;
		const registry = createConvSessions({
			on: () => true,
			quick: () => true,
			kinds: () => undefined,
			maxLive: () => 3,
			idleMin: () => 20,
			mailOf: () => undefined,
			make: (o: OrchOpts) => ((made = o), fake()),
			wire: () => ({ queue: q as unknown as Prompts, bg: { list: () => [], running: () => 0 } as unknown as BgWork }),
			dataDir: dir,
			history: () => [],
			workers: () => 0,
			workerPin: () => "main-pin",
			log: () => {},
			now: () => NOW,
		});
		registry.setMain({ key: MAIN, o: fake(), queue: q, bg: { list: () => [], running: () => 0 } as unknown as BgWork } as unknown as Parameters<typeof registry.setMain>[0]);
		// The start prompt as orchestrator.ts builds it: the conversation's ledger file, minus what the session still owes a turn.
		const block = () => openRequestsBlock(made!.env!.DOTZ_LEDGER_FILE!, "UTC", NOW, made!.skipOpen!());
		const c = registry.ensure(key);
		expect(c.key).toBe(key);
		writeFileSync(made!.env!.DOTZ_LEDGER_FILE!, JSON.stringify([entry("old1", target, "older question"), entry("new1", target, "brand new question")]));
		registry.deliverTo(key, `[dotz inbox] ${target} msg=new1\nbrand new question`, { target, replyTo: "new1", refs: ["new1"], owner: true });
		expect(startBlock).toBeDefined();
		expect(startBlock).toContain("old1");
		expect(startBlock).not.toContain("new1");
		expect(startBlock).not.toContain("brand new question");
	});
}
