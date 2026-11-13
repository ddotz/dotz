import { expect, test } from "bun:test";
import { createApprovalSender, outcomeOf, sendArgv, type SendJob, type SendLook, type SendResult } from "./approval-send.ts";

const PLACES: Record<string, { kind: "comment" | "mail"; lane: string }> = {
	RAAAAAA: { kind: "mail", lane: "mail:zele" },
	RBBBBBB: { kind: "mail", lane: "mail:zele" },
	D1: { kind: "comment", lane: "comment:site-a" },
};
const job = (ref: string): SendJob => ({ ref, conv: "ch:1", action: "send", title: `이 답장 보낼까요? (${ref})` });

function memoryStore() {
	const box = { body: "[]" };
	return { box, store: { load: () => JSON.parse(box.body) as unknown[], save: (body: string) => void (box.body = body) } };
}
const left = (m: ReturnType<typeof memoryStore>) => (JSON.parse(m.box.body) as { ref: string; state: string }[]).map(j => `${j.ref}:${j.state}`);

function boot(m: ReturnType<typeof memoryStore>, o: { run?: (argv: string[]) => Promise<{ code: number; out: string }>; look?: (j: SendJob) => SendLook } = {}) {
	const reports: SendResult[] = [];
	const ran: string[][] = [];
	const s = createApprovalSender({
		kind: ref => PLACES[ref],
		run: o.run ?? (async argv => (ran.push(argv), { code: 0, out: "보냈어요" })),
		report: r => void reports.push(r),
		log: () => undefined,
		store: m.store,
		look: o.look,
	});
	return { s, reports, ran };
}
const never = () => new Promise<{ code: number; out: string }>(() => undefined);

test("a send approved but not started when the gateway stopped is queued again on boot, once, and the file empties when it is sent", async () => {
	const m = memoryStore();
	const first = boot(m, { run: never });
	first.s.enqueue(job("RAAAAAA"));
	first.s.enqueue(job("RBBBBBB"));
	expect(left(m)).toEqual(["RAAAAAA:sending", "RBBBBBB:queued"]);

	const second = boot(m, { look: () => ({ state: "failed", text: "x" }) });
	second.s.recover();
	second.s.recover();
	await second.s.idle();
	expect(second.ran.map(a => a[a.length - 1])).toEqual(["RBBBBBB"]);
	expect(second.reports.filter(r => r.ref === "RBBBBBB").map(r => r.state)).toEqual(["queued", "sending", "sent"]);
	// The one that was sending is kept as look judged it, until it is resolved.
	expect(left(m)).toEqual(["RAAAAAA:failed"]);
});

test("a send that was running when the gateway stopped is never run again: what look says is shown and kept until it is resolved", async () => {
	const m = memoryStore();
	boot(m, { run: never }).s.enqueue(job("RAAAAAA"));
	const text = "메일이 이미 나갔을 수 있어요. 확인하고 다시 보내기를 눌러 주세요";
	const second = boot(m, { look: () => ({ state: "failed", text }) });
	second.s.recover();
	await second.s.idle();
	expect(second.ran).toEqual([]);
	expect(second.reports.at(-1)).toMatchObject({ ref: "RAAAAAA", state: "failed", text });
	expect(left(m)).toEqual(["RAAAAAA:failed"]);
});

test("a comment nobody can say went up ends unsure: never run again, no second approval runs it, and a later answer settles it", async () => {
	const m = memoryStore();
	m.box.body = JSON.stringify([{ ...job("D1"), state: "sending" }]);
	const { s, reports, ran } = boot(m, { look: () => ({ state: "unsure", text: "확인 필요" }) });
	s.recover();
	expect(reports.map(r => r.state)).toEqual(["unsure"]);
	expect(s.enqueue(job("D1"))).toBe(true);
	await s.idle();
	expect(ran).toEqual([]);
	expect(left(m)).toEqual(["D1:unsure"]);
	s.settle(job("D1"), "sent");
	expect(s.results().map(r => r.state)).toEqual(["sent"]);
	expect(left(m)).toEqual([]);
});

test("a send whose draft is already sent is marked sent, not run", async () => {
	const m = memoryStore();
	boot(m, { run: never }).s.enqueue(job("RAAAAAA"));
	const second = boot(m, { look: () => ({ state: "sent" }) });
	second.s.recover();
	await second.s.idle();
	expect(second.ran).toEqual([]);
	expect(second.reports.at(-1)).toMatchObject({ ref: "RAAAAAA", state: "sent" });
	expect(left(m)).toEqual([]);
});

test("a send whose sender is still alive keeps waiting, blocks a second approval, and is settled by the later check", async () => {
	const m = memoryStore();
	boot(m, { run: never }).s.enqueue(job("RAAAAAA"));
	let look: SendLook = { state: "alive" };
	const second = boot(m, { look: () => look });
	second.s.recover();
	second.s.recheck();
	expect(second.reports.at(-1)).toMatchObject({ state: "sending" });
	expect(second.s.enqueue(job("RAAAAAA"))).toBe(true);
	await second.s.idle();
	expect(second.ran).toEqual([]);
	expect(left(m)).toEqual(["RAAAAAA:sending"]);
	look = { state: "sent" };
	second.s.recheck();
	expect(second.reports.at(-1)).toMatchObject({ state: "sent" });
	expect(left(m)).toEqual([]);
});

test("a queued send the gateway can no longer make ends failed on boot instead of staying queued", async () => {
	const m = memoryStore();
	m.store.save(JSON.stringify([{ ...job("GONE"), state: "queued" }]));
	const second = boot(m);
	second.s.recover();
	await second.s.idle();
	expect(second.ran).toEqual([]);
	expect(second.reports.at(-1)).toMatchObject({ ref: "GONE", state: "failed" });
	expect(second.reports.at(-1)!.text).not.toBe("");
	expect(left(m)).toEqual([]);
});

test("a send the CLI's gate refuses because the draft is gone ends failed with its reason and leaves nothing behind", async () => {
	const m = memoryStore();
	const t = boot(m, { run: async () => ({ code: 1, out: `초안 RAAAAAA은(는) 이미 sent 상태라 보내지 않았어요\nDOTZ_SEND {"sent":"no","code":"gone"}` }) });
	t.s.enqueue(job("RAAAAAA"));
	await t.s.idle();
	expect(t.reports.at(-1)).toMatchObject({ state: "failed", text: "이미 처리됐거나 없는 초안이에요", reason: { code: "gone" } });
	expect(left(m)).toEqual([]);
});

test("the owner's retry of a mail send reaches the CLI as --retry, a first send does not", () => {
	const first = sendArgv("mail", "RAAAAAA", "send", "bun");
	const retry = sendArgv("mail", "RAAAAAA", "send", "bun", true);
	expect(first).not.toContain("--retry");
	expect(retry!.slice(-2)).toEqual(["RAAAAAA", "--retry"]);
	expect(sendArgv("comment", "D1", "send", "bun", true)).not.toContain("--retry");
});

const line = (o: object) => `DOTZ_SEND ${JSON.stringify(o)}`;

test("a CLI result: its DOTZ_SEND line decides; without one exit 0 is sent and any other exit may have gone out", () => {
	expect(outcomeOf({ code: 1, out: "TypeError: boom\n    at send (x.ts:1:1)" })).toEqual({ sent: "maybe", code: "unknown" });
	expect(outcomeOf({ code: 1, out: line({ sent: "yes" }) })).toEqual({ sent: "yes" });
	expect(outcomeOf({ code: 0, out: "보냈어요" })).toEqual({ sent: "yes" });
	expect(outcomeOf({ code: 1, out: `${line({ sent: "no", code: "offline" })}\n${line({ sent: "no", code: "rejected" })}` })).toEqual({ sent: "no", code: "rejected" });
	expect(outcomeOf({ code: 1, out: line({ sent: "no", code: "made_up" }) })).toEqual({ sent: "maybe", code: "unknown" });
	expect(outcomeOf({ code: 0, out: line({ sent: "maybe", code: "net_cut" }), timedOut: true })).toEqual({ sent: "maybe", code: "timeout" });
});

test("offline is retried by code three times on its own schedule, then stays failed for the owner", async () => {
	const m = memoryStore();
	const waits: number[] = [];
	const due: Array<() => void> = [];
	let runs = 0;
	const reports: SendResult[] = [];
	const s = createApprovalSender({ kind: ref => PLACES[ref], run: async () => (runs++, { code: 1, out: line({ sent: "no", code: "offline" }) }), report: r => void reports.push(r), log: () => undefined, store: m.store, now: () => 0, after: (ms, fn) => void (waits.push(ms), due.push(fn)) });
	s.enqueue({ ...job("RAAAAAA"), retry: true });
	await s.idle();
	for (let i = 0; i < 3; i++) {
		expect(reports.at(-1)).toMatchObject({ state: "failed", safeToAuto: true, auto: { attempt: i + 1, max: 3 } });
		due.shift()!();
		await Bun.sleep(0);
		await s.idle();
	}
	expect(runs).toBe(4);
	expect(waits).toEqual([30_000, 120_000, 600_000]);
	expect(reports.at(-1)).toMatchObject({ state: "failed", safeToAuto: false, reason: { code: "offline" } });
	expect(due).toHaveLength(0);
	expect(left(m)).toEqual(["RAAAAAA:failed"]);
});

test("an unsure send survives a restart; a second approval sends nothing; only the owner's force sends it again", async () => {
	const m = memoryStore();
	const first = boot(m, { run: async () => ({ code: 1, out: line({ sent: "maybe", code: "net_cut" }) }) });
	first.s.enqueue(job("RAAAAAA"));
	await first.s.idle();
	expect(left(m)).toEqual(["RAAAAAA:unsure"]);
	const second = boot(m);
	second.s.recover();
	expect(second.reports.at(-1)).toMatchObject({ state: "unsure", reason: { code: "net_cut" } });
	expect(second.s.enqueue(job("RAAAAAA"))).toBe(true);
	expect(second.s.enqueue({ ...job("RAAAAAA"), retry: true })).toBe(true);
	await second.s.idle();
	expect(second.ran).toEqual([]);
	expect(second.s.enqueue({ ...job("RAAAAAA"), force: true })).toBe(true);
	await second.s.idle();
	expect(second.ran).toHaveLength(1);
	expect(second.ran[0]!.at(-1)).toBe("--retry");
	expect(second.reports.at(-1)).toMatchObject({ state: "sent" });
	expect(left(m)).toEqual([]);
});

// A clock and a timer queue the test moves by hand: an automatic attempt runs when its time comes, never before.
function clock() {
	let at = 1_000_000;
	const due: { at: number; fn: () => void }[] = [];
	return { now: () => at, after: (ms: number, fn: () => void) => void due.push({ at: at + ms, fn }), move: (ms: number) => { at += ms; for (const d of due.filter(x => x.at <= at)) (due.splice(due.indexOf(d), 1), d.fn()); } };
}

test("a failed send with an automatic attempt left keeps its time across a restart and runs then, not before", async () => {
	const m = memoryStore(), c1 = clock();
	const runs: string[][] = [];
	const first = createApprovalSender({ kind: ref => PLACES[ref], run: async argv => (runs.push(argv), { code: 1, out: line({ sent: "no", code: "offline" }) }), report: () => undefined, log: () => undefined, store: m.store, now: c1.now, after: c1.after });
	first.enqueue(job("RAAAAAA"));
	await first.idle();
	expect(left(m)).toEqual(["RAAAAAA:failed"]);
	const c2 = clock();
	const ran: string[][] = [];
	const second = createApprovalSender({ kind: ref => PLACES[ref], run: async argv => (ran.push(argv), { code: 0, out: "보냈어요" }), report: () => undefined, log: () => undefined, store: m.store, now: c2.now, after: c2.after });
	second.recover();
	c2.move(29_000);
	await second.idle();
	expect(ran).toEqual([]);
	c2.move(1_000);
	await second.idle();
	expect(ran).toHaveLength(1);
	expect(left(m)).toEqual([]);
});

test("the sweep's proof moves unsure to sent, no proof changes nothing, an item is asked at most once in 10 minutes, and unsure is never run", async () => {
	const m = memoryStore(), c = clock();
	let proof: "sent" | "unknown" = "unknown";
	const asked: string[] = [];
	const ran: string[][] = [];
	const s = createApprovalSender({ kind: ref => PLACES[ref], run: async argv => (ran.push(argv), { code: 1, out: line({ sent: "maybe", code: "net_cut" }) }), report: () => undefined, log: () => undefined, store: m.store, now: c.now, after: c.after, prove: async j => (asked.push(j.ref), proof) });
	s.enqueue(job("RAAAAAA"));
	await s.idle();
	s.recheck();
	await s.idle();
	expect(asked).toEqual(["RAAAAAA"]);
	expect(left(m)).toEqual(["RAAAAAA:unsure"]);
	proof = "sent";
	c.move(9 * 60_000);
	s.recheck();
	expect(asked).toHaveLength(1);
	c.move(60_000);
	s.recheck();
	await Promise.resolve();
	await s.idle();
	expect(asked).toHaveLength(2);
	expect(left(m)).toEqual([]);
	expect(ran).toHaveLength(1);
});
