import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "./doctor.ts";
import { CATALOGS, LOCKED_TEXTS, msg } from "./i18n.ts";
import { CONTRACT_SHAPE, promptHealth } from "./prompt-health.ts";
import { buildReviewPrompt, CONTRACT_MAX_CHARS, MAX_OUTPUT_TOKENS, modelRefused, parseReview, promptReviewCheck, readReviewState, reviewDeps, reviewFile, runPromptReview, type ReviewCall, type ReviewContext } from "./prompt-review.ts";
import { applyTexts, textsPath } from "./texts.ts";

const root = mkdtempSync(join(tmpdir(), "prompt-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const gitRepo = (at: string, add: string[]) => {
	for (const args of [["init", "-q"], ["add", ...add], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "snapshot"]]) expect(Bun.spawnSync(["git", "-C", at, ...args]).exitCode).toBe(0);
};
const NOW = Date.UTC(2026, 5, 15);
const LINE_A = "Always answer within one minute of the question.";
const LINE_B = "Never answer before three minutes have passed.";
const LINE_A2 = "Always answer within two minutes of the question.";
let dir = "";
let n = 0;

beforeEach(() => {
	dir = join(root, `d${n++}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "RULES.md"), `${LINE_A}\n${LINE_B}\n`);
});

const reviewedAt = (at: number) => writeFileSync(reviewFile(dir), JSON.stringify({ lastReviewAt: at, lastTokens: { input: 1, output: 1 } }));
const grown = () => writeFileSync(join(dir, "prompt-health.json"), JSON.stringify({ baseline: { total: { chars: 1000, at: NOW - 30 * DAY } }, last: { total: 50_000 }, shape: CONTRACT_SHAPE }));

const answer = (text: string, usage = { input: 1234, output: 567 }) => {
	const prompts: string[] = [];
	const call: ReviewCall = async prompt => {
		prompts.push(prompt);
		return { text, usage };
	};
	return { call, prompts };
};
const ctx = (call: ReviewCall, over: Partial<ReviewContext> = {}): ReviewContext => ({ now: NOW, dataDir: dir, call, budgetTight: false, model: undefined, log: () => {}, ...over });
const GOOD = JSON.stringify([{ kind: "conflict", line: LINE_A, to: LINE_A2, other: LINE_B, why: "they cannot both hold" }]);
const both = (line: string, extra: Record<string, unknown> = {}) => ({ kind: "outdated", lines: [line], proposal: "p", line, to: `${line} (new)`, why: "w", ...extra });

describe("runPromptReview", () => {
	test("not due: no call", async () => {
		reviewedAt(NOW - 6 * DAY);
		const { call, prompts } = answer(GOOD);
		const r = await runPromptReview(ctx(call));
		expect(prompts).toHaveLength(0);
		expect(r.skipped).toBe("not-due");
		expect(r.findings).toEqual([]);
	});

	test("weekly due: exactly one call, and the state records it", async () => {
		reviewedAt(NOW - 7 * DAY);
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
		reviewedAt(NOW - 3 * DAY);
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

	test("good reply: the finding carries the exact edit the gateway found, and the card shows file and line, before, after and the other line", async () => {
		const { call, prompts } = answer(GOOD);
		const r = await runPromptReview(ctx(call));
		const m = msg();
		expect(r.tokens).toEqual({ input: 1234, output: 567 });
		expect(r.findings).toHaveLength(1);
		const f = r.findings[0]!;
		expect(f.area).toBe("prompt");
		expect(f.key).toMatch(/^prompt:review:[0-9a-f]{10}$/);
		expect(f.change).toEqual({ file: join(dir, "RULES.md"), line: 1, from: LINE_A, to: LINE_A2 });
		expect(f.evidence).toEqual([`${m.doctor.reviewKind.conflict} · ${m.promptAt("RULES.md", 1)}`, m.promptBefore(LINE_A), m.promptAfter(LINE_A2), m.promptOther(m.promptAt("RULES.md", 2), LINE_B)]);
		expect(f.decide?.options.map(o => o.name)).toEqual([m.promptReviewApply, m.promptReviewLeave]);
		expect(f.decide?.options[0]!.result).toBe(m.promptReviewApplyResult("RULES.md"));
		expect(prompts[0]).toContain(LINE_A);
	});

	test("a deletion is one line on the card, the line to delete; the freed line carries the reason, after the other line of a conflict too", async () => {
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "outdated", line: `- ${LINE_B}`, to: "", why: "W-REASON" }])).call));
		const m = msg(), f = r.findings[0]!;
		expect(f.change).toEqual({ file: join(dir, "RULES.md"), line: 2, from: LINE_B, to: "" });
		expect(f.evidence.slice(1)).toEqual([m.promptDelete(LINE_B), m.promptWhy("W-REASON")]);
		rmSync(reviewFile(dir), { force: true });
		const c = (await runPromptReview(ctx(answer(JSON.stringify([{ kind: "conflict", line: LINE_A, to: "", other: LINE_B, why: "W-REASON" }])).call))).findings[0]!;
		expect(c.evidence).toEqual([`${m.doctor.reviewKind.conflict} · ${m.promptAt("RULES.md", 1)}`, m.promptDelete(LINE_A), m.promptOther(m.promptAt("RULES.md", 2), LINE_B), m.promptWhy("W-REASON")]);
	});

	test("a review card that deletes a line asks to delete it: the delete question and options, the review's own leave option", async () => {
		const f = (await runPromptReview(ctx(answer(JSON.stringify([{ kind: "outdated", line: LINE_B, to: "", other: "", why: "w" }])).call))).findings[0]!, m = msg();
		expect(f.decide?.question).toBe(m.doctor.ruleQuestion);
		expect(f.decide?.options).toEqual([{ name: m.promptRemove, result: m.promptReviewRemoveResult("RULES.md") }, { name: m.promptReviewLeave, result: m.promptReviewLeaveResult(7), keep: true }]);
		expect(m.promptReviewRemoveResult("RULES.md")).not.toBe(m.promptRemoveResult("RULES.md"));
	});

	test("a long line changed near its end: before and after open with … at the same word shortly before the change, change keeps both lines whole; a reason with no room stays in the finding's text", async () => {
		const long = `- ${"every rule line here is long enough ".repeat(6)}END-OF-LINE`;
		writeFileSync(join(dir, "RULES.md"), `${long}\n${LINE_B}\n`);
		const why = `${"the first rule asks for an answer at once while the second one asks to wait, ".repeat(2)}LAST-WORDS`;
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "conflict", line: long, to: `${long} too`, other: LINE_B, why }])).call));
		const f = r.findings[0]!, m = msg();
		expect(f.change).toMatchObject({ from: long, to: `${long} too` });
		expect(f.evidence).toHaveLength(4);
		expect(f.evidence.every(l => [...l].length <= 120)).toBe(true);
		const before = f.evidence[1]!.slice(m.promptBefore("").length), after = f.evidence[2]!.slice(m.promptAfter("").length);
		expect(before.startsWith("…") && after.startsWith("…")).toBe(true);
		expect(long.endsWith(before.slice(1)) && long[long.length - before.length] === " ").toBe(true);
		expect(after).toBe(`${before} too`);
		expect(f.evidence.join(" ")).not.toContain("LAST-WORDS");
		expect(f.what).toContain("LAST-WORDS");
	});

	test("an item whose line is in two files, twice in one file, or nowhere gives no card, one log line each says why, and the morning gets one told line with the count", async () => {
		const dup = "Reply in the owner's language.", twice = "Keep every answer short.";
		writeFileSync(join(dir, "RULES.md"), `- ${dup}\n${twice}\n${twice}\n`);
		writeFileSync(join(dir, "LESSONS.md"), `${dup}\n`);
		const lines: string[] = [];
		const r = await runPromptReview(ctx(answer(JSON.stringify([both(dup), both(twice), both("a line nobody wrote")])).call, { log: l => lines.push(l) }));
		expect(r.findings).toEqual([{ key: "prompt:unplaced", area: "prompt", what: msg().promptReviewUnplaced(3), evidence: [], since: NOW, level: 3 }]);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("RULES.md and LESSONS.md");
		expect(lines[1]).toContain("RULES.md more than once");
		expect(lines[2]).toContain("no re-read file");
		const told = compose({ version: 1, lastRun: NOW, memo: {}, told: {}, findings: Object.fromEntries(r.findings.map(f => [f.key, f])) }, NOW)!;
		expect(told.decisions).toBe(0);
		expect(told.text.split("\n").filter(l => l.includes(msg().promptReviewUnplaced(3)))).toHaveLength(1);
		expect((await runPromptReview(ctx(answer(JSON.stringify([both(dup)])).call, { now: NOW + DAY }))).findings).toEqual([]);
	});

	test("a quote that is only part of a line gives no card: an edit replaces a whole line", async () => {
		writeFileSync(join(dir, "RULES.md"), `- [11-02] Tests run headless. The owner's window stays in the back.\n${LINE_B}\n`);
		expect((await runPromptReview(ctx(answer(JSON.stringify([both("Tests run headless.")])).call))).findings.map(f => f.key)).toEqual(["prompt:unplaced"]);
	});

	test("an item without an exact edit is dropped: no `to`, or a `to` that is the line itself", async () => {
		const r = await runPromptReview(ctx(answer(JSON.stringify([both(LINE_A, { to: undefined }), both(LINE_B, { to: LINE_B })])).call));
		expect(r.findings).toEqual([]);
	});

	test("an edit that changes nothing is dropped with a log line: a quote without its list mark whose `to` is the file line itself", async () => {
		writeFileSync(join(dir, "RULES.md"), `- Keep every answer short.\n${LINE_B}\n`);
		const lines: string[] = [];
		const r = await runPromptReview(ctx(answer(JSON.stringify([both("Keep every answer short.", { to: "- Keep every answer short." })])).call, { log: l => lines.push(l) }));
		expect(r.findings).toEqual([]);
		expect(lines).toEqual(['prompt review: dropped the item on "Keep every answer short.": its new text is the line itself']);
	});

	test("a line the enforced-rule check proposes in the same run gets one card, the enforced one", async () => {
		const gate = "- never run launchctl kickstart on the gateway";
		writeFileSync(join(dir, "RULES.md"), `${LINE_A}\n${gate}\n`);
		const lines: string[] = [];
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "contradicts-code", line: gate, to: "", other: "", why: "w" }, { kind: "outdated", line: LINE_A, to: LINE_A2, other: "", why: "w" }])).call, { log: l => lines.push(l) }));
		const health = promptHealth({ now: NOW, dataDir: dir, home: root });
		const cards = [...r.findings, ...(await health)].filter(f => f.change?.line === 2);
		expect(cards.map(f => f.key)).toEqual(["prompt:enforced:gateway-restart"]);
		expect(r.findings.map(f => f.change?.line)).toEqual([1]);
		expect(lines).toEqual([`prompt review: dropped the item on "${gate}": the enforced-rule check proposes that line; its reason: w`]);
	});

	test("a review item on line N of one file is not dropped because the enforced-rule check proposes line N of another file", async () => {
		writeFileSync(join(dir, "RULES.md"), `${LINE_A}\n- never run launchctl kickstart on the gateway\n`);
		writeFileSync(join(dir, "LESSONS.md"), `- lesson one\n${LINE_B}\n`);
		const r = await runPromptReview(ctx(answer(JSON.stringify([both(LINE_B)])).call));
		expect(r.findings.map(f => f.change)).toEqual([{ file: join(dir, "LESSONS.md"), line: 2, from: LINE_B, to: `${LINE_B} (new)` }]);
	});

	test("`to` keeps the indentation of the nested line it replaces and loses the spaces around the model's text", async () => {
		writeFileSync(join(dir, "RULES.md"), "- Parent rule.\n    - Nested child rule.\n");
		const r = await runPromptReview(ctx(answer(JSON.stringify([both("- Nested child rule.", { to: "  - Nested child rule, reworded.  " })])).call));
		expect(r.findings[0]!.change).toEqual({ file: join(dir, "RULES.md"), line: 2, from: "    - Nested child rule.", to: "    - Nested child rule, reworded." });
	});

	test("a feature line holding {repo} is found as the re-read text shows it, and `to` keeps {repo} as written", async () => {
		const pkg = join(import.meta.dir, ".."), raw = "Run `{repo}/bin/tool` before replying.";
		mkdirSync(join(dir, "features", "f"), { recursive: true });
		writeFileSync(join(dir, "features", "f", "feature.md"), `---\nname: f\nwhat: sample\ntrigger: 메시지 도착\nstage: s\n---\n${raw}\n`);
		const seen = raw.replace("{repo}", pkg), to = seen.replace("tool`", "tool --fast`");
		const r = await runPromptReview(ctx(answer(JSON.stringify([both(seen, { to })])).call));
		expect(r.findings[0]!.change).toEqual({ file: join(dir, "features", "f", "feature.md"), line: 7, from: raw, to: "Run `{repo}/bin/tool --fast` before replying." });
	});

	test("{repo} is written back only for the package path as a path of its own, and never into a line that has none", async () => {
		const pkg = join(import.meta.dir, ".."), raw = "Run `{repo}/bin/tool` before replying.";
		mkdirSync(join(dir, "features", "f"), { recursive: true });
		writeFileSync(join(dir, "features", "f", "feature.md"), `---\nname: f\nwhat: sample\ntrigger: 메시지 도착\nstage: s\n---\n${raw}\n`);
		const seen = raw.replace("{repo}", pkg), to = `Run \`${pkg}/bin/tool\` in ${pkg} before replying; notes are in ${pkg}-notes/tool.md.`;
		const r = await runPromptReview(ctx(answer(JSON.stringify([both(seen, { to }), both(LINE_A, { to: `${LINE_A} Use ${pkg}/bin/tool.` })])).call));
		expect(r.findings.map(f => f.change?.to)).toEqual([`Run \`{repo}/bin/tool\` in {repo} before replying; notes are in ${pkg}-notes/tool.md.`, `${LINE_A} Use ${pkg}/bin/tool.`]);
	});

	test("an item that changes nothing takes none of the 3 places and is not counted as unplaced", async () => {
		const rules = ["- Rule one.", "- Rule two.", "- Rule three.", "- Rule four."];
		writeFileSync(join(dir, "RULES.md"), `${rules.join("\n")}\n`);
		const r = await runPromptReview(ctx(answer(JSON.stringify([both(rules[0]!, { to: rules[0] }), ...rules.slice(1).map(l => both(l))])).call));
		expect(r.findings.map(f => f.change?.line)).toEqual([2, 3, 4]);
		rmSync(reviewFile(dir), { force: true });
		expect((await runPromptReview(ctx(answer(JSON.stringify([both("- Not in any file.", { to: "- Not in any file." })])).call))).findings).toEqual([]);
	});

	test("a reply with more items than asked gives at most 3 cards", async () => {
		const rules = ["One.", "Two.", "Three.", "Four.", "Five."].map(w => `Rule number ${w}`);
		writeFileSync(join(dir, "RULES.md"), `${rules.join("\n")}\n`);
		expect((await runPromptReview(ctx(answer(JSON.stringify(rules.map(l => both(l)))).call))).findings).toHaveLength(3);
	});

	test("a reply cut by the output cap keeps its complete items, also when the cut string holds ] or }", async () => {
		const items = [{ kind: "conflict", line: LINE_A, to: LINE_A2, other: LINE_B, why: "first" }, { kind: "outdated", line: LINE_B, to: "", other: "", why: "second [11-10] {x}" }];
		const whole = JSON.stringify(items);
		const lines: string[] = [];
		const r = await runPromptReview(ctx(answer(whole.slice(0, whole.indexOf("second") + 10)).call, { log: l => lines.push(l) }));
		expect(r.findings.map(f => f.change?.line)).toEqual([1]);
		expect(lines).toEqual([]);
		expect(parseReview(whole.slice(0, whole.indexOf("{x}") + 2))).toHaveLength(1);
		const nested = JSON.stringify([items[0], { extra: { a: 1 }, ...items[1] }]);
		expect(parseReview(nested.slice(0, nested.indexOf("second")))).toHaveLength(1);
		expect(parseReview(whole.slice(0, whole.indexOf("[11-10]") + 7))).toHaveLength(1);
		expect(parseReview(whole.slice(0, whole.indexOf("first")))).toBeUndefined();
	});

	test("the other line is shown only when found: a made-up one leaves the reason in its place and is logged", async () => {
		const lines: string[] = [];
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "conflict", line: LINE_A, to: LINE_A2, other: "a line nobody wrote", why: "W-REASON" }])).call, { log: l => lines.push(l) }));
		expect(r.findings[0]!.evidence.at(-1)).toBe(msg().promptWhy("W-REASON"));
		expect(lines.join("\n")).toContain("not shown: it is in no re-read file");
	});

	test("an other line that is the edited line itself is not shown as a conflicting line: the reason takes its place", async () => {
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "conflict", line: LINE_A, to: LINE_A2, other: `- ${LINE_A}`, why: "W-REASON" }])).call));
		expect(r.findings[0]!.evidence.at(-1)).toBe(msg().promptWhy("W-REASON"));
	});

	test("a rule line that conflicts with the identity text names the identity file and its line", async () => {
		mkdirSync(join(dir, "identity"), { recursive: true });
		writeFileSync(join(dir, "identity", "IDENTITY.md"), "# Identity\nStart every answer with the owner's name.\n");
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "conflict", line: LINE_A, to: LINE_A2, other: "Start every answer with the owner's name.", why: "w" }])).call));
		const m = msg();
		expect(r.findings[0]!.evidence.at(-1)).toBe(m.promptOther(m.promptAt(join("identity", "IDENTITY.md"), 2), "Start every answer with the owner's name."));
	});

	test("the apply option says the edit can be undone from git only when git tracks the file itself, also in a folder below the repo's root", async () => {
		const m = msg(), without = (await runPromptReview(ctx(answer(GOOD).call))).findings[0]!;
		expect(without.decide!.options[0]!.result).not.toContain(m.promptUndo);
		const feature = join(dir, "features", "f", "feature.md");
		mkdirSync(join(dir, "features", "f"), { recursive: true });
		writeFileSync(feature, `---\nname: f\nwhat: sample\ntrigger: 메시지 도착\nstage: s\n---\n${LINE_B}\n`);
		writeFileSync(join(dir, "RULES.md"), `${LINE_A}\n`);
		gitRepo(dir, ["RULES.md", "features"]);
		rmSync(reviewFile(dir), { force: true });
		const inGit = (await runPromptReview(ctx(answer(JSON.stringify([{ kind: "conflict", line: LINE_A, to: LINE_A2, other: "", why: "w" }, { kind: "outdated", line: LINE_B, to: LINE_A2, other: "", why: "w" }])).call))).findings;
		expect(inGit.map(f => f.decide!.options[0]!.result)).toEqual([`${m.promptReviewApplyResult("RULES.md")} ${m.promptUndo}`, `${m.promptReviewApplyResult(join("features", "f", "feature.md"))} ${m.promptUndo}`]);
	});

	test("an install's own MODE.ko.md that the data dir's snapshot repo ignores gets no undo sentence", async () => {
		const m = msg();
		writeFileSync(join(dir, ".gitignore"), "*\n!RULES.md\n!.gitignore\n");
		writeFileSync(join(dir, "MODE.ko.md"), "# own\n- 내 계약 줄이에요.\n");
		writeFileSync(join(dir, "config.json"), JSON.stringify({ identity: { language: "ko" } }));
		gitRepo(dir, ["-A"]);
		const r = await runPromptReview(ctx(answer(JSON.stringify([{ kind: "outdated", line: "- 내 계약 줄이에요.", to: "- 고친 계약 줄이에요.", other: "", why: "w" }])).call));
		expect(r.findings[0]!.change!.file).toBe(join(dir, "MODE.ko.md"));
		expect(r.findings[0]!.decide!.options[0]!.result).not.toContain(m.promptUndo);
	});

	test("the key follows the quoted lines, not the wording of the rest", async () => {
		const other = JSON.stringify([{ kind: "outdated", line: LINE_A, to: "", other: LINE_B, why: "different" }]);
		const a = await runPromptReview(ctx(answer(GOOD).call));
		rmSync(reviewFile(dir), { force: true });
		const b = await runPromptReview(ctx(answer(other).call));
		expect(b.findings[0]?.key).toBe(a.findings[0]?.key);
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

	test("for any cut of a reply, the items read are exactly its complete items before the cut", () => {
		const text = fc.array(fc.constantFrom("a", "Z", " ", "가", "형", "]", "}", "[", "{", '"', "\\", ",", "`", ":"), { minLength: 1, maxLength: 20 }).map(u => u.join("")).filter(s => s.trim().length > 0);
		const row = fc.record({ kind: fc.constantFrom("conflict", "outdated", "contradicts-code"), line: text, why: text });
		fc.assert(
			fc.property(fc.array(row, { minLength: 1, maxLength: 3 }), fc.nat(), (rows, at) => {
				const items = rows.map(r => ({ ...r, to: `${r.line} new`, other: "" })), reply = JSON.stringify(items), cut = at % (reply.length + 1);
				const complete = items.filter((_, i) => JSON.stringify(items.slice(0, i + 1)).length - 1 <= cut).length;
				const got = parseReview(reply.slice(0, cut));
				if (complete === 0) expect(got).toBeUndefined();
				else expect(got?.map(i => i.line)).toEqual(items.slice(0, complete).map(i => i.line.trim()));
			}),
			{ numRuns: 300 },
		);
	});

	test("the request asks for the exact edit: the line, its full new text and the other line of a conflict, within the same output cap", () => {
		const prompt = buildReviewPrompt("CONTRACT-TEXT");
		expect(prompt).toContain('"to"');
		expect(prompt).toContain('"other"');
		expect(prompt).not.toContain('"proposal"');
		expect(prompt).toContain(`at most ${MAX_OUTPUT_TOKENS} tokens`);
		expect(prompt).toContain("Copy each line whole and exactly as it is in CONTRACT, one line, never a part or a summary.");
	});

	test("an install's own wording of a moved card text applies", () => {
		mkdirSync(join(dir, "custom"), { recursive: true });
		writeFileSync(textsPath(dir), JSON.stringify({ promptReviewLeave: "OWN-LEAVE", promptReviewLeaveResult: { text: "OWN {1} DAYS" }, promptDelete: { text: "OWN-DELETE {1}" }, promptReviewUnplaced: { text: "OWN {1} UNPLACED" } }));
		const t = applyTexts(CATALOGS.ko!, dir, LOCKED_TEXTS);
		expect(t.promptReviewLeave).toBe("OWN-LEAVE");
		expect(t.promptReviewLeaveResult(7)).toBe("OWN 7 DAYS");
		expect(t.promptDelete("x")).toBe("OWN-DELETE x");
		expect(t.promptReviewUnplaced(2)).toBe("OWN 2 UNPLACED");
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
