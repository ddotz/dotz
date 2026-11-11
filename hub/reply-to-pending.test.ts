import { expect, test } from "bun:test";
import { createPrompts, type Pending } from "./prompts.ts";

function setup() {
	const state = { working: false, saved: [] as Pending[][] };
	const q = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => state.working,
		note: (_t, _r, text) => "[note] " + text,
		isNote: text => text.startsWith("[note]"),
		post: async () => ({ delivered: true }),
		clearProgress: () => {},
		persist: open => void state.saved.push(open),
		log: () => {},
		answered: [],
		recent: () => [],
	} as never);
	const dotzSend = (text: string, replyTo?: string) => (q.holdEarly("web", text, replyTo) ? "held" : (q.sent("web", text, replyTo), "sent"));
	const turn = (text: string, replyTo: string, owner = true) => { q.deliver(text, { target: "web", replyTo, owner }); state.working = true; q.onPrompt(text); };
	const idle = () => { state.working = false; q.settleTurn(); };
	return { q, state, dotzSend, turn, idle };
}

test("a dotz_send whose reply_to names a request waiting on a worker is delivered and closes it", () => {
	const { q, state, dotzSend, turn, idle } = setup();
	for (const id of ["a1", "b1", "c1"]) { turn("request " + id, id); q.onAnswer("[later]"); idle(); }
	turn("[dotz gateway] open requests: a1 b1 c1", "a1", false);
	expect(["a1", "b1", "c1"].map(id => dotzSend("full answer to " + id, id))).toEqual(["sent", "sent", "sent"]);
	expect(q.openRequests()).toEqual([]);
	expect(state.saved.at(-1)).toEqual([]);
	expect(q.replay(state.saved.at(-1) ?? [], t => t)).toBe(0);
});

test("a dotz_send for the running request, or naming no waiting request, is still held for the final answer", () => {
	const { q, dotzSend, turn, idle } = setup();
	turn("request a1", "a1"); q.onAnswer("[later]"); idle();
	turn("request b1", "b1");
	expect(dotzSend("part of the answer to b1", "b1")).toBe("held");
	expect(dotzSend("part of the answer to b1")).toBe("held");
	expect(q.openRequests().map(r => r.replyTo)).toEqual(["a1"]);
});
