import { expect, test } from "bun:test";
import { createApprovalSender, sendArgv, type SendJob, type SendLook, type SendResult } from "./approval-send.ts";

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
	expect(left(m)).toEqual([]);
});

test("a send that was running when the gateway stopped is never run again: it ends failed with a text that says it may have gone out", async () => {
	const m = memoryStore();
	boot(m, { run: never }).s.enqueue(job("RAAAAAA"));
	const text = "메일이 이미 나갔을 수 있어요. 확인하고 다시 보내기를 눌러 주세요";
	const second = boot(m, { look: () => ({ state: "failed", text }) });
	second.s.recover();
	await second.s.idle();
	expect(second.ran).toEqual([]);
	expect(second.reports.at(-1)).toMatchObject({ ref: "RAAAAAA", state: "failed", text });
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

test("a send the CLI's gate refuses ends failed with its reason and leaves nothing behind", async () => {
	const m = memoryStore();
	const t = boot(m, { run: async () => ({ code: 1, out: "초안 RAAAAAA은(는) 이미 sent 상태라 보내지 않았어요" }) });
	t.s.enqueue(job("RAAAAAA"));
	await t.s.idle();
	expect(t.reports.at(-1)).toMatchObject({ state: "failed", text: "초안 RAAAAAA은(는) 이미 sent 상태라 보내지 않았어요" });
	expect(left(m)).toEqual([]);
});

test("the owner's retry of a mail send reaches the CLI as --retry, a first send does not", () => {
	const first = sendArgv("mail", "RAAAAAA", "send", "bun");
	const retry = sendArgv("mail", "RAAAAAA", "send", "bun", true);
	expect(first).not.toContain("--retry");
	expect(retry!.slice(-2)).toEqual(["RAAAAAA", "--retry"]);
	expect(sendArgv("comment", "D1", "send", "bun", true)).not.toContain("--retry");
});
