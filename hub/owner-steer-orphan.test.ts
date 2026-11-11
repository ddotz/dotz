// An owner message that arrives in a turn that answers no request (a worker's result woke the session, a session report, a quiet
// check) is steered into it at once with the usual note, not queued behind the engine's own chain of runs.
import { expect, test } from "bun:test";
import { createPrompts, type Pending, type PromptDeps } from "./prompts.ts";
import { flush } from "./runtime/test-clock.ts";

const web = (id: string) => ({ target: "web", replyTo: id, owner: true });

function setup(extra: Partial<PromptDeps> = {}) {
	const s = { working: false, steerOk: true, sent: [] as string[], notes: [] as string[], posts: [] as { text: string; replyTo?: string }[], settled: [] as string[], quiet: [] as string[], open: [] as Pending[] };
	const q = createPrompts({
		deliver: text => s.sent.push(text),
		steer: text => (s.notes.push(text), s.steerOk),
		working: () => s.working,
		note: (_t, id, text) => `[note ${id}] ${text}`,
		isNote: text => text.startsWith("[note"),
		post: async (_t, text, replyTo) => (s.posts.push({ text, replyTo }), { delivered: true }),
		settled: (_t, ids) => s.settled.push(...ids),
		quietNote: (_t, text) => s.quiet.push(text),
		clearProgress: () => {},
		persist: open => (s.open = open),
		log: () => {},
		...extra,
	});
	const frame = (text: string) => {
		s.working = true;
		return q.onPrompt(text);
	};
	return { q, s, frame };
}

test("a run a worker's result woke takes the owner message as a steer, and its answer goes to that message", async () => {
	const { q, s, frame } = setup();
	frame("<task-result>worker done</task-result>");
	expect(q.deliver("답했는데 왜 씹혀", web("c5878d56"))).toBe(true);
	expect(s.notes).toEqual(["[note c5878d56] 답했는데 왜 씹혀"]);
	expect(s.sent).toEqual([]);
	frame(s.notes[0]!);
	q.onAnswer("미안해요, 지금 봤어요");
	await flush();
	expect(s.posts).toEqual([{ text: "미안해요, 지금 봤어요", replyTo: "c5878d56" }]);
	expect(s.settled).toEqual(["c5878d56"]);
	expect(q.isAnswered("c5878d56")).toBe(true);
	q.settleTurn();
	q.redeliverSteered();
	expect(s.sent).toEqual([]);   // answered once; nothing comes back as a prompt
	expect(s.open).toEqual([]);
});

test("a dotz_send with reply_to settles a message steered into a run with no request", () => {
	const { q, s, frame } = setup();
	frame("<task-result>worker done</task-result>");
	expect(q.deliver("바로 알려줘", web("m1"))).toBe(true);
	frame(s.notes[0]!);
	q.sent("web", "알려드려요", "m1");
	expect(q.isAnswered("m1")).toBe(true);
	q.settleTurn();
	q.redeliverSteered();
	expect(s.sent).toEqual([]);
});

test("a session report's turn (a prompt with no target) takes the owner message too", async () => {
	const { q, s, frame } = setup();
	q.deliver("[report] lane x is done");
	frame("[report] lane x is done");
	expect(q.deliver("그건 나중에, 이거 먼저", web("m2"))).toBe(true);
	expect(s.notes).toEqual(["[note m2] 그건 나중에, 이거 먼저"]);
	frame(s.notes[0]!);
	q.onAnswer("네, 이걸 먼저 했어요");
	await flush();
	expect(s.posts).toEqual([{ text: "네, 이걸 먼저 했어요", replyTo: "m2" }]);
	expect(q.isAnswered("m2")).toBe(true);
});

test("a quiet check's turn takes the owner message and the quiet mark goes, so its answer is posted", async () => {
	const { q, s, frame } = setup();
	q.deliver("[check] anything new?", { target: "web", quiet: true });
	frame("[check] anything new?");
	expect(q.deliver("하나 물어볼게", web("m3"))).toBe(true);
	frame(s.notes[0]!);
	q.onAnswer("물어보세요");
	await flush();
	expect(s.quiet).toEqual([]);
	expect(s.posts.map(p => p.text)).toEqual(["물어보세요"]);
	expect(s.settled).toEqual(["m3"]);
});

test("a keepalive turn does not take it: the message goes in as a normal prompt", () => {
	const { q, s, frame } = setup({ keepalive: () => true });
	frame("keepalive ping");
	expect(q.deliver("안녕", web("m4"))).toBe(false);
	expect(s.notes).toEqual([]);
	expect(s.sent).toEqual(["안녕"]);
});

test("when the engine refuses the steer (turn ending) the message is the next prompt", () => {
	const { q, s, frame } = setup();
	frame("<task-result>worker done</task-result>");
	s.steerOk = false;
	expect(q.deliver("지금 보내요", web("m5"))).toBe(false);
	expect(s.sent).toEqual(["지금 보내요"]);
	frame("지금 보내요");
	expect(q.current()?.replyTo).toBe("m5");
});

test("a message that is not the owner's, or a hand-back, still waits as its own prompt", () => {
	const { q, s, frame } = setup();
	frame("<task-result>worker done</task-result>");
	expect(q.deliver("note from a lane", { target: "web", replyTo: "r1" })).toBe(false);
	expect(s.notes).toEqual([]);
	expect(s.sent).toEqual(["note from a lane"]);
});
