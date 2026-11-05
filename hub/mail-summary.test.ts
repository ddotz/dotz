import { describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { mailByKey, mailCard, postMail, recordMail, setMailSummary, type MailDeps } from "./mail.ts";
import { createMailSummarizer, isFailedSummary, tidySummary } from "./mail-summary.ts";

const PLACEHOLDER = "(요약 실패 — 스레드에서 원문 확인)";
const GOOD = "견적서를 보냈다는 메일이에요.\n**금요일까지 견적 검토 후 회신**해 주세요.";
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;

function setup(model: (system: string, text: string) => Promise<string>, bodies: Record<string, string> = {}) {
	const timers: Array<() => void> = [];
	const changed: string[] = [];
	const calls: Array<{ system: string; text: string }> = [];
	const summarizer = createMailSummarizer({
		model: async (system, text) => (calls.push({ system, text }), model(system, text)),
		get: mailByKey,
		store: setMailSummary,
		changed: key => void changed.push(key),
		bodyOf: r => bodies[r.key],
		later: fn => void timers.push(fn),
	});
	const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as Parameters<typeof emit>[1]), wake: () => undefined, summarize: (key, hint) => summarizer.request(key, hint) };
	return { summarizer, deps, timers, changed, calls };
}
const post = (deps: MailDeps, extra: Record<string, unknown>) => postMail({ source: "fx", id: uid("sum"), subject: "견적서 송부", from: "Kim <kim@example.com>", body: "견적서를 첨부합니다. 금요일까지 회신 부탁드려요.", ...extra }, deps);

describe("hub-made mail summaries", () => {
	test("a failure placeholder from the poster is replaced by the hub's summary, and is never shown in between", async () => {
		const t = setup(async () => GOOD);
		const r = await post(t.deps, { summary: PLACEHOLDER, attachments: [{ name: "견적.pdf", data: Buffer.from("pdf").toString("base64") }] });
		expect(mailByKey(r.key)!.summary ?? "").not.toContain("요약 실패");
		expect(mailCard(mailByKey(r.key)!).summary).toBeUndefined();
		await t.summarizer.drain();
		expect(mailCard(mailByKey(r.key)!).summary).toBe(GOOD);
		expect(t.changed).toEqual([r.key]);
		expect(t.calls).toHaveLength(1);
		expect(t.calls[0]!.text).toContain("견적서를 첨부합니다");
		expect(t.calls[0]!.text).toContain("견적.pdf");
	});

	test("a mail with no summary is summarized", async () => {
		const t = setup(async () => GOOD);
		const r = await post(t.deps, {});
		await t.summarizer.drain();
		expect(mailByKey(r.key)!.summary).toBe(GOOD);
		expect(mailByKey(r.key)!.preview).toBeUndefined();
	});

	test("a failing model leaves no placeholder as the summary and is retried later", async () => {
		let down = true;
		const t = setup(async () => {
			if (down) throw new Error("login expired");
			return GOOD;
		});
		const r = await post(t.deps, { summary: PLACEHOLDER });
		await t.summarizer.drain();
		expect(t.calls).toHaveLength(1);
		expect(mailCard(mailByKey(r.key)!).summary).toBeUndefined();
		expect(t.timers).toHaveLength(1);
		expect(t.changed).toEqual([]);
		down = false;
		t.timers.shift()!();
		await t.summarizer.drain();
		expect(t.calls).toHaveLength(2);
		expect(mailCard(mailByKey(r.key)!).summary).toBe(GOOD);
		expect(t.changed).toEqual([r.key]);
	});

	test("a usage limit with a known reset waits for the reset: no retry is spent, no other mail calls the model, the mail stays queued", async () => {
		const RESET = 10_000_000;
		let now = RESET - 3_600_000;
		let limited = true;
		const waits: number[] = [];
		const timers: Array<() => void> = [];
		const calls: string[] = [];
		const summarizer = createMailSummarizer({
			model: async (_s, text) => {
				calls.push(text);
				if (limited) throw Object.assign(new Error("구독 한도에 걸렸어요"), { resetAt: RESET });
				return GOOD;
			},
			get: mailByKey,
			store: setMailSummary,
			changed: () => undefined,
			bodyOf: r => (r.subject.includes("A") ? "본문 A" : "본문 B"),
			later: (fn, ms) => (timers.push(fn), void waits.push(ms)),
			now: () => now,
			retryMs: [1],
		});
		const deps = { ...setup(async () => GOOD).deps, summarize: (key: string, hint?: { body?: string }) => summarizer.request(key, hint) };
		const a = await post(deps, { subject: "견적 A" });
		const b = await post(deps, { subject: "견적 B" });
		await summarizer.drain();
		// one probe call found the limit; the second mail did not call at all, and one timer waits for the reset
		expect(calls).toHaveLength(1);
		expect(waits).toHaveLength(2);
		expect(waits.every(ms => ms >= 3_600_000 && ms <= 3_600_000 + 120_000)).toBe(true);
		// the wait is not a retry: after several limited rounds the mails are still queued, not given up
		for (let round = 0; round < 3; round++) {
			now = RESET - 1;
			timers.splice(0).forEach(fn => fn());
			await summarizer.drain();
		}
		expect(mailByKey(a.key)!.summary ?? "").toBe("");
		expect(mailByKey(b.key)!.summary ?? "").toBe("");
		limited = false;
		now = RESET + 120_000;
		timers.splice(0).forEach(fn => fn());
		await summarizer.drain();
		expect(mailByKey(a.key)!.summary).toBe(GOOD);
		expect(mailByKey(b.key)!.summary).toBe(GOOD);
	});

	test("a good summary and an outgoing mail make no model call", async () => {
		const t = setup(async () => GOOD);
		const a = await post(t.deps, { summary: GOOD });
		const b = await post(t.deps, { direction: "out", from: "Me <me@example.com>", to: "kim@example.com" });
		await t.summarizer.drain();
		expect(t.calls).toHaveLength(0);
		expect(mailByKey(a.key)!.summary).toBe(GOOD);
		expect(mailCard(mailByKey(b.key)!)).toMatchObject({ dir: "out", preview: "견적서를 첨부합니다. 금요일까지 회신 부탁드려요." });
	});

	test("the start-up backfill takes the newest 30 placeholder or empty records that have a body, and skips the rest", async () => {
		const bodies: Record<string, string> = {};
		const keys: string[] = [];
		for (let i = 0; i < 32; i++) {
			const key = `fx-${uid("bf")}`;
			keys.push(key);
			bodies[key] = `본문 ${i}`;
			recordMail({ key, source: "fx", id: key, subject: `메일 ${i}`, from: "kim@example.com", at: new Date(Date.UTC(2031, 0, 1, 0, i)).toISOString(), summary: PLACEHOLDER });
		}
		const noBody = `fx-${uid("nb")}`;
		recordMail({ key: noBody, source: "fx", id: noBody, subject: "본문 없음", from: "kim@example.com", at: "2032-01-01T00:00:00.000Z", summary: PLACEHOLDER });
		const t = setup(async () => GOOD, bodies);
		expect(t.summarizer.backfill([...keys, noBody].map(k => mailByKey(k)!), 30)).toBe(30);
		await t.summarizer.drain();
		expect(t.calls).toHaveLength(30);
		expect(mailByKey(keys[31]!)!.summary).toBe(GOOD);
		expect(mailByKey(keys[2]!)!.summary).toBe(GOOD);
		expect(mailByKey(keys[1]!)!.summary).toBe(PLACEHOLDER);
		expect(mailByKey(noBody)!.summary).toBe(PLACEHOLDER);
	});

	test("the placeholder test is conservative, the reply is kept to two lines and a long one is cut to 500 characters with the bold marks paired", () => {
		expect(isFailedSummary(PLACEHOLDER)).toBe(true);
		expect(isFailedSummary("**요약**\n• 지난번 요약 실패 건은 해결됐어요 " + "가".repeat(200))).toBe(false);
		expect(isFailedSummary(GOOD)).toBe(false);
		const long = tidySummary(`${"가".repeat(300)}\n**${"나".repeat(300)}**`);
		expect(long.length).toBeLessThanOrEqual(500);
		expect((long.match(/\*\*/g) ?? []).length % 2).toBe(0);
		expect(tidySummary(GOOD)).toBe(GOOD);
		expect(tidySummary("**요약**\n• 첫째예요\n• 둘째예요\n• 셋째예요")).toBe("첫째예요\n둘째예요");
		expect(tidySummary("• 한 줄")).toBe("한 줄");
		expect(tidySummary(PLACEHOLDER)).toBe("");
	});
});
