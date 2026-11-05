// The writing brief: what the agent that writes the piece gets to read. Measured values as plain sentences, examples from the owner's own texts,
// the rules learned from corrections, and the fact rule. A cell without evidence says so first and gives no style values; nothing is made up.
import type { CellId } from "./cells.ts";
import { extractFacts } from "./facts.ts";
import { CLOSING_LABEL, ENDING_LABEL, OPENING_LABEL, PUNCT_LABEL, STATUS_LABEL } from "./labels.ts";
import { ENDING_CLASSES } from "./measure.ts";
import type { CellProfile, Kind } from "./profile.ts";
import { dice } from "./review.ts";
import { joinCapped, nonSpaceLength, paragraphsOf } from "./text.ts";

export type BriefInput = {
	cell: CellId;
	basis: string;
	voice: string;
	kind: Kind;
	profile: CellProfile | undefined;
	profileMissing?: boolean;
	audience?: string;
	examples: readonly string[];
	rules: readonly string[];
	recent: readonly string[];
	draft?: string;
	material?: string;
};

const EXAMPLES = 8;
const EXAMPLE_CHARS = 3000;
const PER_DOC = 2;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => String(Math.round(n * 10) / 10);

// Paragraph-sized examples from the owner's texts, the most similar to the request first, at most two from one text and 3,000 characters in all.
export function pickExamples(texts: readonly string[], query: string): string[] {
	const paragraphs = texts.flatMap((t, doc) => paragraphsOf(t).filter(p => nonSpaceLength(p) >= 40 && nonSpaceLength(p) <= 600).map(p => ({ doc, p, score: dice(query, p) })));
	const ranked = paragraphs.map((x, order) => ({ ...x, order })).sort((a, b) => b.score - a.score || a.order - b.order);
	const used = new Map<number, number>();
	const picked: string[] = [];
	let total = 0;
	for (const { doc, p } of ranked) {
		if (picked.length >= EXAMPLES || (used.get(doc) ?? 0) >= PER_DOC || total + nonSpaceLength(p) > EXAMPLE_CHARS) continue;
		used.set(doc, (used.get(doc) ?? 0) + 1);
		total += nonSpaceLength(p);
		picked.push(p);
	}
	return picked;
}

const shareLine = (title: string, entries: [string, number][]): string | undefined => {
	const shown = entries.filter(([, v]) => v >= 0.03).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`);
	return shown.length ? `- ${title}: ${shown.join(", ")}` : undefined;
};

function measuredLines(cell: CellProfile): string[] {
	const v = cell.values ?? {};
	const g = (k: string) => v[k] ?? 0;
	const [lo, hi] = cell.ranges?.s_mean ?? [0, 0];
	const top = cell.endingTop ?? [];
	const topTotal = top.reduce((a, [, n]) => a + n, 0) || 1;
	const written = Object.entries(PUNCT_LABEL).filter(([k]) => g(`p_${k}`) > 0).map(([k, label]) => `${label} 천 자당 ${num(g(`p_${k}`))}개`);
	const unused = Object.entries(PUNCT_LABEL).filter(([k]) => g(`p_${k}`) === 0).map(([, label]) => label);
	const entropy = g("e_entropy");
	return [
		`- 문장: 평균 ${num(g("s_mean"))}어절, 보통 ${num(lo)}~${num(hi)}어절. 짧은 쪽 10%는 ${num(g("s_p10"))}어절 이하, 긴 쪽 10%는 ${num(g("s_p90"))}어절 이상.`,
		shareLine("문장 끝", ENDING_CLASSES.map((c): [string, number] => [ENDING_LABEL[c] ?? c, g(`e_${c}`)])),
		top.length ? `- 자주 쓰는 끝맺음: ${top.slice(0, 6).map(([k, n]) => `${k}(${pct(n / topTotal)})`).join(", ")}. 끝맺음은 ${entropy < 0.5 ? "몇 가지로 몰리는" : entropy < 0.8 ? "적당히 섞이는" : "다양하게 섞이는"} 편이에요.` : undefined,
		`- 호흡: 문단당 문장 ${num(g("b_para"))}개, 한 줄 문단 ${pct(g("b_one"))}, 빈 줄 ${pct(g("b_blank"))}.`,
		written.length ? `- 구두점: ${written.join(", ")}.` : undefined,
		unused.length && cell.status === "ok" ? `- 쓰지 않는 표시: ${unused.join(", ")}.` : undefined,
		shareLine("도입", Object.entries(OPENING_LABEL).map(([k, label]): [string, number] => [label, g(`o_${k}`)])),
		shareLine("끝", Object.entries(CLOSING_LABEL).map(([k, label]): [string, number] => [label, g(`c_${k}`)])),
		cell.connectives?.length ? `- 문장 첫머리 접속 표현: ${cell.connectives.slice(0, 6).map(([k, n]) => `${k}(${n})`).join(", ")}.` : undefined,
		`- 인칭(천 어절당): 나 ${num(g("n_na"))}, 저 ${num(g("n_jeo"))}, 우리 ${num(g("n_uri"))}.`,
	].filter((l): l is string => l !== undefined);
}

function head(input: BriefInput): string {
	const p = input.profile;
	if (!p && input.profileMissing) return `칸: ${input.cell} (근거: ${input.basis}) - 근거 없음: ${input.voice} 목소리는 아직 분석한 글이 없어요. 값은 지어내지 말고, \`analyze\`로 먼저 재어 두세요.`;
	if (!p) return `칸: ${input.cell} (근거: ${input.basis}) - 근거 없음: 이 칸은 니즈에 없어서 계산하지 않았어요. 값은 지어내지 말고 \`needs add\`로 추가하면 저장된 글에서 바로 계산해요.`;
	const have = `${input.voice} 목소리의 글 ${p.docs}편, 한글 ${p.hangul}자, 측정 단위 ${p.units}개`;
	if (p.status === "empty") return `칸: ${input.cell} (근거: ${input.basis}) - 근거 없음: ${have}라서 문체 값을 낼 수 없어요. 값을 지어내지 말고, 요청과 사용자가 준 재료만 따라요.`;
	const note = p.status === "direction" ? " 값은 방향만 참고하세요." : "";
	return `칸: ${input.cell} (근거: ${input.basis}) - ${STATUS_LABEL[p.status]}: ${have}.${note}`;
}

export function buildBrief(input: BriefInput): string {
	const p = input.profile;
	const lines = [head(input)];
	if (input.audience) lines.push(`[독자] ${input.audience}`);
	if (p && p.status !== "empty") lines.push("", "[실측한 문체]", ...measuredLines(p));
	if (input.kind === "self" && input.examples.length) lines.push("", `[예문 ${input.examples.length}개] 이 사람이 쓴 글이에요. 말투를 따르고 내용은 옮기지 않아요.`, ...input.examples.map((e, i) => `${i + 1}) ${e.replace(/\n+/g, " / ")}`));
	if (input.kind === "other") lines.push("", "[다른 사람 문체] 예문 없이 측정값만 있어요. 흉내까지만 하고 그 사람의 문장을 옮기지 않아요(옮기면 검사에서 막혀요).");
	if (input.rules.length) lines.push("", "[고친 점 규칙] 사용자가 같은 고침을 두 번 이상 했어요:", ...input.rules.map(r => `- ${r}`));
	if (input.recent.length) lines.push("", "[최근 고침] 한 번씩 있었던 고침이에요:", ...input.recent.map(r => `- ${r}`));
	const base = [input.draft, input.material].filter(Boolean).join("\n");
	const facts = base ? extractFacts(base) : undefined;
	lines.push("", input.draft
		? "[사실 규칙] 다듬기예요. 초안에 없는 사실, 숫자, 이름을 넣지 않고 초안의 숫자와 이름을 바꾸거나 빼지 않아요."
		: "[사실 규칙] 사용자가 준 재료 밖의 구체 사실, 숫자, 이름을 지어내지 않아요. 빈자리는 묻거나 [  ]로 비워 둬요.");
	if (facts) lines.push(`- 숫자: ${joinCapped(facts.numbers.map(f => f.raw)) || "없음"}`, `- 이름: ${joinCapped(facts.names.map(f => f.raw)) || "없음"}`);
	return lines.join("\n");
}
