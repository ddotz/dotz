// The user's 금지 낱말 목록 on a turn's final answer, at the prompt queue (hub/prompts.ts): an answer with a listed word is held and its
// session gets the note as that request's next prompt; the rewritten answer is the one posted, to the original target and reply id.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerReview } from "./answer-words.ts";
import { createPrompts, type Pending, type PromptDeps, type Reply } from "./prompts.ts";
import { wordsFile } from "./word-ban.ts";

const HIT = "zxqword";
const REQUEST: Reply = { target: "web", replyTo: "m1", owner: true };
let NOTE = "";

beforeAll(() => {
	mkdirSync(join(wordsFile(), ".."), { recursive: true });
	writeFileSync(wordsFile(), JSON.stringify({ words: [{ word: HIT, use: "example" }] }));
	NOTE = answerReview(() => true)(HIT)!;
});
afterAll(() => rmSync(wordsFile(), { force: true }));

function setup() {
	const state = { working: false, keepalive: false, canTake: true, delivered: [] as { text: string; owner?: boolean }[], posts: [] as { target: string; text: string; replyTo?: string }[], saved: [] as Pending[][] };
	const deps = {
		deliver: (text: string, owner?: boolean) => void state.delivered.push({ text, owner }),
		steer: () => true,
		working: () => state.working,
		keepalive: () => state.keepalive,
		note: (_t: string, _r: string | undefined, text: string) => `[note] ${text}`,
		isNote: (text: string) => text.startsWith("[note]"),
		post: async (target: string, text: string, replyTo?: string) => (state.posts.push({ target, text, replyTo }), { delivered: true }),
		review: answerReview(() => state.canTake),
		clearProgress: () => {},
		persist: (open: Pending[]) => void state.saved.push(open),
		log: () => {},
	} as PromptDeps;
	const q = createPrompts(deps);
	// The user's message starts a turn.
	const startTurn = (text = "question", reply: Reply = REQUEST) => {
		q.deliver(text, reply);
		state.working = true;
		q.onPrompt(text);
	};
	// The turn's run goes idle, as the orchestrator's idle handler reports it.
	const idle = () => {
		state.working = false;
		q.settleTurn();
	};
	const posted = async () => (await Promise.resolve(), state.posts.map(p => [p.target, p.text, p.replyTo]));
	const notes = () => state.delivered.filter(d => d.text === NOTE);
	return { q, state, startTurn, idle, posted, notes };
}

const FIRST = `first answer with ${HIT} in it`;

test("order (i): the note is taken inside the same run and a second stop follows: one answer, the rewritten one, to the original target and reply id", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(FIRST);
	expect(await t.posted()).toEqual([]);
	expect(t.notes()).toEqual([{ text: NOTE, owner: false }]);

	// The runtime takes the note in the run that is still going, and the model stops again.
	expect(t.q.onPrompt(NOTE)).toBe(false);
	t.q.onAnswer("rewritten answer");
	expect(await t.posted()).toEqual([["web", "rewritten answer", "m1"]]);

	t.idle();
	expect(await t.posted()).toEqual([["web", "rewritten answer", "m1"]]);
	expect(t.q.isAnswered("m1")).toBe(true);
});

test("order (ii): the run goes idle first and the note runs as its own turn: one answer, the rewritten one, to the original target and reply id", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(FIRST);
	t.idle();
	// The idle turn-end must not post the held text through its last-text net.
	expect(await t.posted()).toEqual([]);

	t.state.working = true;
	t.q.onPrompt(NOTE);
	t.q.onAnswer("rewritten answer");
	t.idle();
	expect(await t.posted()).toEqual([["web", "rewritten answer", "m1"]]);
	expect(t.q.isAnswered("m1")).toBe(true);
});

test("the note is a gateway note: not an owner prompt, and the open list holds the one request, not a second", () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(FIRST);
	expect(t.state.delivered.at(-1)).toEqual({ text: NOTE, owner: false });
	const open = t.state.saved.at(-1)!;
	expect(open.map(p => [p.target, p.replyTo])).toEqual([["web", "m1"]]);
});

test("the rewrite turn writes nothing: the held text is delivered once as it was", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(FIRST);
	t.idle();
	t.state.working = true;
	t.q.onPrompt(NOTE);
	t.idle();
	expect(await t.posted()).toEqual([["web", FIRST, "m1"]]);
	t.idle();
	expect(await t.posted()).toHaveLength(1);
});

test("the rewrite turn answers with the no-op word: the held text is delivered once as it was", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(FIRST);
	t.q.onPrompt(NOTE);
	t.q.onAnswer("-");
	t.idle();
	expect(await t.posted()).toEqual([["web", FIRST, "m1"]]);
});

test("the session cannot take the note (stopped, starting, paused): the held text is delivered at once", async () => {
	const t = setup();
	t.startTurn();
	t.state.canTake = false;
	t.q.onAnswer(FIRST);
	expect(await t.posted()).toEqual([["web", FIRST, "m1"]]);
	expect(t.notes()).toEqual([]);
});

test("a second hit in the rewrite is delivered as it is: no loop, one note in all", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(`first ${HIT}`);
	t.q.onPrompt(NOTE);
	t.q.onAnswer(`second ${HIT}`);
	expect(await t.posted()).toEqual([["web", `second ${HIT}`, "m1"]]);
	expect(t.notes()).toHaveLength(1);
});

test("a clean answer is not held", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer("fine answer");
	expect(await t.posted()).toEqual([["web", "fine answer", "m1"]]);
	expect(t.notes()).toEqual([]);
});

test("[later], the no-op answer, a keepalive and a turn that answers no request are not checked", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(`[later] ${HIT}`);
	t.q.onAnswer("-");
	expect(t.notes()).toEqual([]);

	const k = setup();
	k.startTurn();
	k.state.keepalive = true;
	k.q.onAnswer(`ok ${HIT}`);
	expect(k.notes()).toEqual([]);

	const none = setup();
	none.q.deliver("a session report");
	none.state.working = true;
	none.q.onPrompt("a session report");
	none.q.onAnswer(HIT);
	expect(none.notes()).toEqual([]);
	expect(await none.posted()).toEqual([]);
});

test("an answer the turn already sent with dotz_send is not posted again, and parts held for the final answer go out with the rewrite", async () => {
	const t = setup();
	t.startTurn();
	t.q.sent("web", "already sent part");
	t.q.onAnswer(HIT);
	t.q.onPrompt(NOTE);
	t.q.onAnswer("already sent part");
	expect(await t.posted()).toEqual([]);

	const h = setup();
	h.startTurn();
	expect(h.q.holdEarly("web", "early part", "m1")).toBe(true);
	h.q.onAnswer(HIT);
	expect(await h.posted()).toEqual([]);
	h.q.onPrompt(NOTE);
	h.q.onAnswer("clean rest");
	expect(await h.posted()).toEqual([["web", "early part\n\nclean rest", "m1"]]);
});

test("a gateway restart between the hold and the rewrite replays the note and still ends with one answer", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer(FIRST);
	const open = t.state.saved.at(-1)!;

	for (const rewrites of [true, false]) {
		const again = setup();
		expect(again.q.replay(structuredClone(open), x => x)).toBe(1);
		expect(again.notes()).toEqual([{ text: NOTE, owner: false }]);
		again.state.working = true;
		again.q.onPrompt(NOTE);
		if (rewrites) again.q.onAnswer("rewritten answer");
		again.idle();
		expect(await again.posted()).toEqual([["web", rewrites ? "rewritten answer" : FIRST, "m1"]]);
	}
});

test("an answer to a message that joined the running turn is held the same way and is posted once, rewritten, to that message", async () => {
	const t = setup();
	t.startTurn();
	t.q.onAnswer("answer to the first");
	// The second message lands in the run after its first stop; the next stop answers it.
	expect(t.q.deliver("second message", { target: "web", replyTo: "m2", owner: true })).toBe(true);
	t.q.onPrompt("[note] second message");
	t.q.onAnswer(`answer to the second with ${HIT}`);
	expect(await t.posted()).toEqual([["web", "answer to the first", "m1"]]);
	t.q.onPrompt(NOTE);
	t.q.onAnswer("rewritten second answer");
	expect(await t.posted()).toEqual([["web", "answer to the first", "m1"], ["web", "rewritten second answer", "m2"]]);
});
