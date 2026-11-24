// Weekly model review of the text the orchestrator re-reads after a compaction (part C of the hidden doctor, no owner command).
// A model reads the contract (hub/recall-contract.ts) next to the list of rules code enforces (hub/enforced-rules.ts) and names lines that
// conflict with each other, look outdated, or contradict what the code does. Each one becomes a doctor finding with a two-way choice;
// this module edits nothing: RULES.md and the contract change only after the owner says yes.
// Cost: one call a week (3 days at the earliest when hub/prompt-health.ts sees real growth), skipped while the usage window is tight,
// never on Fable and never at max or xhigh effort. State (last review, last cost) is kept in <DATA_DIR>/prompt-review.json.
// `bun hub/prompt-review.ts --dry` builds the real prompt from the real data dir, prints its size and calls no model.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DoctorCheck, EVIDENCE_LINES, evidenceLines, type Finding, lineSubject } from "./doctor-types.ts";
import { ENFORCED_RULES } from "./enforced-rules.ts";
import { lang, msg } from "./i18n.ts";
import { languageName } from "./language.ts";
import { bareLine, type Change, editLines, enforcedFindings, type Located, locate, notOne, type PromptCard, promptGrowth, readState, ruleSources, withUndo } from "./prompt-health.ts";
import { recallContract } from "./recall-contract.ts";

const DAY_MS = 86_400_000;
export const REVIEW_EVERY_MS = 7 * DAY_MS;
export const GROWTH_EARLY_MS = 3 * DAY_MS;
export const CONTRACT_MAX_CHARS = 40_000;
export const MAX_OUTPUT_TOKENS = 2_000;
const MAX_ITEMS = 3;
const LINE_MAX = 2_000;
const KINDS = ["conflict", "outdated", "contradicts-code"] as const;
export type ReviewKind = (typeof KINDS)[number];

export type ReviewState = { lastReviewAt: number; lastTokens: { input: number; output: number } };
export type ReviewCall = (prompt: string, opts: { maxOutputTokens: number; model?: string }) => Promise<{ text: string; usage: { input: number; output: number } }>;
export type ReviewSkip = "budget" | "model" | "not-due";
export type ReviewResult = { findings: Finding[]; tokens: { input: number; output: number }; skipped?: ReviewSkip };
export type ReviewContext = {
	now: number;
	dataDir: string;
	call: ReviewCall;
	/** True while the usage window is tight; may be asked lazily (the real reader is a network read). */
	budgetTight: boolean | (() => boolean | Promise<boolean>);
	/** The install's ordinary model selector ("<model>" or "<model>:<effort>"); undefined = the helper's default small model. */
	model: string | undefined;
	log?: (line: string) => void;
};

// Machine-facing prompt text: English, short.
export const REVIEW_SYSTEM = "You review the standing instructions of an AI agent. Reply with a JSON array only.";
const REVIEW_TASK = [
	"Below are (1) CONTRACT: the text the agent re-reads after every compaction and (2) CODE: rules the code already enforces (id: guard).",
	"Find lines in CONTRACT that: conflict with another line (kind conflict), are outdated or no longer meaningful (kind outdated), or contradict a CODE rule (kind contradicts-code).",
	'For each, give the exact edit. Reply with a JSON array of at most 3 items {"kind": "conflict"|"outdated"|"contradicts-code", "line": "<the one CONTRACT line to change>", "to": "<the full new text of that line; \\"\\" deletes it>", "other": "<kind conflict: the CONTRACT line it conflicts with; else \\"\\">", "why": "<one plain sentence>"}.',
	"Copy each line whole and exactly as it is in CONTRACT, one line, never a part or a summary. An item without an exact edit is not used. Report only real problems; reply [] if there are none. Output at most 2000 tokens and nothing but the JSON.",
].join("\n");

export const reviewFile = (dataDir: string): string => join(dataDir, "prompt-review.json");

export function readReviewState(dataDir: string): ReviewState | undefined {
	try {
		const raw = JSON.parse(readFileSync(reviewFile(dataDir), "utf8"));
		return raw && typeof raw.lastReviewAt === "number" ? { lastReviewAt: raw.lastReviewAt, lastTokens: { input: Number(raw.lastTokens?.input) || 0, output: Number(raw.lastTokens?.output) || 0 } } : undefined;
	} catch {
		return undefined; // no review yet, or an unreadable file: the first-run rule applies
	}
}

function writeReviewState(dataDir: string, state: ReviewState): void {
	const tmp = `${reviewFile(dataDir)}.tmp`;
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, reviewFile(dataDir));
}

/** Weekly; early (but never within 3 days of the last one) when the text really grew; the first run is due. */
export function reviewDue(state: Pick<ReviewState, "lastReviewAt"> | undefined, now: number, growth: boolean): boolean {
	if (!state) return true;
	const age = now - state.lastReviewAt;
	return age >= REVIEW_EVERY_MS || (growth && age >= GROWTH_EARLY_MS);
}

/** The model call input: the contract text (capped) and the enforced rules as the code side. */
export function buildReviewPrompt(contract: string, language = languageName(lang())): string {
	const code = ENFORCED_RULES.map(r => `${r.id}: ${r.guard}`).join("\n");
	return `${REVIEW_TASK}\nWrite "why" in ${language}: the owner reads it as written. Write "to" in the language of the line it replaces.\n\nCODE:\n${code}\n\nCONTRACT:\n${contract.slice(0, CONTRACT_MAX_CHARS)}`;
}

/** The ordinary model only: Fable or max/xhigh effort is not used for a background review. */
export function modelRefused(model: string | undefined): boolean {
	if (!model) return false;
	const effort = model.includes(":") ? model.slice(model.lastIndexOf(":") + 1) : "";
	return /fable/i.test(model) || /^(max|xhigh)$/i.test(effort);
}

type Item = { kind: ReviewKind; line: string; to: string; other: string; why: string };

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const isKind = (k: unknown): k is ReviewKind => (KINDS as readonly unknown[]).includes(k);
const oneLine = (s: unknown): s is string => typeof s === "string" && !s.includes("\n") && s.length <= LINE_MAX;

const parsed = (json: string): unknown => {
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
};

function replyList(text: string): unknown[] | undefined {
	const start = text.indexOf("["), end = text.lastIndexOf("]");
	if (start < 0) return undefined;
	const whole = end > start ? parsed(text.slice(start, end + 1)) : undefined;
	if (Array.isArray(whole)) return whole;
	let depth = 0, quoted = false, escaped = false, last = -1;
	for (let i = start; i < text.length && depth >= 0; i++) {
		const c = text[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === "[" || c === "{") depth++;
		else if (c === "]" || c === "}") {
			depth--;
			if (c === "}" && depth === 1) last = i;
			if (depth === 0) break;
		}
	}
	const cut = last > start ? parsed(`${text.slice(start, last + 1)}]`) : undefined;
	return Array.isArray(cut) ? cut : undefined;
}

/** Items from the model's reply (a reply cut short by the output cap gives its complete items); anything that is not the asked shape, or names no exact edit (no line, no `to`, `to` the same as the line), is dropped. Not JSON at all: undefined. */
export function parseReview(text: string): Item[] | undefined {
	const raw = replyList(text);
	if (!raw) return undefined;
	const items: Item[] = [];
	for (const r of raw) {
		if (!r || typeof r !== "object") continue;
		const { kind, line, to, other, why } = r as Record<string, unknown>;
		if (!isKind(kind) || !oneLine(line) || !oneLine(to) || typeof why !== "string" || !squash(line) || squash(to) === squash(line)) continue;
		items.push({ kind, line: line.trim(), to: to.trim(), other: oneLine(other) ? other.trim() : "", why: squash(why).slice(0, 300) });
	}
	return items.slice(0, MAX_ITEMS);
}

const hashOf = (lines: string[]): string => createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 10);

/** The other line of a conflict as the card shows it: its file as the owner reads it, its line number and its text. */
export type OtherLine = { shown: string; line: number; text: string };

/**
 * A review card: the kind with the file and line, the line before and after (or the one line to delete), the conflicting line with its file and line when it
 * was found, and the reason while a line is free; titled by the text and the start of the line. The options name the file, the confirm step before any edit
 * and the review's own repeat rule; a card that deletes a line asks to delete it, with the delete option.
 */
export function reviewCard(c: { kind: string; shown: string; change: Change; other?: OtherLine; why: string }): PromptCard {
	const m = msg(), t = m.doctor, question = c.change.to ? t.reviewQuestion : t.ruleQuestion;
	const lines = [...editLines(t.reviewKind[c.kind] ?? t.reviewKind.conflict ?? c.kind, c.shown, c.change), ...(c.other ? [m.promptOther(m.promptAt(c.other.shown, c.other.line), squash(c.other.text))] : [])];
	return {
		evidence: evidenceLines(c.why && lines.length < EVIDENCE_LINES ? [...lines, m.promptWhy(c.why)] : lines, t.more),
		subject: lineSubject(t, c.shown, c.change.from, question),
		question,
		options: [
			c.change.to ? { name: m.promptReviewApply, result: withUndo(m.promptReviewApplyResult(c.shown), c.change.file) } : { name: m.promptRemove, result: withUndo(m.promptReviewRemoveResult(c.shown), c.change.file) },
			{ name: m.promptReviewLeave, result: m.promptReviewLeaveResult(REVIEW_EVERY_MS / DAY_MS) },
		],
	};
}

function toFinding(item: Item, now: number, at: Extract<Located, { kind: "found" }>, to: string, other: OtherLine | undefined): Finding {
	const m = msg(), change = { file: at.path, line: at.line, from: at.text, to }, quoted = [item.line, item.other].filter(Boolean).map(squash);
	const { evidence, ...decide } = reviewCard({ kind: item.kind, shown: at.file, change, ...(other ? { other } : {}), why: item.why });
	return {
		key: `prompt:review:${hashOf(quoted)}`,
		area: "prompt",
		what: `${m.promptReviewWhat[item.kind] ?? ""} ${item.why}`.trim(),
		evidence,
		since: now,
		level: quoted.reduce((n, l) => n + l.length, 0),
		decide,
		change,
	};
}

const none = { input: 0, output: 0 };

export async function runPromptReview(ctx: ReviewContext): Promise<ReviewResult> {
	const log = ctx.log ?? ((line: string) => console.error(line));
	const growth = (() => {
		const health = readState(ctx.dataDir);
		return health ? promptGrowth(health) : false;
	})();
	if (!reviewDue(readReviewState(ctx.dataDir), ctx.now, growth)) return { findings: [], tokens: none, skipped: "not-due" };
	if (modelRefused(ctx.model)) return { findings: [], tokens: none, skipped: "model" };
	const tight = typeof ctx.budgetTight === "function" ? await ctx.budgetTight() : ctx.budgetTight;
	if (tight) return { findings: [], tokens: none, skipped: "budget" };

	const pkg = join(import.meta.dir, ".."), read = recallContract(ctx.dataDir, pkg), contract = read.text.slice(0, CONTRACT_MAX_CHARS);
	const rules = ruleSources(ctx.dataDir, pkg, read.parts, read.modeFile), sources = [...rules, { path: join(ctx.dataDir, "identity", "IDENTITY.md"), file: join("identity", "IDENTITY.md") }];
	const ownPkg = new RegExp(`${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-]|\\.\\w)`, "g");
	let reply: Awaited<ReturnType<ReviewCall>>;
	try {
		reply = await ctx.call(buildReviewPrompt(contract), { maxOutputTokens: MAX_OUTPUT_TOKENS, ...(ctx.model ? { model: ctx.model } : {}) });
	} catch (e) {
		log(`prompt review: model call failed (${(e as Error).message}); tried again at the next run`);
		return { findings: [], tokens: none };
	}
	const tokens = { input: reply.usage.input, output: reply.usage.output };
	// The call is spent whatever it answered: the next review is due after the interval, not at the next run.
	writeReviewState(ctx.dataDir, { lastReviewAt: ctx.now, lastTokens: tokens });
	const items = parseReview(reply.text.slice(0, 20_000));
	if (!items) {
		log("prompt review: the reply was not a JSON list; no findings");
		return { findings: [], tokens };
	}
	const enforced = new Set(enforcedFindings(rules, ctx.now, () => {}).map(f => `${f.change?.file}:${f.change?.line}`));
	const findings: Finding[] = [];
	let unplaced = 0;
	for (const item of items) {
		const at = locate(item.line, sources), clip = squash(item.line).slice(0, 60);
		if (at.kind !== "found") {
			unplaced++;
			log(`prompt review: dropped the item on "${clip}": ${notOne(at)}`);
			continue;
		}
		const written = at.text.includes("{repo}") ? item.to.replace(ownPkg, "{repo}") : item.to, to = written ? `${at.text.slice(0, at.text.length - at.text.trimStart().length)}${written}` : "";
		if (to && bareLine(to) === bareLine(at.text)) {
			log(`prompt review: dropped the item on "${clip}": its new text is the line itself`);
			continue;
		}
		if (enforced.has(`${at.path}:${at.line}`)) {
			log(`prompt review: dropped the item on "${clip}": the enforced-rule check proposes that line; its reason: ${item.why}`);
			continue;
		}
		const other = item.other ? locate(item.other, sources) : undefined;
		if (other && other.kind !== "found") log(`prompt review: the other line of the item on "${clip}" is not shown: ${notOne(other)}`);
		const shown = other?.kind === "found" && !(other.path === at.path && other.line === at.line) ? { shown: other.file, line: other.line, text: other.text } : undefined;
		findings.push(toFinding(item, ctx.now, at, to, shown));
	}
	if (unplaced) findings.push({ key: "prompt:unplaced", area: "prompt", what: msg().promptReviewUnplaced(unplaced), evidence: [], since: ctx.now, level: unplaced });
	return { findings, tokens };
}

/** Where the gateway's own model call, budget reader and ordinary model are reached; loaded on first use so this module stays free of gateway state. Tests replace the members. */
export const reviewDeps = {
	model: async (): Promise<string | undefined> => (await import("../features/reply-drafts/lib/settings.ts")).loadSettings().model,
	budgetTight: async (): Promise<boolean> => {
		const { budgetProblem } = await import("./routes-lanes.ts");
		const { estimateOf } = await import("./lanes.ts");
		return (await budgetProblem("prompt-review", estimateOf(undefined), false)) !== undefined;
	},
	call: (async (prompt, opts) => {
		const { callModel } = await import("./outlang.ts");
		const r = await callModel(REVIEW_SYSTEM, prompt, { model: opts.model, timeoutMs: 180_000 });
		return { text: r.text, usage: { input: r.inputTokens, output: r.outputTokens } };
	}) as ReviewCall,
};

/** The doctor check: the review with the gateway's model, budget reader and ordinary model. */
// A dry doctor run (`bun hub/doctor.ts --dry`) never spends a model call.
export const promptReviewCheck: DoctorCheck = async ctx =>
	ctx.dry ? [] : (await runPromptReview({ now: ctx.now, dataDir: ctx.dataDir, call: reviewDeps.call, budgetTight: reviewDeps.budgetTight, model: await reviewDeps.model() })).findings;

if (import.meta.main && process.argv.includes("--dry")) {
	const dataDir = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
	const prompt = buildReviewPrompt(recallContract(dataDir, join(import.meta.dir, "..")).text);
	// Measured on a real run: a mostly Korean prompt of 26,074 chars cost 22,961 input tokens, so about 1.1 chars a token.
	const estInputTokens = Math.round(prompt.length / 1.1);
	console.log(`prompt ${prompt.length} chars, about ${estInputTokens} input tokens (chars/1.1), up to ${MAX_OUTPUT_TOKENS} output tokens; no model called`);
	console.log(`RESULT ${JSON.stringify({ ms: Math.round(performance.now()), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), promptChars: prompt.length, estInputTokens })}`);
}
