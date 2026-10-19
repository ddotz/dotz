// The prompt queue: a steered owner message that was answered (dotz_send reply_to, or the turn's own answer) is never
// delivered again as a turn, a reply_to settles the prompt it names, and a finished prompt is answered once.
import { expect, test } from "bun:test";
import { emit, answeredIds } from "./events.ts";
import { createPrompts, type Pending } from "./prompts.ts";

function setup(answered: string[] = []) {
	const state = { working: false, delivered: [] as string[], steered: [] as string[], posts: [] as { target: string; text: string; replyTo?: string }[], saved: [] as Pending[][] };
	const q = createPrompts({
		deliver: text => state.delivered.push(text),
		steer: text => state.steered.push(text),
		working: () => state.working,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async (target, text, replyTo) => (state.posts.push({ target, text, replyTo }), { delivered: true }),
		clearProgress: () => {},
		persist: open => state.saved.push(open),
		log: () => {},
		answered,
	});
	const open = () => state.saved.at(-1) ?? [];
	// omp starts a turn with prompt X, then a message arrives while it works.
	const startTurn = (text: string, reply: { target: string; replyTo?: string }) => {
		q.deliver(text, reply);
		state.working = true;
		q.onPrompt(text);
	};
	return { q, state, open, startTurn };
}

const chat = (replyTo: string) => ({ target: "chat", replyTo });

test("a steered message answered with dotz_send reply_to is not delivered again, at turn end or on replay", async () => {
	const { q, state, open, startTurn } = setup();
	startTurn("first", chat("m1"));
	q.deliver("second", chat("m2"));
	expect(state.steered).toEqual(["[note] second"]);

	q.sent("chat", "quick answer", "m2");
	expect(open().map(p => p.text)).toEqual(["first"]);
	q.markAnswered("m1"); // the turn's own answer to the first one
	q.onAnswer("done with first");
	state.working = false;
	q.redeliverSteered();
	expect(state.delivered).toEqual(["first"]);

	// A restart replays what pending.json still holds: the answered message is not in it, and would be skipped anyway.
	const replayed = q.replay([{ text: "second", at: Date.now(), target: "chat", replyTo: "m2" }], t => t);
	expect(replayed).toBe(0);
	expect(state.delivered).toEqual(["first"]);
});

test("restart replay skips messages the outbox log shows as answered", () => {
	const { q, state } = setup(["old1"]);
	const n = q.replay(
		[
			{ text: "answered", at: Date.now(), target: "chat", replyTo: "old1" },
			{ text: "open", at: Date.now(), target: "chat", replyTo: "old2" },
			{ text: "stale", at: Date.now() - 13 * 3600_000, target: "chat", replyTo: "old3" },
		],
		t => `replay ${t}`,
	);
	expect(n).toBe(1);
	expect(state.delivered).toEqual(["replay open"]);
});

test("answered ids are read back from the outbox log tail", () => {
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "chat", text: "hi", reply_to: "seed-msg-1" });
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "chat", text: "no reply", reply_to: null });
	emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "chat", text: "progress", update_key: "k" });
	const ids = answeredIds();
	expect(ids).toContain("seed-msg-1");
	expect(ids.every(id => typeof id === "string" && id.length > 0)).toBe(true);
});

test("with two steered messages on a channel, a reply_to answer to the second settles the second", () => {
	const { q, state, open, startTurn } = setup();
	startTurn("first", chat("m1"));
	q.deliver("one", chat("s1"));
	q.deliver("two", chat("s2"));
	q.sent("chat", "answer to two", "s2");
	expect(open().map(p => p.text)).toEqual(["first", "one"]);

	// Without a reply_to it falls back to the first steered prompt of the channel.
	q.sent("chat", "plain note");
	expect(open().map(p => p.text)).toEqual(["first"]);

	// A reply_to that names no steered prompt settles nothing.
	q.deliver("three", chat("s3"));
	q.sent("chat", "about something else", "unrelated");
	expect(open().map(p => p.text)).toEqual(["first", "three"]);
	expect(state.delivered).toEqual(["first"]);
});

test("steered prompts are redelivered when the orchestrator goes idle, not at each assistant stop", () => {
	const { q, state, startTurn } = setup();
	startTurn("first", chat("m1"));
	q.deliver("second", chat("m2"));
	q.onAnswer("answer one");
	expect(state.delivered).toEqual(["first"]);
	q.redeliverSteered();
	expect(state.delivered).toEqual(["first", "second"]);
});

test("a prompt whose final answer was posted gets no further auto posts from later stops of the same turn", async () => {
	const { q, state, open, startTurn } = setup();
	startTurn("first", chat("m1"));
	q.onAnswer("final");
	// omp continues with a steered note (ignored as a prompt) and stops again.
	q.onPrompt("[note] second");
	q.onAnswer("continued");
	q.onAnswer("continued again");
	await Promise.resolve();
	expect(state.posts).toEqual([{ target: "chat", text: "final", replyTo: "m1" }]);
	expect(open()).toEqual([]);
});

test("answer only when ready: an early send to the asking channel is held and goes out ahead of the final answer", () => {
	const { q, state, startTurn } = setup();
	startTurn("fix the build", chat("m1"));
	expect(q.holdEarly("chat", "몇 분 안에 끝내고 알려 드릴게요")).toBe(true);
	expect(q.holdEarly("ch:9", "elsewhere")).toBe(false); // another channel is not this turn's answer
	expect(state.posts).toEqual([]);
	q.onAnswer("고쳤어요. 테스트 통과.");
	expect(state.posts).toEqual([{ target: "chat", text: "몇 분 안에 끝내고 알려 드릴게요\n\n고쳤어요. 테스트 통과.", replyTo: "m1" }]);
});

test("a full answer to a message steered in mid-turn is not held", () => {
	const { q, startTurn } = setup();
	startTurn("long work", chat("m1"));
	q.deliver("quick question", chat("m2"));
	expect(q.holdEarly("chat", "answer to the quick one", "m2")).toBe(false);
	expect(q.holdEarly("chat", "answer without reply_to")).toBe(false);
});

test("a held text repeated as the final answer is posted once", () => {
	const { q, state, startTurn } = setup();
	startTurn("q", chat("m1"));
	q.holdEarly("chat", "the answer");
	q.onAnswer("the answer");
	expect(state.posts.map(p => p.text)).toEqual(["the answer"]);
});
