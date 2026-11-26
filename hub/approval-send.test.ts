import { describe, expect, test } from "bun:test";
import { createApprovalSender, outcomeOf, refOfQuestion, runCli, sendActionOf, sendArgv, type SendResult } from "./approval-send.ts";
import { flush } from "./runtime/test-clock.ts";
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

	test("code's repair runs only on the approved version; one that changes it (a Re: subject) sends nothing and takes the pick back, one that keeps it (a re-login) sends", async () => {
		const world = (o: { rewrites: boolean; changed?: true }) => {
			const changed = o.changed === true;
			let subject = "안녕";
			const runs: string[] = [], repaired: string[] = [], revoked: string[] = [], timers: (() => void)[] = [];
			let done: (r: SendResult) => void = () => undefined;
			const ended = new Promise<SendResult>(resolve => (done = resolve));
			const s = createApprovalSender({
				kind: () => PLACES.RAAAAAA,
				fingerprint: async () => subject,
				run: async () => (runs.push(subject), runs.length === 1 ? { code: 1, out: said({ sent: "no", code: "subject_re" }) } : { code: 0, out: "" }),
				repair: async () => (repaired.push(subject), o.rewrites && (subject = `Re: ${subject}`), "fixed"),
				revoke: (_j, why) => void revoked.push(why),
				after: (_ms, fn) => void timers.push(fn),
				report: r => void (runs.length && r.state !== "queued" && r.state !== "sending" && !(r.state === "failed" && r.safeToAuto) && done(r)),
				log: () => undefined,
			});
			s.enqueue({ ref: "RAAAAAA", conv: "c", action: "send", title: "q (RAAAAAA)", hash: "안녕", by: "owner" });
			const retry = async () => {
				await s.idle();
				if (changed) subject = "다른 제목";
				for (const fn of timers.splice(0)) fn();
				return ended;
			};
			return { runs, repaired, revoked, retry };
		};
		const relogin = world({ rewrites: false });
		expect(await relogin.retry()).toMatchObject({ state: "sent" });
		expect([relogin.runs, relogin.revoked]).toEqual([["안녕", "안녕"], []]);
		const re = world({ rewrites: true });
		expect(await re.retry()).toMatchObject({ state: "failed", reason: { code: "changed" } });
		expect([re.repaired, re.runs, re.revoked]).toEqual([["안녕"], ["안녕"], ["changed"]]);
		const moved = world({ rewrites: true, changed: true });
		expect(await moved.retry()).toMatchObject({ state: "failed", reason: { code: "changed" } });
		expect([moved.repaired, moved.runs, moved.revoked]).toEqual([[], ["안녕"], ["changed"]]);
	});

	test("the gate's `changed` refusal takes the owner's pick back (no CLI can send on it later), and sends nothing", async () => {
		const revoked: string[] = [], runs: string[] = [];
		const s = createApprovalSender({ kind: () => PLACES.RAAAAAA, fingerprint: async () => "v2", run: async a => (runs.push(a[3]!), { code: 0, out: "" }), revoke: (j, why) => void revoked.push(`${j.ref} ${why}`), report: () => undefined, log: () => undefined });
		s.enqueue({ ref: "RAAAAAA", conv: "c", action: "send", title: "q (RAAAAAA)", hash: "v1", by: "owner" });
		await s.idle();
		expect([s.results()[0]?.state, s.results()[0]?.reason?.code, runs, revoked]).toEqual(["failed", "changed", [], ["RAAAAAA changed"]]);
	});

	test("a CLI's detail (the place's own answer) reaches the log line and the kept result, bounded (Dggtza6)", async () => {
		const logged: string[] = [];
		const out = `${said({ sent: "no", code: "rejected", part: "reply", detail: `site said: duplicate text ${"y".repeat(400)}` })}
답글을 올리지 못했어요: 사이트에서 이 글을 받지 않았어요`;
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: async () => ({ code: 1, out }), report: () => undefined, log: l => void logged.push(l) });
		expect(s.enqueue({ ref: "D1", conv: "comment:site-a", action: "send", title: "q (D1)" })).toBe(true);
		await s.idle();
		const r = s.results().find(x => x.ref === "D1")!;
		expect(r).toMatchObject({ state: "failed", reason: { code: "rejected" } });
		expect(r.detail!.startsWith("site said: duplicate text")).toBe(true);
		expect(r.detail!.length).toBe(300);
		expect(logged.filter(l => l.startsWith("approved send D1") && l.includes("site said: duplicate text"))).toHaveLength(1);
	});

	test("a long error output after the result line keeps the line: surely not sent, not 'may have gone out'", async () => {
		const script = `console.log(${JSON.stringify(said({ sent: "no", code: "offline" }))}); console.error("w".repeat(6000)); process.exit(1);`;
		const r = await runCli([process.execPath, "-e", script]);
		expect(r.out.length).toBeLessThan(4500);
		expect(outcomeOf(r)).toEqual({ sent: "no", code: "offline" });
	});

	test("every DOTZ_SEND line the CLI printed reaches outcomeOf, however long the output after them: a posted reply with a refused mail stays a partial send", async () => {
		const script = `console.log(${JSON.stringify(said({ sent: "yes", part: "reply" }))}); console.log(${JSON.stringify(said({ sent: "no", code: "attach_mismatch", part: "mail" }))}); console.error("w".repeat(6000)); process.exit(1);`;
		const r = await runCli([process.execPath, "-e", script]);
		expect(r.out.length).toBeLessThan(4500);
		expect(outcomeOf(r)).toMatchObject({ sent: "partial", rest: "no", code: "attach_mismatch" });
	});

	test("a reply that may have gone up is never `no`, whatever the mail line after it says; its own reason and detail are kept", () => {
		const out = [said({ sent: "maybe", code: "net_cut", part: "reply", detail: "the site hung up" }), said({ sent: "no", code: "offline", part: "mail" })].join("\n");
		expect(outcomeOf({ code: 1, out })).toEqual({ sent: "maybe", code: "net_cut", detail: "the site hung up" });
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: async () => ({ code: 1, out }), report: () => undefined, log: () => undefined });
		s.enqueue({ ref: "D1", conv: "comment:site-a", action: "send", title: "q (D1)" });
		return s.idle().then(() => {
			expect(s.results().find(x => x.ref === "D1")).toMatchObject({ state: "unsure", reason: { code: "net_cut" }, detail: "the site hung up" });
		});
	});

	test("code's own retry waiting on its repair steps aside when the owner's 다시 보내기 took the job meanwhile: one more send, no second run on a draft already sent", async () => {
		const runs: string[] = [], timers: (() => void)[] = [];
		const repairStarted = Promise.withResolvers<void>();
		const repairGate = Promise.withResolvers<void>();
		const s = createApprovalSender({
			kind: () => PLACES.RAAAAAA,
			run: async () => (runs.push("run"), runs.length === 1 ? { code: 1, out: said({ sent: "no", code: "login_expired" }) } : { code: 0, out: "" }),
			repair: async () => (repairStarted.resolve(), await repairGate.promise, "fixed"),
			after: (_ms, fn) => void timers.push(fn),
			report: () => undefined,
			log: () => undefined,
		});
		s.enqueue({ ref: "RAAAAAA", conv: "c", action: "send", title: "q (RAAAAAA)", by: "owner" });
		await s.idle();
		expect(s.results()[0]).toMatchObject({ state: "failed", safeToAuto: true });
		for (const fn of timers.splice(0)) fn();
		await repairStarted.promise;
		s.enqueue({ ref: "RAAAAAA", conv: "c", action: "send", title: "q (RAAAAAA)", retry: true, by: "owner" });
		await s.idle();
		expect(s.results()[0]).toMatchObject({ state: "sent" });
		repairGate.resolve();
		await flush();
		await s.idle();
		expect(runs).toHaveLength(2);
		expect(s.results()[0]).toMatchObject({ state: "sent" });
	});

	test("a report that throws is logged and leaves no place stuck sending", async () => {
		const g = gatedRun();
		const logs: string[] = [];
		const s = createApprovalSender({
			kind: ref => PLACES[ref],
			run: g.run,
			report: r => {
				if (r.state === "sent") throw new Error("EACCES: permission denied");
			},
			log: l => void logs.push(l),
		});
		expect(s.enqueue({ ref: "D1", conv: "ch:1", action: "send", title: "q (D1)" })).toBe(true);
		await g.startedCount(1);
		g.finish("D1");
		await s.idle();
		expect(s.results().find(r => r.ref === "D1")?.state).toBe("sent");
		expect(logs.some(l => l.includes("EACCES"))).toBe(true);
		expect(s.enqueue({ ref: "D2", conv: "ch:1", action: "send", title: "q (D2)" })).toBe(true);
		await g.startedCount(2);
		g.finish("D2");
		await s.idle();
		expect(s.results().find(r => r.ref === "D2")?.state).toBe("sent");
	});

	test("the send commands are the ones the bot runs", () => {
		expect(sendArgv("comment", "D1", "send-mail", "bun").slice(2)).toEqual(["send", "D1", "--only", "mail", "--no-learn"]);
		expect(sendArgv("comment", "D1", "send-mail", "bun", true)!.slice(2)).toEqual(["send", "D1", "--only", "mail", "--retry", "--no-learn"]);
		expect(sendArgv("mail", "RAAAAAA", "send", "bun")!.slice(1)).toEqual([expect.stringMatching(/features\/reply-drafts\/bin\/draft\.ts$/), "send", "RAAAAAA", "--no-learn"]);
		expect(sendActionOf("보내기")).toBe("send");
		expect(sendActionOf("고치기")).toBeUndefined();
		expect(sendActionOf("어떻게 보낼지 직접 입력")).toBeUndefined();
		expect(refOfQuestion("이대로 보낼까? (D2jwqz9)")).toBe("D2jwqz9");
	});

	test("a reply that went up while its mail failed is told with the mail's own reason (CM-7)", async () => {
		const out = [said({ sent: "yes", part: "reply" }), said({ sent: "maybe", code: "unknown", part: "mail", detail: "smtp refused" })].join("\n");
		expect(outcomeOf({ code: 1, out })).toMatchObject({ sent: "partial", done: 1, total: 2, rest: "maybe" });
		const reports: SendResult[] = [];
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: async () => ({ code: 1, out }), report: r => void reports.push(r), log: () => undefined });
		s.enqueue({ ref: "D1", conv: "comment:site-a", action: "send", title: "q (D1)" });
		await s.idle();
		expect(reports.at(-1)?.text).toBe("답글은 올렸고 메일은 못 보냈어요: smtp refused");
		const refused = [said({ sent: "yes", part: "reply" }), said({ sent: "no", code: "attach_mismatch", part: "mail", detail: "첨부를 확인해 주세요: 본문에 쓴 파일이 안 붙었어요" })].join("\n");
		expect(outcomeOf({ code: 1, out: refused })).toMatchObject({ sent: "partial", rest: "no", code: "attach_mismatch" });
		expect(outcomeOf({ code: 0, out: [said({ sent: "yes", part: "reply" }), said({ sent: "yes", part: "mail" })].join("\n") })).toEqual({ sent: "yes" });
		expect(outcomeOf({ code: 1, out: [said({ sent: "no", code: "offline", part: "reply" }), said({ sent: "no", code: "offline", part: "mail" })].join("\n") })).toEqual({ sent: "no", code: "offline" });
	});

	test("a send command that exits 5 sent the mail and only failed its cleanup: sent plus one cleanup notice, and it is never run again", async () => {
		expect(outcomeOf({ code: 5, out: "mail went out; the cleanup failed" })).toMatchObject({ sent: "yes", cleanup: true });
		// A line that says where the mail is outranks the exit code.
		expect(outcomeOf({ code: 5, out: said({ sent: "no", code: "offline" }) })).toEqual({ sent: "no", code: "offline" });
		const reports: SendResult[] = [];
		const runs: string[][] = [];
		const s = createApprovalSender({ kind: ref => PLACES[ref], run: async argv => (runs.push(argv), { code: 5, out: "cleanup failed" }), report: r => void reports.push(r), log: () => undefined });
		expect(s.enqueue({ ref: "RAAAAAA", conv: "mail:zele", action: "send", title: "q (RAAAAAA)" })).toBe(true);
		await s.idle();
		expect(reports.at(-1)).toMatchObject({ ref: "RAAAAAA", state: "sent" });
		expect(reports.at(-1)!.text).not.toBe("");
		expect(runs).toHaveLength(1);
		expect(s.results().find(r => r.ref === "RAAAAAA")?.state).toBe("sent");
	});
});
