import { describe, expect, test } from "bun:test";
import { emit } from "./events.ts";
import { mailByKey, mailCard, postMail, recordMail, setMailSummary, type MailDeps } from "./mail.ts";
import { createMailSummarizer, isFailedSummary, tidySummary } from "./mail-summary.ts";

const PLACEHOLDER = "(요약 실패 — 스레드에서 원문 확인)";
const GOOD = "**요약**\n• 견적서를 보냈어요\n\n**할 일**\n• 금요일까지 회신";
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

	test("the placeholder test is conservative and a long reply is cut to 500 characters", () => {
		expect(isFailedSummary(PLACEHOLDER)).toBe(true);
		expect(isFailedSummary("**요약**\n• 지난번 요약 실패 건은 해결됐어요 " + "가".repeat(200))).toBe(false);
		expect(isFailedSummary(GOOD)).toBe(false);
		const long = `**요약**\n${Array.from({ length: 60 }, (_, i) => `• 항목 ${i}`).join("\n")}`;
		expect(tidySummary(long).length).toBeLessThanOrEqual(500);
		expect(tidySummary("• 한 줄")).toBe("**요약**\n• 한 줄");
		expect(tidySummary(PLACEHOLDER)).toBe("");
	});
});
