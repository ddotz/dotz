// An owner message that arrives in a turn that answers no request of the owner's (a worker's result woke the session, a session report)
// waits as a prompt of its own instead of being steered into that turn, so it gets a whole turn (2026-11-13 diagnosis: 148 mid-turn owner
// steers in 7 days). A quiet check's turn, which has a target, still takes it as before.
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

test("a run a worker's result woke does not take the owner message: it waits as its own prompt and its own turn answers it", async () => {
	const { q, s, frame } = setup();
	frame("<task-result>worker done</task-result>");
	expect(q.deliver("답했는데 왜 씹혀", web("c5878d56"))).toBe(false);
	expect(s.notes).toEqual([]);
	expect(s.sent).toEqual(["답했는데 왜 씹혀"]);
	q.onAnswer("[done] 워커 결과 정리");
	q.settleTurn();
	frame("답했는데 왜 씹혀");
	q.onAnswer("미안해요, 지금 봤어요");
	await flush();
	expect(s.posts.at(-1)).toEqual({ text: "미안해요, 지금 봤어요", replyTo: "c5878d56" });
	expect(q.isAnswered("c5878d56")).toBe(true);
});

test("a session report's turn (a prompt with no target) does not take the owner message either", () => {
	const { q, s, frame } = setup();
	q.deliver("[report] lane x is done");
	frame("[report] lane x is done");
	expect(q.deliver("그건 나중에, 이거 먼저", web("m2"))).toBe(false);
	expect(s.notes).toEqual([]);
	expect(s.sent.at(-1)).toBe("그건 나중에, 이거 먼저");
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
