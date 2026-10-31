// A fresh install steers an owner message into its conversation's running turn, as the owner's Mac mini does (2026-11-01: on
// another computer the same message waited for the turn to end). With no `conversations` key every conversation gets its own
// session (config.ts convSessionsIn), so the shared main session busy with a gateway turn no longer holds the message back.
import { expect, test } from "bun:test";
import { convSessionsIn } from "./config.ts";
import { createPrompts } from "./prompts.ts";
import { adapters } from "./runtime/index.ts";
import { MAIN, sessionKeyOf } from "./session-key.ts";

function session() {
	const s = { working: false, delivered: [] as string[], steered: [] as string[] };
	const q = createPrompts({
		deliver: text => s.delivered.push(text),
		steer: text => (s.steered.push(text), true),
		working: () => s.working,
		note: (_t, _r, text) => `[note] ${text}`,
		isNote: text => text.startsWith("[note]"),
		post: async () => ({ delivered: true }),
		clearProgress: () => {},
		persist: () => {},
		log: () => {},
	});
	return { s, q };
}

test("a fresh config (no conversations key) and an empty block turn conversation sessions on; only an explicit false turns them off", () => {
	expect(convSessionsIn({})).toBe(true);
	expect(convSessionsIn({ conversations: {} })).toBe(true);
	expect(convSessionsIn({ conversations: { sessions: true } })).toBe(true);
	expect(convSessionsIn({ conversations: { sessions: false } })).toBe(false);
});

test("fresh default: a second owner message in a channel is steered into that channel's running turn, even while main runs a gateway turn", () => {
	const rules = { on: convSessionsIn({}) };
	const sessions = new Map([[MAIN, session()]]);
	const of = (target: string) => {
		const key = sessionKeyOf(target, rules);
		if (!sessions.has(key)) sessions.set(key, session());
		return sessions.get(key)!;
	};
	// main is mid-turn on a watch check the gateway started (no owner request of ours).
	const main = sessions.get(MAIN)!;
	main.q.deliver("[watch] check the inbox");
	main.s.working = true;
	main.q.onPrompt("[watch] check the inbox");

	const ch = of("ch:5");
	expect(ch).not.toBe(main);
	expect(ch.q.deliver("배포해줘", { target: "ch:5", replyTo: "m1", owner: true })).toBe(false);
	expect(ch.s.delivered).toEqual(["배포해줘"]);
	ch.s.working = true;
	ch.q.onPrompt("배포해줘");

	expect(ch.q.deliver("아 그거 말고 staging으로", { target: "ch:5", replyTo: "m2", owner: true })).toBe(true);
	expect(ch.s.steered).toEqual(["[note] 아 그거 말고 staging으로"]);
	expect(main.s.steered).toEqual([]);
	expect(main.s.delivered).toEqual(["[watch] check the inbox"]);
});

test("with sessions explicitly off the same message waits behind main's gateway turn (the opt-out keeps the old behaviour)", () => {
	const rules = { on: convSessionsIn({ conversations: { sessions: false } }) };
	expect(sessionKeyOf("ch:5", rules)).toBe(MAIN);
	const { s, q } = session();
	q.deliver("[watch] check the inbox");
	s.working = true;
	q.onPrompt("[watch] check the inbox");
	expect(q.deliver("배포해줘", { target: "ch:5", replyTo: "m1", owner: true })).toBe(false);
	expect(s.steered).toEqual([]);
});

test("every runtime dotz can run (omo, omp, claude) inserts a message into a running turn natively", () => {
	for (const [id, a] of Object.entries(adapters)) expect([id, a.caps.steer]).toEqual([id, "native"]);
});
