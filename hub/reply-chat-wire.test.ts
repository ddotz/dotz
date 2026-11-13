import { afterEach, expect, test } from "bun:test";
import { bursts, dropPending, flush, intake } from "./intake.ts";
import { setReplies, type createReplyActions } from "./reply-actions.ts";

type Replies = ReturnType<typeof createReplyActions>;
const item = (ref: string, conv: string, at: number) => ({ item: `mail:${ref}`, ref, kind: "mail", app: "mail", label: "메일", conv, at, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "", to: "", text: "x" } });

// A fake reply flow: the list the test gives, and each act call resolved to the test as it arrives.
function fake(items: ReturnType<typeof item>[]) {
	const acts: Record<string, unknown>[] = [];
	let listed!: () => void;
	const listedOnce = new Promise<void>(r => (listed = r));
	let acted!: (a: Record<string, unknown>) => void;
	const actedOnce = new Promise<Record<string, unknown>>(r => (acted = r));
	setReplies({
		list: async () => (queueMicrotask(listed), items),
		act: async (input: Record<string, unknown>) => (acts.push(input), acted(input), { status: 200, body: { ok: true } }),
	} as unknown as Replies);
	return { acts, listedOnce, actedOnce };
}
const say = (target: string, text: string) => {
	intake({ ts: new Date().toISOString(), kind: "message", source: "web", channel: target, author: "local", text }, target, "m1");
	flush(target);
};
afterEach(() => setReplies(undefined));

test("a typed 보내 with one open card in the conversation sends it, with no model turn", async () => {
	const f = fake([item("RA00001", "t-wire-1", 1)]);
	say("t-wire-1", "보내");
	expect(await f.actedOnce).toEqual({ ref: "RA00001", action: "send" });
	expect(bursts.has("t-wire-1")).toBe(false);
});

test("좀 더 짧게 starts a revise of that card", async () => {
	const f = fake([item("RA00002", "t-wire-2", 1)]);
	say("t-wire-2", "좀 더 짧게 해줘");
	expect(await f.actedOnce).toMatchObject({ ref: "RA00002", action: "revise" });
});

test("two open cards and no quote change nothing; the message goes back to its burst as an ordinary turn", async () => {
	const f = fake([item("RA00003", "t-wire-3", 1), item("RA00004", "t-wire-3", 2)]);
	say("t-wire-3", "보내");
	// A second message typed while the cards are read keeps the burst open, so the miss joins it instead of starting a real turn here.
	intake({ ts: new Date().toISOString(), kind: "message", source: "web", channel: "t-wire-3", author: "local", text: "아 잠깐" }, "t-wire-3", "m2");
	await f.listedOnce;
	for (let i = 0; i < 100 && !bursts.get("t-wire-3")?.cardsRead; i++) await Promise.resolve();
	expect(bursts.get("t-wire-3")?.events.map(e => e.text)).toEqual(["보내", "아 잠깐"]);
	expect(f.acts).toEqual([]);
	dropPending("t-wire-3");
});

test("a question never waits for the card list", () => {
	const f = fake([item("RA00005", "t-wire-4", 1)]);
	let listed = false;
	void f.listedOnce.then(() => (listed = true));
	say("t-wire-4", "이 메일 언제 왔어?");
	expect(listed).toBe(false);
	expect(f.acts).toEqual([]);
});
