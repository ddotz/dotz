// An answer's conversation comes only from a label (prompt target, worker link, handed work's `from`); everything else goes home
// (hub/prompts.ts). Each test is one ordered sequence from hub.log: 2026-11-10 cases 1 and 2, the reverse direction, and the
// incidents the old orphanTarget rules were added for.
import { expect, test } from "bun:test";
import { createPrompts, type Pending, type PromptDeps, type Reply } from "./prompts.ts";

function setup(extra: Partial<PromptDeps> = {}) {
	const state = { working: false, steered: [] as string[], delivered: [] as string[], posts: [] as { target: string; text: string; replyTo?: string }[], handBacks: [] as { from: string; text: string; replyTo?: string }[], saved: [] as Pending[][] };
	const q = createPrompts({
		deliver: text => state.delivered.push(text),
		steer: text => (state.steered.push(text), true),
		working: () => state.working,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async (target, text, replyTo) => (state.posts.push({ target, text, replyTo }), { delivered: true }),
		handBack: (from, text, replyTo) => void state.handBacks.push({ from, text, replyTo }),
		clearProgress: () => {},
		persist: open => state.saved.push(open),
		log: () => {},
		...extra,
	} as PromptDeps);
	const open = () => state.saved.at(-1) ?? [];
	const startTurn = (text: string, reply: Reply) => {
		q.deliver(text, reply);
		state.working = true;
		q.onPrompt(text);
	};
	// A turn that hands its request to a background worker and ends with [later].
	const deferWith = (text: string, reply: Reply, worker?: string) => {
		startTurn(text, reply);
		if (worker) q.workersSpawned([{ id: worker }]);
		q.onAnswer("[later]");
		state.working = false;
		q.settleTurn();
	};
	const targets = () => state.posts.map(p => [p.target, p.replyTo]);
	return { q, state, open, startTurn, deferWith, targets };
}

test("2026-11-10 case 1: a worker's result answers web, and a later unlabelled answer goes home to web, never to the handed request of ch:X", async () => {
	const t = setup({ home: "web" });
	t.deferWith("[conversation ch:X] 설정 알려줘", { target: "ch:X", replyTo: "x1", from: "ch:X" });
	t.deferWith("web request", { target: "web", replyTo: "2df02b62" }, "st_w");
	t.q.workersDone(["st_w"]);
	t.q.onAnswer("워커 결과예요");
	await Promise.resolve();
	expect(t.targets()).toEqual([["web", "2df02b62"]]);

	// The run ends; a run nothing woke answers with no label at all.
	t.q.settleTurn();
	t.q.onAnswer("라벨이 없는 두 번째 답이에요");
	await Promise.resolve();
	expect(t.targets()).toEqual([["web", "2df02b62"], ["web", undefined]]);
	expect(t.state.handBacks).toEqual([]);
	// ch:X's request is still open: only its own label can answer it.
	expect(t.q.deferredOpen().map(d => d.target)).toEqual(["ch:X"]);
});

test("a conversation session's unlabelled answer goes to its own conversation (deps.home), not to web", async () => {
	const t = setup({ home: "ch:X" });
	t.q.onAnswer("a report with no prompt");
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:X", undefined]]);
});

test("2026-11-10 case 2: main's answer to work handed by ch:X is not posted to ch:X but handed back to ch:X's session, also after a restart and after a worker", async () => {
	const t = setup();
	// a turn for ch:X is running in this queue: the handed work is not steered into it
	t.startTurn("owner asks in ch:X", { target: "ch:X", replyTo: "o1", owner: true });
	expect(t.q.deliver("[conversation ch:X] 설정 알려줘", { target: "ch:X", replyTo: "x1", from: "ch:X" })).toBe(false);
	expect(t.state.steered).toEqual([]);
	t.q.onAnswer("owner turn answer");
	t.state.working = false;
	t.q.settleTurn();
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:X", "o1"]]);

	// the handed prompt's final answer is handed back, with the request id, and nothing is posted
	t.startTurn("[conversation ch:X] 설정 알려줘", { target: "ch:X", replyTo: "x1", from: "ch:X" });
	expect(t.open().find(p => p.replyTo === "x1")).toMatchObject({ from: "ch:X" });
	t.q.onAnswer("메인 설정은 이렇게 해요");
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:X", "o1"]]);
	expect(t.state.handBacks).toEqual([{ from: "ch:X", text: "메인 설정은 이렇게 해요", replyTo: "x1" }]);
	expect(t.open()).toEqual([]);

	// restart: the stored prompt keeps its `from`
	const r = setup();
	r.q.replay([{ text: "[conversation ch:X] again", at: Date.now(), target: "ch:X", replyTo: "x2", from: "ch:X" }], x => x);
	r.q.onPrompt("[conversation ch:X] again");
	r.q.onAnswer("after restart");
	await Promise.resolve();
	expect(r.state.posts).toEqual([]);
	expect(r.state.handBacks).toEqual([{ from: "ch:X", text: "after restart", replyTo: "x2" }]);

	// a worker's result for such a request is handed back too
	const w = setup();
	w.deferWith("[conversation ch:X] big job", { target: "ch:X", replyTo: "x3", from: "ch:X" }, "st_h");
	w.q.workersDone(["st_h"]);
	w.q.onAnswer("job result");
	await Promise.resolve();
	expect(w.state.posts).toEqual([]);
	expect(w.state.handBacks).toEqual([{ from: "ch:X", text: "job result", replyTo: "x3" }]);
	expect(w.q.deferredOpen()).toEqual([]);
});

// Work main hands over (dotz_conv send, hub/routes.ts) has no `from` and is answered in the conversation: 2026-11-10, the answers of two mail sessions never showed.
test("main -> conversation: the answer to work main handed over is posted once in that conversation, handed back to nobody", async () => {
	const t = setup({ home: "ch:X" });
	t.startTurn("[main session] 이거 확인해 줘", { target: "ch:X" });
	expect(t.q.current()).not.toHaveProperty("from");
	t.q.onAnswer("확인했어요");
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:X", undefined]]);
	expect(t.state.handBacks).toEqual([]);
	expect(t.open()).toEqual([]);
});

test("main -> conversation with back: true: a conversation session's answer to main's handed prompt goes back to main; the handed-back prompt is marked and cannot be handed on", async () => {
	const t = setup({ home: "ch:X" });
	t.startTurn("[main session] 이거 확인해 줘", { target: "ch:X", from: "main" });
	expect(t.q.current()).toMatchObject({ from: "main" });
	t.q.onAnswer("확인했어요");
	await Promise.resolve();
	expect(t.state.posts).toEqual([]);
	expect(t.state.handBacks).toEqual([{ from: "main", text: "확인했어요", replyTo: undefined }]);

	// what main gets back is a normal prompt of its own conversation that posts its answer, flagged so the route refuses a second hand-off
	const m = setup();
	m.startTurn("[lead] 확인했어요", { target: "web", replyTo: undefined, handback: true });
	expect(m.q.current()).toMatchObject({ handback: true });
	expect(m.open().at(-1)).toMatchObject({ handback: true });
	m.q.onAnswer("확인했대요");
	await Promise.resolve();
	expect(m.targets()).toEqual([["web", undefined]]);
	expect(m.state.handBacks).toEqual([]);
});

// 2026-10-28 21:44 KST (a mail thread's question vs a KTX run): hub/prompts.test.ts "a promptless answer stays in the last turn's conversation ..." and
// "a message of another conversation is never steered into a running turn" keep that one.
// 2026-10-31 06:36 UTC: A's and B's workers; B finished last.
test("2026-10-31: each woken result goes to its own worker's request, and an unlabelled answer after them does not pick A's still open request", async () => {
	const t = setup();
	t.deferWith("A 요청", { target: "ch:A", replyTo: "a1" }, "wA");
	t.deferWith("B 요청", { target: "ch:B", replyTo: "b1" }, "wB");
	t.q.workersDone(["wB"]);
	t.q.onAnswer("B의 결과");
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:B", "b1"]]);
	t.q.settleTurn();
	t.q.onAnswer("누구의 것도 아닌 답");
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:B", "b1"], ["web", undefined]]);
	t.q.workersDone(["wA"]);
	t.q.onAnswer("A의 결과");
	await Promise.resolve();
	expect(t.targets().at(-1)).toEqual(["ch:A", "a1"]);
});

// hub.log 2026-11-04T04:20:25Z: 823 chars of a real answer were dropped for want of a pairing.
test("2026-11-04: a long answer no label explains is posted at home, whatever old owner messages exist, and is not dropped", async () => {
	const long = "가".repeat(823);
	const t = setup({ recent: () => [{ target: "ch:1", replyTo: "c1", at: Date.now() - 90 * 60_000 }] });
	t.q.onAnswer(long);
	await Promise.resolve();
	expect(t.state.posts).toEqual([{ target: "web", text: long, replyTo: undefined }]);
});

// 2026-11-05 00:29 KST: a lessons report that hung on a Cloudflare request.
test("2026-11-05: a report with no label goes home, not to the newest owner message of another conversation", async () => {
	const now = Date.now();
	const t = setup({
		answered: ["R"],
		recent: () => [{ target: "web", replyTo: "R", at: now - 20 * 60_000 }, { target: "ch:2", replyTo: "c1", at: now - 5 * 60_000 }],
	});
	t.q.onAnswer("교훈 보고서예요");
	await Promise.resolve();
	expect(t.targets()).toEqual([["web", undefined]]);
});

test("a run stopped by a provider error still answers its own request: that label is kept", async () => {
	const t = setup();
	t.startTurn("A", { target: "ch:A", replyTo: "a1" });
	t.q.settleTurn(true);
	t.q.onAnswer("A가 끝났어요");
	await Promise.resolve();
	expect(t.targets()).toEqual([["ch:A", "a1"]]);
});
