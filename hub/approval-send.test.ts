import { describe, expect, test } from "bun:test";
import { createApprovalSender, refOfQuestion, sendActionOf, sendArgv, type SendResult } from "./approval-send.ts";
import { reasonOf } from "./reply-reasons.ts";

const said = (o: object) => `DOTZ_SEND ${JSON.stringify(o)}`;

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
	test("the sender asks the store about the action too: a posted reply with a mail left can send the mail and nothing else", () => {
		const s = createApprovalSender({ kind: (ref, action) => (ref === "D9" && action === "send-mail" ? PLACES.D1 : undefined), run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined });
		expect(s.can("D9", "send")).toBe(false);
		expect(s.can("D9", "send-mail")).toBe(true);
		expect(s.enqueue({ ref: "D9", conv: "ch:1", action: "send", title: "x (D9)" })).toBe(false);
	});

	test("one place sends in the order approved, another place runs beside it, and a failure stops nothing", async () => {
		const g = gatedRun();
		const reports: SendResult[] = [];
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: g.run, report: r => void reports.push(r), log: () => undefined });
		for (const ref of ["D1", "D2", "RAAAAAA", "D3"]) expect(s.enqueue({ ref, conv: "ch:1", action: "send", title: `이 답글 올릴까요? (${ref})` })).toBe(true);
		await g.startedCount(2);
		// The comment site runs D1 alone; the mail account does not wait for it.
		expect(g.started).toEqual(["D1", "RAAAAAA"]);
		g.finish("D1", 1, `Error: invalid_grant\n    at refresh (x.js:1:1)\n${said({ sent: "no", code: "login_expired" })}`);
		await g.startedCount(3);
		expect(g.started).toEqual(["D1", "RAAAAAA", "D2"]);
		g.finish("RAAAAAA");
		g.finish("D2");
		await g.startedCount(4);
		g.finish("D3");
		await s.idle();
		const last = new Map(reports.map(r => [r.ref, r]));
		expect(Object.fromEntries([...last.values()].map(r => [r.ref, r.state]))).toEqual({ D1: "failed", RAAAAAA: "sent", D2: "sent", D3: "sent" });
		// The owner reads the reason's plain text, never the tool's stack line.
		expect(last.get("D1")!.text).toBe(reasonOf("login_expired").text);
		expect(last.get("D1")!.reason?.code).toBe("login_expired");
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
		g.finish("D1", 1, said({ sent: "no", code: "rejected" }));
		await s.idle();
		expect(g.started).toEqual(["D1"]);
		expect(s.enqueue({ ref: "D1", conv: "c", action: "send", title: "q (D1)" })).toBe(true);
		await g.startedCount(2);
		g.finish("D1");
		await s.idle();
		expect(s.results("c").map(r => r.state)).toEqual(["sent"]);
	});

	test("more sends waiting than the results it keeps: a second approval of a waiting one still sends nothing", async () => {
		const g = gatedRun();
		const s = createApprovalSender({ kind: () => PLACES.D1, run: g.run, report: () => undefined, log: () => undefined });
		const job = (ref: string) => ({ ref, conv: "c", action: "send" as const, title: `q (${ref})` });
		for (let i = 0; i < 250; i++) s.enqueue(job(`Q${i}`));
		s.enqueue(job("Q1"));
		s.enqueue(job("END"));
		for (let i = 0; g.started[i - 1] !== "END"; i++) {
			await g.startedCount(i + 1);
			g.finish(g.started[i]!);
		}
		expect(g.started.filter(r => r === "Q1")).toHaveLength(1);
		expect(g.started).toHaveLength(251);
	});

	test("the send commands are the ones the bot runs", () => {
		expect(sendArgv("comment", "D1", "send-mail", "bun").slice(2)).toEqual(["send", "D1", "--only", "mail"]);
		expect(sendArgv("comment", "D1", "send-mail", "bun", true)!.slice(2)).toEqual(["send", "D1", "--only", "mail", "--retry"]);
		expect(sendArgv("mail", "RAAAAAA", "send", "bun")![1]).toEndWith("features/reply-drafts/bin/draft.ts");
		expect(sendActionOf("보내기")).toBe("send");
		expect(sendActionOf("고치기")).toBeUndefined();
		expect(sendActionOf("어떻게 보낼지 직접 입력")).toBeUndefined();
		expect(refOfQuestion("이대로 보낼까? (D2jwqz9)")).toBe("D2jwqz9");
	});
});
