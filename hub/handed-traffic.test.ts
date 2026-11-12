// Traffic between sessions: text one session hands to another is a record of the receiving conversation, its answer notifies the owner only
// when an owner message still waits behind it (or it is an [ask] / [fail]), and the handed request closes with its handback.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_TOKEN } from "./config.ts";
import { convs } from "./convsessions.ts";
import { onEmit, type HubEvent } from "./events.ts";
import { feed, resetNoticesForTest, unreadCount } from "./notices-store.ts";
import { createLedger } from "./open-ledger.ts";
import { queue } from "./outbound.ts";
import { createPrompts, type PromptDeps, type WorkRow } from "./prompts.ts";
import { LONG_TURN_MS, classify } from "./push.ts";
import { ledgerIn, loadLedger } from "./recall-parts.ts";
import { makeRoute } from "./routes.ts";
import { MAIN, primaryTarget } from "./session-key.ts";

process.env.DOTZ_NO_ORCHESTRATOR = "1";
afterAll(() => delete process.env.DOTZ_NO_ORCHESTRATOR);
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as never });
const send = (key: string, body: object) => route(new Request(`http://hub.test/api/conv-sessions/${encodeURIComponent(key)}/send`, { method: "POST", headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));
const seen: HubEvent[] = [];
onEmit(e => seen.push(e));
const handed = (conv: string) => seen.filter(e => e.kind === "handed" && e.channel === conv);

test("text main hands to a conversation is stored as an event of that conversation, naming the sender", async () => {
	convs.ensure("ch:91");
	await send("ch:91", { text: "check the second item" });
	expect(handed("ch:91")).toMatchObject([{ source: "session", from: MAIN, text: "check the second item" }]);
	expect(handed("ch:91")[0]).not.toHaveProperty("handback");
});

test("text a conversation hands to main is stored in main's conversation, and main's handback in the sender's", async () => {
	convs.ensure("ch:92");
	await send(MAIN, { text: "please look at this", from: "ch:92" });
	expect(handed(primaryTarget(MAIN))).toMatchObject([{ from: "ch:92", text: "please look at this" }]);
	const prompt = `[conversation ch:92] please look at this`;
	queue.onPrompt(prompt);
	queue.onAnswer("here is what I found");
	expect(handed("ch:92")).toMatchObject([{ from: MAIN, handback: true, text: "here is what I found" }]);
});

test("send with quiet: true marks the handed prompt as bookkeeping between sessions", async () => {
	convs.ensure("ch:93");
	await send("ch:93", { text: "note for you", quiet: true });
	expect(convs.get("ch:93")!.queue.queued().at(-1)).toMatchObject({ text: "[main session] note for you", bookkeeping: true });
	await send("ch:93", { text: "a request" });
	expect(convs.get("ch:93")!.queue.queued().at(-1)).not.toHaveProperty("bookkeeping");
});

type Post = { target: string; text: string; replyTo?: string; hushed?: true };
function prompts(extra: Partial<PromptDeps> = {}) {
	const state = { working: false, posts: [] as Post[], back: [] as { from: string; text: string }[] };
	const q = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => state.working,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async (target, text, replyTo, opts) => (state.posts.push({ target, text, replyTo, ...opts }), { delivered: true }),
		clearProgress: () => {},
		handBack: (from, text) => void state.back.push({ from, text }),
		persist: () => {},
		log: () => {},
		answered: [],
		recent: () => [],
		...extra,
	});
	const turn = (text: string, reply: Parameters<typeof q.deliver>[1]) => {
		q.deliver(text, reply);
		state.working = true;
		q.onPrompt(text);
	};
	return { q, state, turn };
}

test("an answer to a handback with no owner message behind it is stored without a notification; [ask] and [fail] keep theirs", () => {
	const quiet = prompts();
	quiet.turn("[handback] result", { target: "ch:1", handback: true });
	quiet.q.onAnswer("noted, nothing changed");
	expect(quiet.state.posts).toMatchObject([{ target: "ch:1", text: "noted, nothing changed", hushed: true }]);

	for (const text of ["[ask] which one?", "[fail] could not do it"]) {
		const loud = prompts();
		loud.turn("[handback] result", { target: "ch:1", handback: true });
		loud.q.onAnswer(text);
		expect(loud.state.posts[0]).toMatchObject({ text });
		expect(loud.state.posts[0]).not.toHaveProperty("hushed");
	}
});

test("an answer to a handback behind an owner message that still waits notifies; once that message is answered it does not", () => {
	const waiting = prompts();
	waiting.turn("[handback] result", { target: "ch:1", replyTo: "m1", handback: true });
	waiting.q.onAnswer("here is the outcome");
	expect(waiting.state.posts[0]).not.toHaveProperty("hushed");

	const answered = prompts();
	answered.turn("[handback] result", { target: "ch:1", replyTo: "m2", handback: true });
	answered.q.markAnswered("m2");
	answered.q.onAnswer("a second look");
	expect(answered.state.posts.every(p => p.hushed === true)).toBe(true);
});

test("an answer to bookkeeping text follows the same rule", () => {
	const s = prompts();
	s.turn("[main session] note", { target: "ch:1", bookkeeping: true });
	s.q.onAnswer("got it");
	expect(s.state.posts).toMatchObject([{ text: "got it", hushed: true }]);
	const loud = prompts();
	loud.turn("[main session] note", { target: "ch:1", bookkeeping: true });
	loud.q.onAnswer("[ask] need a decision");
	expect(loud.state.posts[0]).not.toHaveProperty("hushed");
});

test("a stored answer marked hushed gives no push and no bell item; the same answer unmarked does", () => {
	const answer = { ts: "2026-11-12T10:00:00.000Z", kind: "out", source: "orchestrator", target: "ch:5", text: "the second item looks fine" };
	expect(classify(answer, LONG_TURN_MS + 1)).toBeDefined();
	expect(classify({ ...answer, hushed: true }, LONG_TURN_MS + 1)).toBeUndefined();
	resetNoticesForTest();
	feed({ ...answer, hushed: true });
	expect(unreadCount()).toBe(0);
	feed(answer);
	expect(unreadCount()).toBe(1);
});

const FROM = { target: "ch:1", from: "ch:1" } as const;

test("the open list names each worker once and leaves out a finished one", () => {
	const rows: WorkRow[] = [];
	const s = prompts({ work: () => rows });
	for (const ids of [["st_a", "st_b"], ["st_c", "st_d"]]) {
		s.turn(`[conversation ch:1] request ${ids[0]}`, FROM);
		for (const id of ids) rows.push({ id, status: "running", startedAt: Date.now() });
		s.q.workersSpawned(ids.map(id => ({ id })));
		s.q.onAnswer("later\n\n[later]");
		s.state.working = false;
		s.q.settleTurn();
	}
	rows.find(r => r.id === "st_a")!.status = "done";
	for (const r of s.q.openRequests()) {
		const ids = r.workers.map(w => w.id);
		expect(ids).toEqual([...new Set(ids)]);
		expect(ids).not.toContain("st_a");
	}
	const dir = mkdtempSync(join(tmpdir(), "handed-"));
	const ledger = createLedger(ledgerIn(dir), { isAnswered: () => false, write: (f, t) => writeFileSync(f, t), log: () => {} });
	const open = [{ text: "request", at: 1000, target: "ch:1", from: "ch:1", deferred: true as const }];
	const waiting = [1, 2].map(() => ({ target: "ch:1", at: 1000, workers: [{ id: "st_x" }, { id: "st_y" }] }));
	ledger.sync(open, waiting);
	expect(loadLedger(ledgerIn(dir)).map(e => e.workers)).toEqual([["st_x", "st_y"]]);
	rmSync(dir, { recursive: true, force: true });
});

test("a handback closes the handed request it answers, whose workers are finished", () => {
	const rows: WorkRow[] = [];
	const s = prompts({ work: () => rows });
	s.turn("[conversation ch:1] request", FROM);
	rows.push({ id: "st_a", status: "running", startedAt: Date.now() });
	s.q.workersSpawned([{ id: "st_a" }]);
	s.q.onAnswer("later\n\n[later]");
	s.state.working = false;
	s.q.settleTurn();
	expect(s.q.openRequests()).toHaveLength(1);

	rows[0]!.status = "done";
	rows[0]!.endedAt = Date.now();
	s.turn("[conversation ch:1] one more thing", FROM);
	s.q.onAnswer("the whole report");
	expect(s.state.back).toMatchObject([{ from: "ch:1", text: "the whole report" }]);
	expect(s.q.openRequests()).toEqual([]);
});
