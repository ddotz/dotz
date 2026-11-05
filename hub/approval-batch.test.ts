import { expect, test } from "bun:test";
import { answerBatch, type BatchCard, type BatchDeps, type BatchPick } from "./approval-batch.ts";

// 보내지 않기 (n 3) in the review queue: a draft the gateway can drop is dropped by it and recorded with no model turn; any other goes to the bot.
const cards: BatchCard[] = ["D1", "D2", "R3"].map(ref => ({ ref, question: `이 답글 올릴까요? (${ref})`, text: "" }));
const setup = (canDrop: (ref: string) => boolean) => {
	const log = { dropped: [] as string[], sent: [] as string[], recorded: [] as { text: string; picks: BatchPick[]; deliver: boolean }[] };
	const deps: BatchDeps = {
		cards: () => cards,
		take: () => undefined,
		record: async (_c, text, picks, deliver) => void log.recorded.push({ text, picks, deliver }),
		settle: () => undefined,
		canSend: () => true,
		enqueue: j => void log.sent.push(j.ref),
		canDrop,
		dropDraft: ref => void log.dropped.push(ref),
	};
	return { log, deps };
};

test("보내지 않기 on a draft the gateway can drop: dropped, recorded for the approval check, not sent, no turn for the bot", async () => {
	const { log, deps } = setup(() => true);
	const r = await answerBatch("main", [{ ref: "D1", n: 3 }, { ref: "D2", n: 1 }], deps);
	expect(r.status).toBe(200);
	expect(log.dropped).toEqual(["D1"]);
	expect(log.sent).toEqual(["D2"]);
	expect(log.recorded).toHaveLength(1);
	expect(log.recorded[0]!.deliver).toBe(false);
	expect(log.recorded[0]!.picks.map(p => [p.n, p.label])).toEqual([[3, "보내지 않기"], [1, "보내기"]]);
});

test("보내지 않기 on a draft the gateway cannot drop goes to the bot in one message and drops nothing itself", async () => {
	const { log, deps } = setup(ref => ref !== "R3");
	const r = await answerBatch("main", [{ ref: "R3", n: 3 }, { ref: "D1", n: 3 }], deps);
	expect(r.body).toMatchObject({ ok: true, sending: 1, toBot: 1 });
	expect(log.dropped).toEqual(["D1"]);
	expect(log.recorded.map(x => x.deliver)).toEqual([false, true]);
	expect(log.recorded[1]!.text).toContain("3) 보내지 않기");
});

test("an open card the gateway answers keeps its button's label, and only after the answer is recorded: a record that fails leaves the card open", async () => {
	const open: BatchCard = { ...cards[0]!, notice: "n1" };
	const { deps } = setup(() => true);
	const steps: string[] = [];
	deps.cards = () => [open];
	deps.record = async (_c, _t, _p, _d, notice) => void steps.push(`record:${notice ?? "none"}`);
	deps.settle = (id, label) => void steps.push(`settle:${id}:${label}`);
	await answerBatch("main", [{ ref: "D1", n: 1 }], deps);
	expect(steps).toEqual(["record:none", "settle:n1:1) 보내기"]);

	steps.length = 0;
	deps.record = async () => { throw new Error("disk full"); };
	await expect(answerBatch("main", [{ ref: "D1", n: 1 }], deps)).rejects.toThrow("disk full");
	expect(steps).toEqual([]);
});

test("a record that throws takes no held card out of the queue, sends nothing and passes the error on", async () => {
	const held: BatchCard[] = cards.map(c => ({ ...c }));
	const { log, deps } = setup(() => true);
	const taken: string[] = [];
	deps.cards = () => held;
	deps.take = (_c, refs) => void taken.push(...refs);
	deps.record = async () => {
		throw new Error("inbox is full");
	};
	await expect(answerBatch("main", [{ ref: "D1", n: 1 }, { ref: "D2", n: 1 }], deps)).rejects.toThrow("inbox is full");
	expect(taken).toEqual([]);
	expect(log.sent).toEqual([]);
});

test("held cards leave the queue once the answer is recorded, before the open card is settled", async () => {
	const open: BatchCard = { ...cards[0]!, notice: "n1" };
	const { deps } = setup(() => true);
	const steps: string[] = [];
	deps.cards = () => [open, cards[1]!];
	deps.take = (_c, refs) => void steps.push(`take:${refs.join(",")}`);
	deps.record = async () => void steps.push("record");
	deps.settle = id => void steps.push(`settle:${id}`);
	await answerBatch("main", [{ ref: "D1", n: 1 }, { ref: "D2", n: 1 }], deps);
	expect(steps).toEqual(["record", "take:D2", "settle:n1"]);
});
