// The stronger-model proposal (hub/escalate.ts): the candidate rules and the one-card, one-session life of a proposal.
// Everything outside is a seam: the clock, the state file, the card poster, the launcher, the note to the asker and the stop.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisions } from "./choices.ts";
import { createEscalations, pickCandidate, type Configured, type LaunchRequest } from "./escalate.ts";

// Made-up providers and models, ranked by the roles this install would give them.
const BIG = "acme/big-model", MID = "acme/mid-model", SMALL = "acme/small-model", PRIVATE = "acme/private-model";
const roles: Configured[] = [
	{ role: "orchestrator", selector: `${BIG}:high` },
	{ role: "lanes", selector: `${MID}:medium` },
	{ role: "workers", selector: `${SMALL}:high` },
];
const none = () => undefined;

describe("pickCandidate", () => {
	test("the nearest configured model ranked above the asker's, at the higher of the two thinking levels", () => {
		expect(pickCandidate({ current: `${SMALL}:high`, configured: roles, ownerOnly: none })).toBe(`${MID}:high`);
		expect(pickCandidate({ current: `${MID}:low`, configured: roles, ownerOnly: none })).toBe(`${BIG}:high`);
	});
	test("a model the guards keep for the owner is skipped; the asker's own model one level up comes next", () => {
		const ownerOnly = (s: string) => (s.startsWith(BIG) || s.endsWith(":xhigh") ? "kept for the owner" : undefined);
		expect(pickCandidate({ current: `${MID}:medium`, configured: roles, ownerOnly })).toBe(`${MID}:high`);
		expect(pickCandidate({ current: `${MID}:high`, configured: roles, ownerOnly })).toBe(`${MID}:max`);
	});
	test("only configured role models are offered: a logged-in model no role uses (a key-only fallback) is not", () => {
		const available = [{ selector: PRIVATE }, { selector: MID, thinking: ["low", "medium"] }];
		const configured: Configured[] = [{ role: "lanes", selector: `${MID}:medium` }];
		expect(pickCandidate({ current: `${MID}:medium`, configured, available, ownerOnly: none })).toBeUndefined();
	});
	test("a model the runtime does not list, or a level it does not accept, is not offered", () => {
		const available = [{ selector: SMALL }, { selector: MID, thinking: ["medium", "high"] }];
		expect(pickCandidate({ current: `${SMALL}:high`, configured: roles, available, ownerOnly: none })).toBe(`${MID}:high`);
		expect(pickCandidate({ current: `${MID}:high`, configured: roles, available, ownerOnly: s => (s.startsWith(BIG) ? "owner" : undefined) })).toBeUndefined();
	});
	test("nothing stronger: no candidate", () => {
		expect(pickCandidate({ current: `${BIG}:max`, configured: roles, ownerOnly: none })).toBeUndefined();
	});
});

type Posted = { target: string; text: string; source: string };
let dir: string;
let posted: Posted[], launched: LaunchRequest[], told: { asker: string; text: string }[], stopped: string[];
let launchAnswer: { lane: string } | { error: string };
const make = () =>
	createEscalations({
		file: join(dir, "escalations.json"),
		now: () => Date.parse("2026-11-12T00:00:00Z"),
		post: (target, text, source) => void posted.push({ target, text, source }),
		launch: async req => (launched.push(req), launchAnswer),
		tell: (asker, text) => void told.push({ asker, text }),
		stop: lane => void stopped.push(lane),
	});
const ask = { asker: "lane:parser", cwd: "/home/user/repo", current: `${MID}:medium`, offer: `${MID}:high`, step: "rewrite the tokenizer's state machine", reason: "three attempts broke the escape cases", est: 12, brief: "/home/user/.dotz/lanes/parser/brief.md", report: "/home/user/.dotz/lanes/parser/report.md" };
const options = (text: string) => parseDecisions(text).blocks[0]!.options.map(o => o.label);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "escalate-"));
	posted = [];
	launched = [];
	told = [];
	stopped = [];
	launchAnswer = { lane: "parser-up" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a proposal", () => {
	test("goes to the owner as one decision card and launches nothing by itself", async () => {
		const e = make();
		const r = await e.propose(ask);
		expect("ok" in r).toBe(true);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ target: "lane:parser", source: "lane:parser" });
		expect(options(posted[0]!.text)).toHaveLength(2);
		expect(launched).toEqual([]);
	});
	test("a conversation session's card goes to its own conversation", async () => {
		await make().propose({ ...ask, asker: "ch:123" });
		expect(posted[0]).toMatchObject({ target: "ch:123", source: "orchestrator" });
	});
	test("no candidate: refused with a reason and no card", async () => {
		const r = await make().propose({ ...ask, offer: undefined });
		expect("refused" in r && r.refused.length > 0).toBe(true);
		expect(posted).toEqual([]);
	});
	test("one per session: a second call is refused while the first waits, and after a no", async () => {
		const e = make();
		await e.propose(ask);
		const again = await e.propose(ask);
		expect("refused" in again).toBe(true);
		expect(posted).toHaveLength(1);
		const [, no] = options(posted[0]!.text);
		expect(await e.answer({ to: "lane:parser", label: no! })).toBe("declined");
		expect(told).toHaveLength(1);
		expect(launched).toEqual([]);
		expect("refused" in (await make().propose(ask))).toBe(true);
		expect(posted).toHaveLength(1);
	});
	test("yes launches one new session on the offered model with the step and the handover paths, as the asker's session", async () => {
		const e = make();
		await e.propose(ask);
		const [yes] = options(posted[0]!.text);
		expect(await e.answer({ to: "lane:parser", label: yes! })).toBe("started");
		expect(launched).toHaveLength(1);
		const req = launched[0]!;
		expect(req).toMatchObject({ model: `${MID}:high`, session: "lane:parser", cwd: "/home/user/repo", est: 12 });
		expect(req.name).not.toBe("parser");
		for (const part of [ask.step, ask.brief, ask.report]) expect(req.brief).toContain(part);
		expect(told).toHaveLength(1);
		expect("refused" in (await e.propose(ask))).toBe(true);
	});
	test("a gate refusal is told to the asker as it is and does not use up the proposal", async () => {
		launchAnswer = { error: "budget gate: 5h window 20% left" };
		const e = make();
		await e.propose(ask);
		const [yes] = options(posted[0]!.text);
		expect(await e.answer({ to: "lane:parser", label: yes! })).toBe("refused");
		expect(told[0]!.text).toContain("budget gate: 5h window 20% left");
		expect("ok" in (await e.propose(ask))).toBe(true);
	});
	test("an answer from another conversation or with another label does nothing", async () => {
		const e = make();
		await e.propose(ask);
		const [yes] = options(posted[0]!.text);
		expect(await e.answer({ to: "lane:other", label: yes! })).toBe("none");
		expect(await e.answer({ to: "lane:parser", label: "something else" })).toBe("none");
		expect(launched).toEqual([]);
	});
	test("the new session's final report ends it; a progress report does not", async () => {
		const e = make();
		await e.propose(ask);
		await e.answer({ to: "lane:parser", label: options(posted[0]!.text)[0]! });
		expect(e.reported("parser-up", "run")).toBe(false);
		expect(e.reported("parser", "done")).toBe(false);
		expect(e.reported("parser-up", "done")).toBe(true);
		expect(stopped).toEqual(["parser-up"]);
	});
});
