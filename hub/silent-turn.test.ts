import { expect, test } from "bun:test";
import { createPrompts } from "./prompts.ts";

function setup() {
	const state = { working: false, posts: [] as { text: string; replyTo?: string }[] };
	const q = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => state.working,
		note: (_t, _r, text) => "[note] " + text,
		isNote: text => text.startsWith("[note]"),
		post: async (_target, text, replyTo) => (state.posts.push({ text, replyTo }), { delivered: true }),
		noAnswerNote: () => "NO-ANSWER-NOTE",
		clearProgress: () => {},
		persist: () => {},
		log: () => {},
		answered: [],
		recent: () => [],
	} as never);
	const turn = (text: string, replyTo: string) => { q.deliver(text, { target: "web", replyTo, owner: true }); state.working = true; q.onPrompt(text); };
	const idle = () => { state.working = false; q.settleTurn(); };
	const settled = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
	return { q, state, turn, idle, settled };
}

test("a turn that ends with no text tells the owner instead of closing the request in silence", async () => {
	const { q, state, turn, idle, settled } = setup();
	turn("request a1", "a1");
	idle();
	await settled();
	expect(state.posts).toEqual([{ text: "NO-ANSWER-NOTE", replyTo: "a1" }]);
	expect(q.isAnswered("a1")).toBe(true);
});

test("a no-text turn that already sent something to the conversation adds no notice", async () => {
	const { q, state, turn, idle, settled } = setup();
	turn("request a1", "a1");
	q.sent("web", "the full answer", "a1");
	idle();
	await settled();
	expect(state.posts).toEqual([]);
});

test("a no-text nudge turn for a request already waiting leaves that request open with no notice", async () => {
	const { q, state, turn, idle, settled } = setup();
	turn("request a1", "a1"); q.onAnswer("[later]"); idle();
	turn("[dotz gateway] open requests: a1", "a1");
	idle();
	await settled();
	expect(state.posts).toEqual([]);
	expect(q.openRequests().map(r => r.replyTo)).toEqual(["a1"]);
});
