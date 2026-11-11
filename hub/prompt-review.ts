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
import type { DoctorCheck, Finding } from "./doctor-types.ts";
import { ENFORCED_RULES } from "./enforced-rules.ts";
import { msg } from "./i18n.ts";
import { promptGrowth, readState } from "./prompt-health.ts";
import { recallContract } from "./recall-contract.ts";

const DAY_MS = 86_400_000;
export const REVIEW_EVERY_MS = 7 * DAY_MS;
export const GROWTH_EARLY_MS = 3 * DAY_MS;
export const CONTRACT_MAX_CHARS = 40_000;
export const MAX_OUTPUT_TOKENS = 2_000;
const MAX_ITEMS = 5;
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
	'Reply with a JSON array of at most 5 items {"kind": "conflict"|"outdated"|"contradicts-code", "lines": ["<exact quoted line>", ...], "why": "<one sentence>", "proposal": "<one sentence: what to change>"}.',
	"Quote lines exactly. Report only real problems; reply [] if there are none. Output at most 2000 tokens and nothing but the JSON.",
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
export function buildReviewPrompt(contract: string): string {
	const code = ENFORCED_RULES.map(r => `${r.id}: ${r.guard}`).join("\n");
	return `${REVIEW_TASK}\n\nCODE:\n${code}\n\nCONTRACT:\n${contract.slice(0, CONTRACT_MAX_CHARS)}`;
}

/** The ordinary model only: Fable or max/xhigh effort is not used for a background review. */
export function modelRefused(model: string | undefined): boolean {
	if (!model) return false;
	const effort = model.includes(":") ? model.slice(model.lastIndexOf(":") + 1) : "";
	return /fable/i.test(model) || /^(max|xhigh)$/i.test(effort);
}

type Item = { kind: ReviewKind; lines: string[]; why: string; proposal: string };

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Items from the model's reply; anything that is not the asked shape is dropped. Not JSON at all: undefined. */
export function parseReview(text: string): Item[] | undefined {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end < start) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!Array.isArray(raw)) return undefined;
	const items: Item[] = [];
	for (const r of raw) {
		if (!r || typeof r !== "object") continue;
		const { kind, lines, why, proposal } = r as Record<string, unknown>;
		const quoted = Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string" && squash(l) !== "").map(squash) : [];
		if (!(KINDS as readonly unknown[]).includes(kind) || !quoted.length || typeof why !== "string" || typeof proposal !== "string") continue;
		items.push({ kind: kind as ReviewKind, lines: quoted.slice(0, 4), why: squash(why).slice(0, 300), proposal: squash(proposal).slice(0, 300) });
	}
	return items.slice(0, MAX_ITEMS);
}

const hashOf = (lines: string[]): string => createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 10);

function toFinding(item: Item, tokens: { input: number; output: number }, now: number): Finding {
	const m = msg();
	const shown = item.lines[0] ?? "";
	return {
		key: `prompt:review:${hashOf(item.lines)}`,
		area: "prompt",
		what: m.promptReviewWhat[item.kind] ?? m.promptReviewWhat.conflict ?? "",
		evidence: m.promptReviewEvidence(shown.length > 100 ? `${shown.slice(0, 100)}...` : shown, item.why, tokens.input, tokens.output),
		since: now,
		level: item.lines.reduce((n, l) => n + l.length, 0),
		decide: { question: m.promptReviewAsk, options: [{ name: m.promptReviewApply, result: m.promptReviewApplyResult(item.proposal) }, { name: m.promptReviewLeave, result: m.promptReviewLeaveResult }] },
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

	const contract = recallContract(ctx.dataDir, join(import.meta.dir, "..")).text.slice(0, CONTRACT_MAX_CHARS);
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
	// A quote that appears nowhere in the contract or the code list is the model making a line up.
	const known = squash(`${contract}\n${ENFORCED_RULES.map(r => `${r.id}: ${r.guard}`).join("\n")}`);
	const real = items.filter(i => i.lines.some(l => known.includes(l)));
	return { findings: real.map(i => toFinding(i, tokens, ctx.now)), tokens };
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
