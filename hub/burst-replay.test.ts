// Replays the owner's burst of 2026-11-06 07:30:41-07:32:13 UTC in project conversation ch:1500000000008356296: nine short web
// messages, each answered on its own, six of them twice, one reply garbled by the double delivery.
import { expect, test } from "bun:test";
import { createPrompts, type Pending, type PromptDeps } from "./prompts.ts";
import { prompt } from "./laneprompt.ts";
import type { Lane } from "./lanestate.ts";
import { bursts, intake } from "./intake.ts";
import { awaiting, settleRefs } from "./outbound.ts";
import { GATHER_MAX_MS } from "./promptburst.ts";
import { advance, clock, flush } from "./runtime/test-clock.ts";

const CH = "ch:1500000000008356296";
const reply = (id: string, target = CH) => ({ target, replyTo: id, owner: true });

function setup(extra: Partial<PromptDeps> = {}) {
	const s = { working: false, sent: [] as string[], notes: [] as string[], posts: [] as { text: string; replyTo?: string }[], settled: [] as string[], open: [] as Pending[] };
	const q = createPrompts({
		deliver: text => s.sent.push(text),
		steer: text => (s.notes.push(text), s.working),
		working: () => s.working,
		note: (_t, id, text) => `[note ${id}] ${text}`,
		isNote: text => text.startsWith("[note"),
		post: async (_t, text, replyTo) => (s.posts.push({ text, replyTo }), { delivered: true }),
		settled: (_t, ids) => s.settled.push(...ids),
		clearProgress: () => {},
		persist: open => (s.open = open),
		log: () => {},
		...extra,
	});
	/** What the runtime does with a turn or a steered note: its user frame reaches the gateway. */
	const frame = (text: string) => {
		s.working = true;
		return q.onPrompt(text);
	};
	const idle = () => {
		s.working = false;
		q.settleTurn();
		q.redeliverSteered();
	};
	return { q, s, frame, idle };
}

test("07:30 timeline: a run that goes on after its first stop answers each message once and replays none", async () => {
	const { q, s, frame, idle } = setup();
	// 07:30:41: wakes the parked session; the one model call runs until 07:31:27.
	q.deliver("d1468577", reply("d1468577"));
	frame("d1468577");
	// 07:31:01, :04, :07, :21: steered; their frames land only after that stop.
	for (const id of ["23174e42", "c3f367f2", "af59cc51", "7a06a7a3"]) expect(q.deliver(id, reply(id))).toBe(true);
	const late = s.notes.splice(0);
	q.onAnswer("answer to the first message");
	for (const n of late) frame(n);
	// 07:31:39: the prompt was answered but the run goes on: it joins that run, it does not wait as its own prompt.
	expect(q.deliver("0f7f4191", reply("0f7f4191"))).toBe(true);
	q.onAnswer("answer to the four");
	await flush();
	expect(s.posts).toEqual([{ text: "answer to the first message", replyTo: "d1468577" }, { text: "answer to the four", replyTo: "7a06a7a3" }]);
	expect(s.settled.toSorted()).toEqual(["23174e42", "7a06a7a3", "af59cc51", "c3f367f2"]);
	// :39's note lands next, with 07:31:51 and 07:32:02; 07:32:13 comes after them.
	const next = s.notes.splice(0);
	expect(q.deliver("c8e7829f", reply("c8e7829f"))).toBe(true);
	expect(q.deliver("d71a6067", reply("d71a6067"))).toBe(true);
	for (const n of [...next, ...s.notes.splice(0)]) frame(n);
	q.onAnswer("answer to the next three");
	expect(q.deliver("ccb56f82", reply("ccb56f82"))).toBe(true);
	for (const n of s.notes.splice(0)) frame(n);
	q.onAnswer("answer to the last");
	await flush();
	idle();
	expect(s.sent).toEqual(["d1468577"]);   // nothing came back as a turn: the garbled "already answered" replies had this replay as their cause
	expect(s.posts.map(p => p.replyTo)).toEqual(["d1468577", "7a06a7a3", "d71a6067", "ccb56f82"]);
	for (const id of ["d1468577", "23174e42", "c3f367f2", "af59cc51", "7a06a7a3", "0f7f4191", "c8e7829f", "d71a6067", "ccb56f82"]) expect(q.isAnswered(id)).toBe(true);
	expect(s.open).toEqual([]);
});

test("a burst during a session resume is handed over as one note when the turn starts, and the turn's answer covers it", async () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1"));
	// 3-second gaps while the process comes up: nothing is working yet.
	for (const id of ["m2", "m3", "m4"]) {
		clock.now += 3000;
		expect(q.deliver(`text of ${id}`, reply(id))).toBe(false);
	}
	expect(s.sent).toEqual(["first"]);
	expect(s.notes).toEqual([]);
	frame("first");
	expect(s.notes).toEqual(["[note m4] text of m2\n\ntext of m3\n\ntext of m4"]);
	frame(s.notes[0]!);
	q.onAnswer("one answer");
	await flush();
	idle();
	expect(s.sent).toEqual(["first"]);
	expect(s.posts).toEqual([{ text: "one answer", replyTo: "m1" }]);
	expect(s.settled.toSorted()).toEqual(["m2", "m3", "m4"]);
	for (const id of ["m1", "m2", "m3", "m4"]) expect(q.isAnswered(id)).toBe(true);
});

test("a steered message the model never saw goes in once at idle, a burst of them as one turn answered for all", async () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1"));
	frame("first");
	q.deliver("second", reply("m2"));
	q.deliver("third", reply("m3"));
	q.onAnswer("answer to first");   // the note frames never came: the run ended first
	idle();
	expect(s.sent).toEqual(["first", "second\n\nthird"]);
	idle();
	expect(s.sent).toHaveLength(2);
	frame("second\n\nthird");
	q.onAnswer("answer to both");
	await flush();
	expect(s.posts.at(-1)).toEqual({ text: "answer to both", replyTo: "m3" });
	expect(q.isAnswered("m2") && q.isAnswered("m3")).toBe(true);
	expect(s.settled).toContain("m2");
});

test("a message seen after the answer was written is not taken for answered by that stop", () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1", "web"));
	frame("first");
	q.deliver("second", reply("m2", "web"));
	q.onAnswer("answer to first");
	expect(q.isAnswered("m2")).toBe(false);   // covered blindly at this stop, the web message was lost
	idle();
	expect(s.sent).toEqual(["first", "second"]);
});

test("gathered messages survive a turn that never starts and a restart, once each, and a message without an id too", () => {
	const lost = setup();
	lost.q.deliver("first", reply("m1"));
	lost.q.deliver("second", reply("m2"));
	lost.q.deliver("third", { target: CH, owner: true });
	expect(lost.s.open.map(p => p.text)).toEqual(["first", "second", "third"]);
	lost.idle();
	expect(lost.s.sent).toEqual(["first", "second\n\nthird"]);
	const back = setup();
	back.q.deliver("first", reply("m1"));
	back.q.deliver("second", reply("m2"));
	expect(back.q.reopen(t => t).replayed).toBe(2);
	expect(back.s.sent).toEqual(["first", "first", "second"]);   // the process that held "first" is gone; "second" never went out before
});

test("a merged prompt survives a restart with every message id", () => {
	const { q, s, frame } = setup();
	q.deliver("first", reply("m1"));
	frame("first");
	q.deliver("second", reply("m2"));
	q.deliver("third", reply("m3"));
	q.onAnswer("a");
	s.working = false;
	q.settleTurn();
	q.redeliverSteered();
	expect(s.open.find(p => p.replyTo === "m3")?.refs).toEqual(["m2", "m3"]);
});

test("the owner's 중단 drops what was gathered behind the running turn's conversation", () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1"));
	frame("first");
	s.working = false;
	q.deliver("second", reply("m2"));
	q.deliver("third", reply("m3"));
	expect(q.cancel()).toBe(CH);
	idle();
	expect(s.sent).toEqual(["first", "second"]);
	expect(s.open).toEqual([]);
});

test("a prompt that never starts and no idle to follow: what gathered behind it still goes in, and nothing gathers behind a stale one", async () => {
	const { q, s } = setup();
	q.deliver("first", reply("m1"));
	q.deliver("second", reply("m2"));
	await advance(GATHER_MAX_MS);
	expect(s.sent).toEqual(["first", "second"]);
	await advance(GATHER_MAX_MS);
	expect(q.deliver("third", reply("m3"))).toBe(false);
	expect(s.sent).toEqual(["first", "second", "third"]);
});

test("an answer does not settle a steered message the model never saw", async () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1", "web"));
	frame("first");
	q.deliver("second", reply("m2", "web"));
	expect(q.waitingIds("web")).toEqual(["m2"]);
	q.deliver("third", reply("m3", "web"));
	frame(s.notes[1]!);
	expect(q.waitingIds("web")).toEqual(["m2"]);
	q.sent("web", "a note without reply_to");
	q.onAnswer("answer");
	await flush();
	idle();
	expect(s.sent).toEqual(["first", "second"]);
});

test("a short message is not seen because its text appears in another message's note", () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1"));
	frame("first");
	q.deliver("1", reply("m2"));
	q.deliver("1 more", reply("m3"));
	frame(s.notes[1]!);
	q.onAnswer("answer");
	idle();
	expect(s.sent).toEqual(["first", "1"]);
});

test("중단 during a run going on after its first stop ends what was steered into it", async () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1"));
	frame("first");
	q.onAnswer("answer to first");
	await flush();
	q.deliver("second", reply("m2"));
	frame(s.notes[0]!);
	expect(q.cancel()).toBe(CH);
	q.onAnswer("late text of the cancelled run");
	await flush();
	idle();
	expect(s.sent).toEqual(["first"]);
	expect(s.posts.map(p => p.text)).toEqual(["answer to first"]);
	expect(s.open).toEqual([]);
});

test("a dotz_send to the last message of a merged note settles every message of it", () => {
	const { q, s, frame, idle } = setup();
	q.deliver("first", reply("m1"));
	q.deliver("second", reply("m2"));
	q.deliver("third", reply("m3"));
	frame("first");
	q.sent(CH, "quick answer", "m3");
	q.onAnswer("answer to first");
	idle();
	expect(s.sent).toEqual(["first"]);
	expect(s.settled.toSorted()).toEqual(["m2", "m3"]);
	expect(q.isAnswered("m2")).toBe(true);
});

test("each owner message of an answered burst stops waiting in the UI", () => {
	awaiting.set("ch:settle", [{ ref: "a", by: "a" }, { ref: "b", by: "c" }, { ref: "c", by: "c" }, { ref: "other", by: "other" }]);
	settleRefs("ch:settle", ["a", "c"]);
	expect(awaiting.get("ch:settle")).toEqual([{ ref: "other", by: "other" }]);
});

test("a lone message waits only the short window; 3-second gaps behind an unanswered message are gathered into one flush", async () => {
	const T = "t-burst";
	process.env.DOTZ_NO_ORCHESTRATOR = "1";
	const msg = (id: string) => ({ ts: new Date().toISOString(), kind: "message", source: "web", channel: T, author: "local", text: id, mid: id });
	intake(msg("m1"), T, "m1");
	await advance(1999);
	expect(bursts.has(T)).toBe(true);
	await advance(1);
	expect(bursts.has(T)).toBe(false);   // lone message latency: unchanged 2 s
	expect(awaiting.get(T)?.map(w => w.ref)).toEqual(["m1"]);
	await advance(1000);
	for (const id of ["m2", "m3", "m4"]) {
		intake(msg(id), T, id);
		await advance(3000);
		expect(bursts.has(T)).toBe(true);
	}
	expect(bursts.get(T)!.events.map(e => e.text)).toEqual(["m2", "m3", "m4"]);
	await advance(9000);
	expect(bursts.has(T)).toBe(false);
	// The answer arrived: the next message opens a new exchange, not a burst, and gets the short window.
	awaiting.set(T, []);
	intake(msg("m5"), T, "m5");
	await advance(2000);
	expect(bursts.has(T)).toBe(false);
	await advance(GATHER_MAX_MS);
	delete process.env.DOTZ_NO_ORCHESTRATOR;
});

test("a lane's burst while its turn is starting joins that turn instead of asking for a second one", () => {
	const sends: { text: string; mode: string }[] = [];
	const lane = { name: "burst", status: "idle", ctx: { compaction: { state: "idle" } }, proc: { send: (text: string, mode: string) => sends.push({ text, mode }) } } as unknown as Lane;
	prompt(lane, "[owner via web] one");
	expect(lane.prompted).toBe("[owner via web] one");
	prompt(lane, "[owner via web] two");
	expect(sends.map(s => s.mode)).toEqual(["prompt", "steer"]);
	expect(lane.prompted).toBe("[owner via web] one");
	clearTimeout(lane.watchdog);
});
