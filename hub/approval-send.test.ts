import { describe, expect, test } from "bun:test";
import { createApprovalSender, refOfQuestion, sendActionOf, sendArgv, type SendResult } from "./approval-send.ts";
import { answerBatch, batchCard, type BatchCard, type BatchPick } from "./approval-batch.ts";
import { draftApprovalBlock } from "./draft-approval.ts";

// A run whose sends finish only when the test says so, so the order and the overlap are what is asserted, not timing.
function gatedRun() {
	const started: string[] = [];
	const gates = new Map<string, (r: { code: number; out: string }) => void>();
	const waiters: Array<() => void> = [];
	return {
		started,
		run: (argv: string[]) =>
			new Promise<{ code: number; out: string }>(resolve => {
				const ref = argv[3]!;
				started.push(ref);
				gates.set(ref, resolve);
				for (const w of waiters.splice(0)) w();
			}),
		finish: (ref: string, code = 0, out = `보냈어요 (${ref})`) => gates.get(ref)!({ code, out }),
		// Resolves once `n` sends have started.
		startedCount: (n: number) =>
			new Promise<void>(resolve => {
				const check = () => (started.length >= n ? resolve() : waiters.push(check));
				check();
			}),
	};
}

const PLACES: Record<string, { kind: "comment" | "mail"; lane: string }> = {
	D1: { kind: "comment", lane: "comment:site-a" },
	D2: { kind: "comment", lane: "comment:site-a" },
	D3: { kind: "comment", lane: "comment:site-a" },
	RAAAAAA: { kind: "mail", lane: "mail:zele" },
};

describe("approval sender", () => {
	test("one place sends in the order approved, another place runs beside it, and a failure stops nothing", async () => {
		const g = gatedRun();
		const reports: SendResult[] = [];
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: g.run, report: r => void reports.push(r), log: () => undefined });
		for (const ref of ["D1", "D2", "RAAAAAA", "D3"]) expect(s.enqueue({ ref, conv: "ch:1", action: "send", title: `이 답글 올릴까요? (${ref})` })).toBe(true);
		await g.startedCount(2);
		// The comment site runs D1 alone; the mail account does not wait for it.
		expect(g.started).toEqual(["D1", "RAAAAAA"]);
		g.finish("D1", 1, "답글을 올리지 못했어요: 로그인이 풀렸어요");
		await g.startedCount(3);
		expect(g.started).toEqual(["D1", "RAAAAAA", "D2"]);
		g.finish("RAAAAAA");
		g.finish("D2");
		await g.startedCount(4);
		g.finish("D3");
		await s.idle();
		const last = new Map(reports.map(r => [r.ref, r]));
		expect(Object.fromEntries([...last.values()].map(r => [r.ref, r.state]))).toEqual({ D1: "failed", RAAAAAA: "sent", D2: "sent", D3: "sent" });
		expect(last.get("D1")!.text).toBe("답글을 올리지 못했어요: 로그인이 풀렸어요");
	});

	test("a second approval of the same draft sends nothing; an unknown ref is left to the bot; a failed one may be approved again", async () => {
		const g = gatedRun();
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: g.run, report: () => undefined, log: () => undefined });
		expect(s.enqueue({ ref: "D1", conv: "c", action: "send", title: "q (D1)" })).toBe(true);
		expect(s.enqueue({ ref: "D1", conv: "c", action: "send", title: "q (D1)" })).toBe(true);
		expect(s.enqueue({ ref: "indi:57236452", conv: "c", action: "send", title: "q" })).toBe(false);
		// 답글만 / 메일만 belong to a comment card: a mail draft has only the whole send.
		expect(s.can("RAAAAAA", "send-main")).toBe(false);
		await g.startedCount(1);
		g.finish("D1", 1, "실패");
		await s.idle();
		expect(g.started).toEqual(["D1"]);
		expect(s.enqueue({ ref: "D1", conv: "c", action: "send", title: "q (D1)" })).toBe(true);
		await g.startedCount(2);
		g.finish("D1");
		await s.idle();
		expect(s.results("c").map(r => r.state)).toEqual(["sent"]);
	});

	test("the send commands are the ones the bot runs", () => {
		expect(sendArgv("comment", "D1", "send-mail", "bun").slice(2)).toEqual(["send", "D1", "--only", "mail"]);
		expect(sendArgv("mail", "RAAAAAA", "send", "bun")![1]).toEndWith("features/reply-drafts/bin/draft.ts");
		expect(sendActionOf("보내기")).toBe("send");
		expect(sendActionOf("고치기")).toBeUndefined();
		expect(sendActionOf("어떻게 보낼지 직접 입력")).toBeUndefined();
		expect(refOfQuestion("이대로 보낼까? (D2jwqz9)")).toBe("D2jwqz9");
	});
});

const cardText = (ref: string) => `[ask] 댓글 답글\n${draftApprovalBlock({ to: `${ref} 댓글`, toLabel: "대상", body: `${ref} 답글`, ref, question: "이 답글 올릴까요?" })}`;

describe("batch answer", () => {
	function world(sendable: string[]) {
		const cards: BatchCard[] = [{ ...batchCard("D1", cardText("D1")), notice: "n1" }, batchCard("D2", cardText("D2")), batchCard("D3", cardText("D3")), batchCard("D4", cardText("D4"))];
		const log: string[] = [];
		const recorded: { text: string; picks: BatchPick[]; deliver: boolean; notice?: string }[] = [];
		const deps = {
			cards: () => cards,
			take: (_c: string, refs: string[]) => void log.push(`take ${refs.join(",")}`),
			record: async (_c: string, text: string, picks: BatchPick[], deliver: boolean, notice?: string) => void recorded.push({ text, picks, deliver, ...(notice ? { notice } : {}) }),
			settle: (id: string, label: string) => void log.push(`settle ${id} ${label}`),
			canSend: (ref: string) => sendable.includes(ref),
			enqueue: (j: { ref: string }) => void log.push(`send ${j.ref}`),
		};
		return { deps, log, recorded };
	}

	test("picked cards are answered, skipped ones stay; the gateway's sends are recorded quietly, the rest go to the bot in one message", async () => {
		const w = world(["D1", "D2"]);
		const r = await answerBatch("ch:1", [{ ref: "D1", n: 1 }, { ref: "D2", n: 1 }, { ref: "D3", n: 2, note: "더 짧게" }], w.deps);
		expect(r.body).toEqual({ ok: true, sending: 2, toBot: 1 });
		// D4 was not picked: it is not taken, not recorded, not sent.
		expect(w.log).toEqual(["take D2,D3", "settle n1 1) 보내기", "send D1", "send D2"]);
		expect(w.recorded.map(x => [x.deliver, x.notice ?? "", x.picks.map(p => `${p.q}=${p.label}`)])).toEqual([
			[false, "n1", ["이 답글 올릴까요? (D1)=보내기", "이 답글 올릴까요? (D2)=보내기"]],
			[true, "", ["이 답글 올릴까요? (D3)=고치기"]],
		]);
		expect(w.recorded[1]!.text).toContain("2) 고치기 - 더 짧게");
	});

	test("nothing is answered when a pick is incomplete or names a card that is gone", async () => {
		const w = world(["D1"]);
		expect((await answerBatch("ch:1", [{ ref: "D2", n: 2 }], w.deps)).status).toBe(400);
		expect((await answerBatch("ch:1", [{ ref: "D9", n: 1 }], w.deps)).status).toBe(409);
		expect((await answerBatch("ch:1", [], w.deps)).status).toBe(400);
		expect(w.log).toEqual([]);
		expect(w.recorded).toEqual([]);
	});
});
