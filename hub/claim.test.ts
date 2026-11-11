// A lane's [done] report is only a claim ("reported"); the orchestrator's verify makes it "verified"; the next report that
// is not [done] withdraws it. Lanes run on a minimal fake runtime adapter (the same approach as runtime/fake-adapter.test.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Lanes from "./lanes.ts";
import { cfg } from "./config.ts";
import { msg } from "./i18n.ts";
import { adapters } from "./runtime/index.ts";
import { omp } from "./runtime/omp.ts";
import { advance, flush } from "./runtime/test-clock.ts";
import type { AgentEvent, AgentProcess, RuntimeAdapter } from "./runtime/types.ts";

const DATA = process.env.DOTZ_DIR!;
// The lane state is one shared module (lanestate.ts): reset it so the scenario test driving it in this same process does not leak in.
const l: typeof Lanes = await import("./lanes.ts");
(await import("./lanestate.ts")).resetLaneStateForTest();

class FakeAgent implements AgentProcess {
	pid = 7100;
	private queue: AgentEvent[] = [];
	private wake = Promise.withResolvers<void>();
	private exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly events = this.stream();
	private async *stream(): AsyncGenerator<AgentEvent> {
		for (;;) {
			while (this.queue.length) yield this.queue.shift()!;
			await this.wake.promise;
			this.wake = Promise.withResolvers<void>();
		}
	}
	async push(...events: AgentEvent[]): Promise<void> {
		this.queue.push(...events);
		this.wake.resolve();
		await flush();
	}
	send = () => {};
	abort = () => {};
	compact = () => {};
	refreshUsage = () => {};
	refreshSession = () => {};
	watchSubagents = () => {};
	kill = () => this.exit.resolve(0);
}

const agents: FakeAgent[] = [];
const fake: RuntimeAdapter = {
	id: "omp",
	caps: { steer: "native", subagents: "none", contextNumbers: "none", compact: "none", sessionTranscript: false, promptCacheKeepalive: false },
	start() {
		const agent = new FakeAgent();
		agents.push(agent);
		return agent;
	},
	classifyError: omp.classifyError,
	recentExchanges: () => undefined,
};

const savedCfg = { lanes: cfg.lanes };
beforeAll(() => {
	adapters.fake = fake;
	cfg.lanes = { ...cfg.lanes, runtime: "fake" };
});
afterAll(() => {
	delete adapters.fake;
	Object.assign(cfg, savedCfg);
});

// One lane turn ending with `text` as its final message (the report).
async function turn(agent: FakeAgent, text: string): Promise<void> {
	await agent.push({ type: "alive" }, { type: "turn_start" }, { type: "assistant", text, stop: "stop" }, { type: "turn_end" });
	await advance(500);
}
const saved = () => JSON.parse(readFileSync(join(DATA, "lanes", "cl", "lane.json"), "utf8")).claim;

test("claim: [done] reports, verify only from reported, any other report clears it", async () => {
	const cwd = join(DATA, "claim-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "cl"), { recursive: true, force: true });
	l.setReportHandler(() => {});
	l.setIdleHandler(() => {});
	const lane = l.launch("cl", cwd, "Build it.\nDone when: tests pass");
	const agent = agents.at(-1)!;
	await advance(3000);

	// A progress-style report is no claim, so there is nothing to verify.
	await turn(agent, "still working on it");
	expect(lane.claim).toBeUndefined();
	expect(() => l.verifyLane("cl", "ran the tests")).toThrow("no reported-done claim");
	expect(l.claimPrefix("cl")).toBe("");

	await turn(agent, "[done] all green");
	expect(lane.claim).toMatchObject({ state: "reported" });
	expect(saved()).toMatchObject({ state: "reported" });
	expect(l.claimPrefix("cl")).toBe("reported · ");

	expect(() => l.verifyLane("cl", "  ")).toThrow("needs evidence");
	expect(lane.claim?.state).toBe("reported");
	l.verifyLane("cl", "bun test: 12 pass, 0 fail");
	expect(lane.claim).toMatchObject({ state: "verified", evidence: "bun test: 12 pass, 0 fail" });
	expect(saved()).toMatchObject({ state: "verified", evidence: "bun test: 12 pass, 0 fail" });
	expect(l.claimPrefix("cl")).toBe("verified · ");
	// Verified is final until the lane reports again.
	expect(() => l.verifyLane("cl", "again")).toThrow("already verified");

	await turn(agent, "[done] one more change");
	expect(lane.claim?.state).toBe("reported");
	// New work sent to the lane withdraws an unchecked claim.
	l.sendToLane("cl", "also fix the README");
	expect(lane.claim).toBeUndefined();
	await turn(agent, "[done] README fixed");
	expect(lane.claim?.state).toBe("reported");
	// OmO's handoff block, posted as its own turn after the [done], is no new report: the claim stays verifiable.
	await turn(agent, "Ask: fix the README - wanted: a fixed README. For you: done.");
	expect(lane.claim?.state).toBe("reported");
	await turn(agent, "[ask] which branch?\n\n결정: which branch?\n**1) main**\n**2) dev**");
	expect(lane.claim).toBeUndefined();
	expect(saved()).toBeUndefined();
	// A final report that opens with the handoff block and says [done] below it is a claim too (2026-10-21).
	await turn(agent, "Ask: pick the branch - wanted: main. For you: merged.\n\n[done] merged to main");
	expect(lane.claim?.state).toBe("reported");
	await turn(agent, "[ask] which branch?\n\n결정: which branch?\n**1) main**\n**2) dev**");
	expect(lane.claim).toBeUndefined();
	expect(() => l.verifyLane("nope", "x")).toThrow("no lane nope");

	l.sendToLane("cl", "main, please"); // answers the pending [ask], so it does not leak into other tests' pending-ask blocks
	l.stopLane("cl");
	await advance(300);
});

// 2026-10-20 fix5-block: an OmO lane's final report opened with its handoff block ("Ask: ...") and carried "[done]" further
// down, so no tone was parsed and the task-metadata check never ran although a nested spawn had been depth-refused.
test("claim: a report without a tone marker is checked against OmO task metadata too; a contradiction goes along with it", async () => {
	const cwd = join(DATA, "claim-work");
	mkdirSync(cwd, { recursive: true });
	rmSync(join(DATA, "lanes", "cb"), { recursive: true, force: true });
	const agentDir = join(DATA, "omo-agent-cb");
	const root = "01a15708-ce99-764c-8217-6527175aa850";
	mkdirSync(join(agentDir, "sessions", "--w--"), { recursive: true });
	const session = join(agentDir, "sessions", "--w--", `2026-10-20T01-59-17-000Z_${root}.jsonl`);
	writeFileSync(session, "");
	const store = join(agentDir, "projects", "w-1", "senpi-task");
	mkdirSync(join(store, "tasks"), { recursive: true });
	mkdirSync(join(store, "children", "st_9", "sessions", "st_9"), { recursive: true });
	writeFileSync(join(store, "tasks", "st_9.json"), JSON.stringify({ task_id: "st_9", status: "completed", root_session_id: root, category: "quick", updated_at: "2100-01-01T00:00:00Z" }));
	const refused = { type: "message", timestamp: "2100-01-01T00:00:00Z", message: { role: "toolResult", toolName: "task", isError: false, content: [{ type: "text", text: "Subagent nesting limit reached: this spawn would run at depth 3, beyond max_depth 2." }] } };
	writeFileSync(join(store, "children", "st_9", "sessions", "st_9", "a.jsonl"), JSON.stringify(refused));
	// The check reads files (real I/O), so the test waits for the relayed report itself; bun's test timeout bounds it.
	const relayed = Promise.withResolvers<string>();
	l.setReportHandler((_lane, text) => relayed.resolve(text));
	l.setIdleHandler(() => {});
	l.launch("cb", cwd, "Relay it.\nDone when: relayed");
	const agent = agents.at(-1)!;
	await agent.push({ type: "session", ref: session });
	await advance(3000);
	await turn(agent, "Ask: relay the nested answer.\nFor you: [done] DEEP-OK");
	const text = await relayed.promise;
	expect(text).toContain(msg().checkContradicted(1));
	expect(text).not.toContain("st_9: task spawn failed");
	l.stopLane("cb");
	await advance(300);
});


// Proposal #1 (dori signals.ts / done-flow.ts): a machine-checkable Done-when is read back by the gateway itself on [done]:
// a failure goes back to the lane (no report reaches the orchestrator), a pass marks the claim verified with no verify call.
test("claim: the gateway checks a machine-checkable Done-when on [done], sends failures back to the lane, verifies a pass", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dotz-claim-gw-"));
	rmSync(join(DATA, "lanes", "gw"), { recursive: true, force: true });
	const reports: string[] = [];
	let relayed = Promise.withResolvers<string>();
	let noticed = Promise.withResolvers<string>();
	const verified = Promise.withResolvers<string>();
	l.setReportHandler((_lane, text) => (reports.push(text), relayed.resolve(text)));
	l.setNoticeHandler((_lane, text) => noticed.resolve(text));
	l.setVerifiedHandler(name => verified.resolve(name));
	l.setIdleHandler(() => {});
	const lane = l.launch("gw", cwd, "Write the result.\nDone when: file result.md; command `test -s result.md`");
	const agent = agents.at(-1)!;
	const sent: string[] = [];
	agent.send = (text: string) => void sent.push(text);
	await advance(3000);

	await turn(agent, "[done] result written");
	const back = await noticed.promise;
	expect(back).toContain(msg().checkBounced(2, 2));
	expect(back).not.toContain("NOT file result.md -> missing");
	expect(sent.at(-1)).toContain("[gateway check] Your [done] is not verified");
	expect(lane.claim).toBeUndefined();
	expect(reports).toEqual([]);

	writeFileSync(join(cwd, "result.md"), "done\n");
	await turn(agent, "[done] now it is there");
	const text = await relayed.promise;
	expect(text).toContain(msg().checkPassed(2, false));
	expect(await verified.promise).toBe("gw");
	expect(lane.claim).toMatchObject({ state: "verified" });
	expect(JSON.parse(readFileSync(join(DATA, "lanes", "gw", "lane.json"), "utf8")).claim).toMatchObject({ state: "verified" });
	expect(() => l.verifyLane("gw", "again")).toThrow("already verified");
	l.stopLane("gw");
	await advance(300);
});

// The owner reads the gateway's verdict without the raw check lines (they stay in hub.log and the claim's evidence).
test("claim: a verified report's owner-facing text carries no shell syntax", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dotz-claim-gw-quiet-"));
	rmSync(join(DATA, "lanes", "wq"), { recursive: true, force: true });
	const relayed = Promise.withResolvers<string>();
	const verified = Promise.withResolvers<string>();
	l.setReportHandler((_lane, text) => relayed.resolve(text));
	l.setVerifiedHandler(name => verified.resolve(name));
	l.setIdleHandler(() => {});
	l.launch("wq", cwd, "Write it.\nDone when: command `printf 'stdout~\\n'`");
	const agent = agents.at(-1)!;
	await advance(3000);

	await turn(agent, "[done] written");
	const text = await relayed.promise;
	expect(await verified.promise).toBe("wq");
	expect(text).not.toContain("stdout~");
	expect(text).not.toContain("exit 0");
	expect(text).not.toContain("[gateway check]");
	l.stopLane("wq");
	await advance(300);
});

const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

// Proposal #4 (dori done-flow.ts:54): a lane whose lane/<name> branch is not merged into its base is not "verified".
test("claim: verify refuses a lane whose branch is not merged into its base, unless forced; merged passes", async () => {
	const repo = mkdtempSync(join(tmpdir(), "dotz-claim-land-"));
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "one");
	for (const n of ["ld", "lf"]) rmSync(join(DATA, "lanes", n), { recursive: true, force: true });
	l.setReportHandler(() => {});
	l.setNoticeHandler(() => {});
	l.setIdleHandler(() => {});
	const lane = l.launch("ld", repo, "Change a.\nDone when: owner approves");
	const agent = agents.at(-1)!;
	await advance(3000);
	const wt = lane.worktree!.path;
	writeFileSync(join(wt, "a.txt"), "2\n");
	git(wt, "commit", "-qam", "two");
	await turn(agent, "[done] changed");
	expect(() => l.verifyLane("ld", "looked at it")).toThrow("lane ld is not landed: its HEAD has commits not in main");
	expect(lane.claim?.state).toBe("reported");
	git(repo, "merge", "-q", "--ff-only", "lane/ld");
	l.verifyLane("ld", "merged, a.txt is 2");
	expect(lane.claim?.state).toBe("verified");
	l.stopLane("ld");
	await advance(300);

	// Work that stays unmerged on purpose (a PR under review) is verified only with force, the reason in the evidence.
	const forced = l.launch("lf", repo, "Change b.\nDone when: owner approves");
	const fa = agents.at(-1)!;
	await advance(3000);
	writeFileSync(join(forced.worktree!.path, "b.txt"), "1\n");
	await turn(fa, "[done] b added");
	expect(() => l.verifyLane("lf", "b added")).toThrow("uncommitted changes");
	l.verifyLane("lf", "kept unmerged: PR under review", true);
	expect(forced.claim?.state).toBe("verified");
	l.stopLane("lf");
	await advance(300);
});
