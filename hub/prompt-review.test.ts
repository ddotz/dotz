import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewPrompt, CONTRACT_MAX_CHARS, MAX_OUTPUT_TOKENS, modelRefused, parseReview, promptReviewCheck, readReviewState, reviewDeps, reviewDue, reviewFile, runPromptReview, type ReviewCall, type ReviewContext } from "./prompt-review.ts";

const root = mkdtempSync(join(tmpdir(), "prompt-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15);
const LINE_A = "Always answer within one minute of the question.";
const LINE_B = "Never answer before three minutes have passed.";
let dir = "";
let n = 0;

beforeEach(() => {
	dir = join(root, `d${n++}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "RULES.md"), `${LINE_A}\n${LINE_B}\n`);
});

const reviewedAt = (at: number) => writeFileSync(reviewFile(dir), JSON.stringify({ lastReviewAt: at, lastTokens: { input: 1, output: 1 } }));
const grown = () => writeFileSync(join(dir, "prompt-health.json"), JSON.stringify({ baseline: { total: { chars: 1000, at: NOW - 30 * DAY } }, last: { total: 50_000 } }));

const answer = (text: string, usage = { input: 1234, output: 567 }) => {
	const prompts: string[] = [];
	const call: ReviewCall = async prompt => {
		prompts.push(prompt);
		return { text, usage };
	};
	return { call, prompts };
};
const ctx = (call: ReviewCall, over: Partial<ReviewContext> = {}): ReviewContext => ({ now: NOW, dataDir: dir, call, budgetTight: false, model: undefined, log: () => {}, ...over });
const GOOD = JSON.stringify([{ kind: "conflict", lines: [LINE_A, LINE_B], why: "they cannot both hold", proposal: "keep the first" }]);

describe("reviewDue", () => {
	test("first run is due", () => expect(reviewDue(undefined, NOW, false)).toBe(true));
	test("weekly", () => {
		expect(reviewDue({ lastReviewAt: NOW - 6 * DAY }, NOW, false)).toBe(false);
		expect(reviewDue({ lastReviewAt: NOW - 7 * DAY }, NOW, false)).toBe(true);
	});
	test("growth is early but not within 3 days", () => {
		expect(reviewDue({ lastReviewAt: NOW - 2 * DAY }, NOW, true)).toBe(false);
		expect(reviewDue({ lastReviewAt: NOW - 3 * DAY }, NOW, true)).toBe(true);
	});
});

describe("runPromptReview", () => {
	test("not due: no call", async () => {
		reviewedAt(NOW - DAY);
		const { call, prompts } = answer(GOOD);
		const r = await runPromptReview(ctx(call));
		expect(prompts).toHaveLength(0);
		expect(r.skipped).toBe("not-due");
		expect(r.findings).toEqual([]);
	});

	test("weekly due: exactly one call, and the state records it", async () => {
		reviewedAt(NOW - 8 * DAY);
		const { call, prompts } = answer("[]");
		const r = await runPromptReview(ctx(call));
		expect(prompts).toHaveLength(1);
		expect(r.skipped).toBeUndefined();
		expect(readReviewState(dir)).toEqual({ lastReviewAt: NOW, lastTokens: { input: 1234, output: 567 } });
	});

	test("first ever run calls the model", async () => {
		const { call, prompts } = answer("[]");
		await runPromptReview(ctx(call));
		expect(prompts).toHaveLength(1);
	});

	test("growth starts it early, but not within 3 days", async () => {
		grown();
		reviewedAt(NOW - 4 * DAY);
		const early = answer("[]");
		await runPromptReview(ctx(early.call));
		expect(early.prompts).toHaveLength(1);

		reviewedAt(NOW - 2 * DAY);
		const tooSoon = answer("[]");
		expect((await runPromptReview(ctx(tooSoon.call))).skipped).toBe("not-due");
		expect(tooSoon.prompts).toHaveLength(0);
	});

	test("without growth 4 days is not enough", async () => {
		reviewedAt(NOW - 4 * DAY);
		const { call, prompts } = answer("[]");
		await runPromptReview(ctx(call));
		expect(prompts).toHaveLength(0);
	});

	test("budget tight: no call, skipped budget", async () => {
		for (const budgetTight of [true, async () => true]) {
			const { call, prompts } = answer(GOOD);
			const r = await runPromptReview(ctx(call, { budgetTight }));
			expect(prompts).toHaveLength(0);
			expect(r.skipped).toBe("budget");
			expect(r.findings).toEqual([]);
		}
	});

	test("Fable or max/xhigh effort: no call, skipped model", async () => {
		for (const model of ["anthropic/claude-fable-5", "anthropic/claude-sonnet-5-5:xhigh", "some/model:max"]) {
			const { call, prompts } = answer(GOOD);
			const r = await runPromptReview(ctx(call, { model }));
			expect(prompts).toHaveLength(0);
			expect(r.skipped).toBe("model");
		}
		expect(modelRefused("anthropic/claude-sonnet-5-5:high")).toBe(false);
		expect(modelRefused(undefined)).toBe(false);
	});

	test("the budget reader is not asked when the model is refused", async () => {
		let asked = 0;
		const r = await runPromptReview(ctx(answer(GOOD).call, { model: "x/fable", budgetTight: () => (asked++, false) }));
		expect(r.skipped).toBe("model");
		expect(asked).toBe(0);
	});

	test("bad reply: no findings, no throw", async () => {
		for (const text of ["I think everything is fine.", "[{broken", '{"kind":"conflict"}', '[{"kind":"nonsense","lines":["x"],"why":"w","proposal":"p"}]']) {
			rmSync(reviewFile(dir), { force: true });
			const lines: string[] = [];
			const r = await runPromptReview(ctx(answer(text).call, { log: l => lines.push(l) }));
			expect(r.findings).toEqual([]);
			expect(r.tokens).toEqual({ input: 1234, output: 567 });
		}
	});

	test("a failing call gives no findings, no throw, and the review stays due", async () => {
		const call: ReviewCall = async () => {
			throw new Error("down");
		};
		const r = await runPromptReview(ctx(call));
		expect(r.findings).toEqual([]);
		expect(readReviewState(dir)).toBeUndefined();
	});

	test("good reply: findings with a two-way decision and the token cost", async () => {
		const { call, prompts } = answer(GOOD);
		const r = await runPromptReview(ctx(call));
		expect(r.tokens).toEqual({ input: 1234, output: 567 });
		expect(r.findings).toHaveLength(1);
		const f = r.findings[0]!;
		expect(f.area).toBe("prompt");
		expect(f.key).toMatch(/^prompt:review:[0-9a-f]{10}$/);
		expect(f.decide?.options).toHaveLength(2);
		expect(f.evidence).toContain("1234");
		expect(f.evidence).toContain("567");
		expect(prompts[0]).toContain(LINE_A);
	});

	test("the key follows the quoted lines, not the wording of the rest", async () => {
		const other = JSON.stringify([{ kind: "outdated", lines: [LINE_A, LINE_B], why: "different", proposal: "other" }]);
		const a = await runPromptReview(ctx(answer(GOOD).call));
		rmSync(reviewFile(dir), { force: true });
		const b = await runPromptReview(ctx(answer(other).call));
		expect(b.findings[0]?.key).toBe(a.findings[0]?.key);
	});

	test("a quote found nowhere in the text is dropped", async () => {
		const made = JSON.stringify([{ kind: "conflict", lines: ["a line nobody wrote"], why: "w", proposal: "p" }]);
		expect((await runPromptReview(ctx(answer(made).call))).findings).toEqual([]);
	});

	test("nothing in the data dir is edited except the review state", async () => {
		await runPromptReview(ctx(answer(GOOD).call));
		expect(readFileSync(join(dir, "RULES.md"), "utf8")).toBe(`${LINE_A}\n${LINE_B}\n`);
	});
});

describe("prompt and parsing", () => {
	test("the contract part is capped and the output cap is passed to the call", async () => {
		writeFileSync(join(dir, "RULES.md"), "x".repeat(12_000));
		expect(buildReviewPrompt("y".repeat(CONTRACT_MAX_CHARS + 5000)).length).toBeLessThan(CONTRACT_MAX_CHARS + 4000);
		const seen: number[] = [];
		await runPromptReview(ctx(async (_p, o) => (seen.push(o.maxOutputTokens), { text: "[]", usage: { input: 1, output: 1 } })));
		expect(seen).toEqual([MAX_OUTPUT_TOKENS]);
	});

	test("a reply wrapped in a code fence is read", () => {
		expect(parseReview(`\`\`\`json\n${GOOD}\n\`\`\``)).toHaveLength(1);
	});
});

describe("promptReviewCheck", () => {
	const saved = { ...reviewDeps };
	afterEach(() => Object.assign(reviewDeps, saved));

	test("uses the gateway helpers it is given", async () => {
		const { call, prompts } = answer(GOOD);
		Object.assign(reviewDeps, { call, model: async () => undefined, budgetTight: async () => false });
		const findings = await promptReviewCheck({ now: NOW, dataDir: dir, home: root });
		expect(prompts).toHaveLength(1);
		expect(findings).toHaveLength(1);
	});

	test("a tight budget from the reader means no call", async () => {
		const { call, prompts } = answer(GOOD);
		Object.assign(reviewDeps, { call, model: async () => undefined, budgetTight: async () => true });
		expect(await promptReviewCheck({ now: NOW, dataDir: dir, home: root })).toEqual([]);
		expect(prompts).toHaveLength(0);
	});
});
