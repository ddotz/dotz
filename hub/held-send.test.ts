import { expect, test } from "bun:test";
import { createPrompts } from "./prompts.ts";

// A dotz_send to the channel the running turn answers is held for the turn's final answer (hub/routes.ts /api/send).
// Whatever way the turn ends, the held text is posted once.
function setup() {
	const state = { working: false, posts: [] as { text: string; replyTo?: string }[], notes: [] as string[], cleared: [] as string[] };
	const q = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => state.working,
		note: (_t, _r, text) => "[note] " + text,
		isNote: text => text.startsWith("[note]"),
		post: async (_target, text, replyTo) => (state.posts.push({ text, replyTo }), { delivered: true }),
		interim: (_target, text) => void state.notes.push(text),
		clearProgress: target => void state.cleared.push(target),
		persist: () => {},
		log: () => {},
		answered: [],
		recent: () => [],
	} as never);
	const dotzSend = (text: string, replyTo?: string) => (q.holdEarly("web", text, replyTo) ? "held" : (q.sent("web", text, replyTo), "sent"));
	const turn = (text: string, replyTo: string) => { q.deliver(text, { target: "web", replyTo, owner: true }); state.working = true; q.onPrompt(text); };
	const idle = () => { state.working = false; q.settleTurn(); };
	const settled = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
	return { q, state, dotzSend, turn, idle, settled };
}

test("a held send is posted once when the turn ends with [later]", async () => {
	const { q, state, dotzSend, turn, idle, settled } = setup();
	turn("request a1", "a1");
	expect(dotzSend("PART-ONE sent early")).toBe("held");
	q.onAnswer("[later]");
	idle();
	await settled();
	expect(state.notes.filter(n => n.includes("PART-ONE"))).toHaveLength(1);
	expect(state.posts).toEqual([]);
	expect(q.openRequests().map(r => r.replyTo)).toEqual(["a1"]);
	state.working = true;
	q.onAnswer("PART-TWO final answer");
	idle();
	await settled();
	expect([...state.notes, ...state.posts.map(p => p.text)].filter(t => t.includes("PART-ONE"))).toHaveLength(1);
});

// The held text is also on the conversation's progress line; the note that carries it replaces that line the way a final answer does.
test("the note that carries a held send clears the progress line, a [later] with no early send leaves it", async () => {
	const { q, state, dotzSend, turn, settled } = setup();
	turn("request a1", "a1");
	dotzSend("PART-ONE sent early");
	q.onAnswer("[later]");
	await settled();
	expect(state.notes).toEqual(["PART-ONE sent early"]);
	expect(state.cleared).toEqual(["web"]);
	const other = setup();
	other.turn("request b1", "b1");
	other.q.onAnswer("started it\n\n[later]");
	await other.settled();
	expect(other.state.notes).toEqual(["started it"]);
	expect(other.state.cleared).toEqual([]);
});

test("a held send goes out with the text written around [later], in order, in one note", () => {
	const { q, state, dotzSend, turn } = setup();
	turn("request a1", "a1");
	dotzSend("PART-ONE");
	q.onAnswer("started it\n\n[later]");
	expect(state.notes).toEqual(["PART-ONE\n\nstarted it"]);
});

test("a held send is posted as the answer, closing the request, when the turn ends with no text", async () => {
	const { q, state, dotzSend, turn, idle, settled } = setup();
	turn("request a1", "a1");
	dotzSend("the full answer to a1");
	idle();
	await settled();
	expect(state.posts).toEqual([{ text: "the full answer to a1", replyTo: "a1" }]);
	expect(q.isAnswered("a1")).toBe(true);
});

test("a held send is not posted twice when the turn ends with a final answer", async () => {
	const { q, state, dotzSend, turn, idle, settled } = setup();
	turn("request a1", "a1");
	dotzSend("PART-ONE");
	q.onAnswer("PART-TWO");
	idle();
	await settled();
	expect(state.posts).toEqual([{ text: "PART-ONE\n\nPART-TWO", replyTo: "a1" }]);
	expect(state.notes).toEqual([]);
});
