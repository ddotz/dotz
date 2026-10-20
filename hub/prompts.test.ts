// The prompt queue: a steered owner message that was answered (dotz_send reply_to, or the turn's own answer) is never
// delivered again as a turn, a reply_to settles the prompt it names, and a finished prompt is answered once.
import { expect, test } from "bun:test";
import { emit, answeredIds } from "./events.ts";
import { createPrompts, type OwnerMessage, type Pending } from "./prompts.ts";
import { eventsFromFrame } from "./runtime/omp.ts";

function setup(answered: string[] = [], recent: OwnerMessage[] = []) {
	const state = { working: false, steerFails: false, delivered: [] as string[], steered: [] as string[], posts: [] as { target: string; text: string; replyTo?: string }[], saved: [] as Pending[][] };
	const q = createPrompts({
		deliver: text => state.delivered.push(text),
		steer: text => (state.steered.push(text), !state.steerFails),
		working: () => state.working,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async (target, text, replyTo) => (state.posts.push({ target, text, replyTo }), { delivered: true }),
		clearProgress: () => {},
		persist: open => state.saved.push(open),
		log: () => {},
		answered,
		recent: () => recent,
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

test("a harness reminder injected mid-turn does not drop the turn's answer", async () => {
	const { q, state, startTurn } = setup();
	startTurn("fix it", { target: "web" });
	q.onPrompt("<system-reminder>Detached eval cell x (js) completed.</system-reminder>");
	q.onAnswer("fixed");
	expect(state.posts).toEqual([{ target: "web", text: "fixed", replyTo: undefined }]);
});

test("a turn that ends without a stop answer sends its last text once", () => {
	const { q, state, startTurn } = setup();
	startTurn("fix it", { target: "web" });
	q.onText("half done, here is where it stands");
	q.settleTurn();
	q.settleTurn();
	q.onAnswer("late stop");
	expect(state.posts).toEqual([{ target: "web", text: "half done, here is where it stands", replyTo: undefined }]);
});

test("a turn answered normally gets nothing more at idle", () => {
	const { q, state, startTurn } = setup();
	startTurn("fix it", { target: "web" });
	q.onText("fixed");
	q.onAnswer("fixed");
	q.settleTurn();
	expect(state.posts).toHaveLength(1);
});

test("a message whose steer finds no running turn goes in as a normal prompt", () => {
	const { q, state, startTurn } = setup();
	startTurn("first", chat("m1"));
	state.steerFails = true;
	q.deliver("second", chat("m2"));
	expect(state.delivered).toEqual(["first", "second"]);
	q.redeliverSteered();
	expect(state.delivered).toEqual(["first", "second"]);
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

test("a web message steered mid-turn through the queue keeps the running turn's answer paired (raw text would unpair it)", async () => {
	const { q, state, startTurn } = setup();
	startTurn("[inbox] notifications only for start/done/ask", { target: "web" });
	q.deliver("[inbox] label the context chips", { target: "web" });
	expect(state.steered).toEqual(["[note] [inbox] label the context chips"]);
	q.onPrompt("[note] [inbox] label the context chips");
	q.onAnswer("both fixed");
	await Promise.resolve();
	expect(state.posts).toEqual([{ target: "web", text: "both fixed", replyTo: undefined }]);

});

// 2026-10-20 10:43Z and 10:52Z: the old web steer path sent raw inbox text past the queue; admitted mid-turn it was a user frame
// that matched nothing, it replaced the running turn's prompt with nothing, and the finished answer had no prompt to go to.
test("a user frame that matches nothing delivered leaves the running turn's prompt in place", async () => {
	const { q, state, startTurn } = setup();
	startTurn("[inbox] first", { target: "web" });
	q.onPrompt("[inbox] steered raw");
	q.onPrompt("[inbox] and another raw one");
	q.onAnswer("both fixed");
	await Promise.resolve();
	expect(state.posts).toEqual([{ target: "web", text: "both fixed", replyTo: undefined }]);
});

// The OmO session of 2026-10-20 12:49Z: the gateway restarted mid-delegation, the resumed session was woken by the dead task
// worker's completion, and its report (a run no delivered prompt started) was dropped.
test("an answer to a run no prompt started goes to the owner's newest message of the last 30 minutes", async () => {
	const now = Date.now();
	// A new process: the prompts are gone, the inbox log tail names the owner's messages.
	const { q, state } = setup([], [{ target: "web", at: now - 3 * 60_000 }]);
	q.onAnswer("README is updated and pushed: 2359b25");
	await Promise.resolve();
	expect(state.posts).toEqual([{ target: "web", text: "README is updated and pushed: 2359b25", replyTo: undefined }]);

	// The same process: the owner's message was answered ("a worker is on it"), the turn went idle, a wake starts a new run.
	const live = setup();
	live.q.deliver("[inbox] update the README", { target: "web", owner: true });
	live.q.onPrompt("[inbox] update the README");
	live.q.onAnswer("a worker is on it");
	live.q.settleTurn();
	live.q.onAnswer("The README is done and pushed.");
	await Promise.resolve();
	expect(live.state.posts.map(p => p.text)).toEqual(["a worker is on it", "The README is done and pushed."]);
});

test("an answer without a prompt prefers an unanswered owner message, and stops at 30 minutes", async () => {
	const now = Date.now();
	const { q, state } = setup(["b"], [
		{ target: "ch:1", replyTo: "a", at: now - 10 * 60_000 },
		{ target: "web", replyTo: "b", at: now - 5 * 60_000 },
	]);
	q.onAnswer("for the unanswered one");
	await Promise.resolve();
	expect(state.posts).toEqual([{ target: "ch:1", text: "for the unanswered one", replyTo: "a" }]);

	const old = setup([], [{ target: "web", at: now - 31 * 60_000 }]);
	old.q.onAnswer("too late for anyone");
	await Promise.resolve();
	expect(old.state.posts).toEqual([]);
});

test("keepalive replies and very short texts go nowhere, and an answer already sent with dotz_send is not sent again", async () => {
	const { q, state } = setup([], [{ target: "web", at: Date.now() }]);
	for (const t of ["ok", "-", "abc", "  "]) q.onAnswer(t);
	q.sent("web", "the report is ready");
	q.onAnswer("the report is ready");
	await Promise.resolve();
	expect(state.posts).toEqual([]);
});

// The same cases through OmO's frames: agent_start, a delivered prompt, a message admitted into the run, the answer, agent_end.
test("OmO frames of a run with a raw mid-run message still deliver the answer", async () => {
	const { q, state } = setup();
	q.deliver("[dotz inbox] web\nfirst", { target: "web", owner: true });
	const frames = [
		{ type: "agent_start" },
		{ type: "message_end", message: { role: "user", content: "[dotz inbox] web\nfirst" } },
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "[dotz inbox] web\nsecond, admitted mid-run" }] } },
		{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "both are done" }] } },
		{ type: "agent_end" },
	];
	for (const f of frames)
		for (const ev of eventsFromFrame(f, new Map())) {
			if (ev.type === "user") q.onPrompt(ev.text);
			else if (ev.type === "assistant" && ev.text && ev.stop === "stop") q.onAnswer(ev.text);
			else if (ev.type === "turn_end") q.settleTurn();
		}
	await Promise.resolve();
	expect(state.posts).toEqual([{ target: "web", text: "both are done", replyTo: undefined }]);
});
