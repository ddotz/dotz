// What the user changed in a result, kept for the next piece. Sentences of the bot's text and of the user's corrected text are aligned, every changed
// stretch becomes a pair, and a change that shows up in two separate runs becomes a rule. A changed number or name is a fact fix, not a style rule.
import type { CellId } from "./cells.ts";
import { extractFacts } from "./facts.ts";
import { ENDING_LABEL } from "./labels.ts";
import { endingOf } from "./measure.ts";
import { assertPairable, diceOf, gramsOf } from "./review.ts";
import { eojeolsOf, sentencesOf } from "./text.ts";

export type Correction = { run: string; ts: string; cell: CellId; kind: "style" | "fact"; from: string; to: string; sigs: string[] };
export type Change = { from: string; to: string };

const ALIGN_AT = 0.5;
const RULE_AT = 2;
const SUB_CHARS = 12;
const KEEP_PER_CELL = 200;
const RECENT = 5;
const EDGE = /^[^가-힣A-Za-z0-9]+|[^가-힣A-Za-z0-9]+$/g;

// Longest-common-subsequence style alignment that maximises similarity; sentences that stay unmatched between two anchors form one changed stretch.
export function changesBetween(before: string, after: string): Change[] {
	const a = sentencesOf(before);
	const b = sentencesOf(after);
	assertPairable(a, b);
	const [ga, gb] = [a.map(gramsOf), b.map(gramsOf)];
	const w = b.length + 1;
	const sim = (i: number, j: number) => {
		const [x, y] = [ga[i], gb[j]];
		return x && y ? diceOf(x, y) : 0;
	};
	const score = new Float64Array((a.length + 1) * w);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const s = sim(i - 1, j - 1);
			const diagonal = (score[(i - 1) * w + j - 1] ?? 0) + (s >= ALIGN_AT ? s : -1);
			score[i * w + j] = Math.max(score[(i - 1) * w + j] ?? 0, score[i * w + j - 1] ?? 0, diagonal);
		}
	}
	const anchors: [number, number][] = [];
	for (let i = a.length, j = b.length; i > 0 && j > 0;) {
		const s = sim(i - 1, j - 1);
		const here = score[i * w + j] ?? 0;
		if (s >= ALIGN_AT && Math.abs(here - ((score[(i - 1) * w + j - 1] ?? 0) + s)) < 1e-9) {
			anchors.unshift([i - 1, j - 1]);
			i--;
			j--;
		} else if (here === (score[(i - 1) * w + j] ?? 0)) i--;
		else j--;
	}
	const out: Change[] = [];
	const gap = (i0: number, i1: number, j0: number, j1: number) => {
		const from = a.slice(i0, i1).join(" ");
		const to = b.slice(j0, j1).join(" ");
		if (from || to) out.push({ from, to });
	};
	let [pi, pj] = [0, 0];
	for (const [i, j] of anchors) {
		gap(pi, i, pj, j);
		if (a[i] !== b[j]) out.push({ from: a[i] ?? "", to: b[j] ?? "" });
		[pi, pj] = [i + 1, j + 1];
	}
	gap(pi, a.length, pj, b.length);
	return out;
}

const tokens = (s: string): string[] => eojeolsOf(s).map(w => w.replace(EDGE, "").replace(/\d+/g, "#")).filter(Boolean);

function middle(a: string[], b: string[]): [string[], string[]] {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++;
	return [a.slice(head, a.length - tail), b.slice(head, b.length - tail)];
}

const keysOf = (s: string): string => {
	const f = extractFacts(s);
	return [...f.numbers, ...f.names].map(x => x.key).sort().join("|");
};

export function correctionOf(change: Change): { kind: Correction["kind"]; sigs: string[] } {
	if (keysOf(change.from) !== keysOf(change.to)) return { kind: "fact", sigs: [] };
	const sigs: string[] = [];
	const [was, now] = middle(tokens(change.from), tokens(change.to));
	const [wasText, nowText] = [was.join(" "), now.join(" ")];
	if (was.length + now.length > 0 && was.length <= 4 && now.length <= 4 && wasText.length <= SUB_CHARS && nowText.length <= SUB_CHARS) sigs.push(`sub:${wasText}>${nowText}`);
	const [lastFrom, lastTo] = [sentencesOf(change.from).at(-1) ?? "", sentencesOf(change.to).at(-1) ?? ""];
	const [endFrom, endTo] = [endingOf(lastFrom), endingOf(lastTo)];
	if (lastFrom && lastTo && endFrom !== endTo && endFrom !== "noun" && endTo !== "noun") sigs.push(`end:${endFrom}>${endTo}`);
	const [lenFrom, lenTo] = [eojeolsOf(change.from).length, eojeolsOf(change.to).length];
	if (lenFrom >= 6 && lenTo <= lenFrom * 0.7) sigs.push("len:shorter");
	if (lenFrom >= 6 && lenTo >= lenFrom * 1.4) sigs.push("len:longer");
	return { kind: "style", sigs };
}

export function correctionsFrom(input: { before: string; after: string; cell: CellId; run: string; ts: string }): Correction[] {
	return changesBetween(input.before, input.after).map(c => ({ run: input.run, ts: input.ts, cell: input.cell, ...c, ...correctionOf(c) }));
}

// The file keeps the latest 200 corrections of each cell, so it does not grow without end.
export function latestPerCell(corrections: readonly Correction[]): Correction[] {
	const seen = new Map<CellId, number>();
	return corrections.toReversed().filter(c => {
		const n = (seen.get(c.cell) ?? 0) + 1;
		seen.set(c.cell, n);
		return n <= KEEP_PER_CELL;
	}).reverse();
}

function ruleText(sig: string): string {
	const [type, rest = ""] = [sig.slice(0, sig.indexOf(":")), sig.slice(sig.indexOf(":") + 1)];
	const [from = "", to = ""] = rest.split(">");
	if (type === "end") return `문장 끝을 ${ENDING_LABEL[to] ?? to}로 고쳐 써요(${ENDING_LABEL[from] ?? from} 아님)`;
	if (type === "len") return rest === "shorter" ? "문장을 더 짧게 고쳐 써요" : "문장을 더 길게 고쳐 써요";
	if (from && to) return `고쳐 쓴 말: "${from}" -> "${to}"`;
	return from ? `빼는 말: "${from}"` : `덧붙이는 말: "${to}"`;
}

const clip = (s: string): string => (s.length > 50 ? `${s.slice(0, 50)}...` : s);

// A signature counts once per run: a global replace inside one editing session is one correction, not two.
export function rulesFrom(corrections: readonly Correction[], cell: CellId): { rules: string[]; recent: string[] } {
	const mine = corrections.filter(c => c.cell === cell && c.kind === "style");
	const runsBySig = new Map<string, Set<string>>();
	for (const c of mine) for (const sig of c.sigs) runsBySig.set(sig, (runsBySig.get(sig) ?? new Set()).add(c.run));
	const promoted = [...runsBySig].filter(([, runs]) => runs.size >= RULE_AT).map(([sig]) => sig);
	const open = mine.filter(c => !c.sigs.some(s => promoted.includes(s)));
	return { rules: promoted.map(ruleText), recent: open.slice(-RECENT).map(c => `"${clip(c.from)}" -> "${clip(c.to)}"`) };
}
