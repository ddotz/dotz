// The check of a result in one call: facts against the draft or material, and copying. Blocked (facts or copying) is code 3 at the CLI.
// When there is a draft, the list of places the result changed is returned too, so the user can see what was touched.
import { type CopyReport, type CopySource, copyCheck } from "./copycheck.ts";
import { compareFacts, extractFacts, type FactDiff } from "./facts.ts";
import { type Change, changesBetween } from "./learn.ts";
import { pairable, type Review, reviewList } from "./review.ts";
import { capList, joinCapped, sentencesOf } from "./text.ts";

export type CheckInput = {
	result: string;
	draft?: string;
	material?: string;
	sources: readonly CopySource[];
	salt: number;
};
export type CheckReport = {
	mode: "edit" | "new" | "unchecked";
	numbers: FactDiff;
	names: FactDiff;
	confirm: string[];
	review?: Review;
	changes: Change[];
	omitted: boolean;
	copy: CopyReport;
	blocked: boolean;
};

const NONE: FactDiff = { missing: [], invented: [] };
const MAX_CHANGES = 20;
const SIDE_CHARS = 80;

export function runChecks(input: CheckInput): CheckReport {
	const { result, draft, material } = input;
	const base = [draft, material].filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
	let numbers = NONE;
	let names = NONE;
	let confirm: string[] = [];
	if (base) {
		const against = compareFacts(base, result);
		const vsDraft = draft ? compareFacts(draft, result) : undefined;
		numbers = { missing: vsDraft?.numbers.missing ?? [], invented: against.numbers.invented };
		names = { missing: vsDraft?.names.missing ?? [], invented: against.names.invented };
	} else {
		const own = extractFacts(result);
		confirm = [...own.numbers, ...own.names].map(f => f.raw);
	}
	const omitted = draft !== undefined && !pairable(sentencesOf(draft), sentencesOf(result));
	const copy = copyCheck({ result, known: [draft ?? "", material ?? ""], sources: input.sources, salt: input.salt });
	const factsBlocked = [numbers, names].some(d => d.missing.length > 0 || d.invented.length > 0);
	return {
		mode: draft ? "edit" : material ? "new" : "unchecked",
		numbers,
		names,
		confirm,
		...(draft && !omitted ? { review: reviewList(draft, result) } : {}),
		changes: draft && !omitted ? changesBetween(draft, result) : [],
		omitted,
		copy,
		blocked: factsBlocked || copy.blocks.length > 0,
	};
}

const raws = (facts: { raw: string }[]) => facts.map(f => f.raw).join(", ");
const clip = (s: string): string => (s.length > SIDE_CHARS ? `${s.slice(0, SIDE_CHARS - 3)}...` : s);

export function reportLines(r: CheckReport): string[] {
	const out = [`검사 결과: ${r.blocked ? "막힘" : "통과"}`];
	const basis = { edit: "초안 기준(다듬기)", new: "재료 기준(새로 쓰기: 재료 밖의 것만 봐요)", unchecked: "재료가 없어서 대조하지 못했어요" }[r.mode];
	out.push(`1. 사실 대조 - ${basis}`);
	if (r.numbers.missing.length) out.push(`  숫자가 사라졌어요: ${raws(r.numbers.missing)}`);
	if (r.numbers.invented.length) out.push(`  숫자가 새로 생겼어요: ${raws(r.numbers.invented)}`);
	if (r.names.missing.length) out.push(`  이름이 사라졌어요: ${raws(r.names.missing)}`);
	if (r.names.invented.length) out.push(`  이름이 새로 생겼어요: ${raws(r.names.invented)}`);
	if (r.confirm.length) out.push(`  확인할 것(결과의 숫자·이름 전부): ${joinCapped(r.confirm)}`);
	if (r.review) {
		const missing = capList(r.review.missingSentences);
		for (const s of missing.shown) out.push(`  검토: 빠진 문장 후보 "${s}"`);
		if (missing.more) out.push(`  검토: 빠진 문장 후보 외 ${missing.more}개`);
		for (const n of r.review.negationChanged) out.push(`  검토: 부정 표현이 바뀐 듯해요 "${n.from}" -> "${n.to}"`);
		for (const a of r.review.approxChanged) out.push(`  검토: 근사 표현이 바뀌었어요(${a.words}) "${a.from}" -> "${a.to}"`);
		if (r.review.newWords.length) out.push(`  검토: 새로 나온 낱말 ${joinCapped(r.review.newWords)}`);
	}
	out.push("2. 베끼기");
	for (const o of r.copy.blocks) out.push(`  막힘: 다른 사람 글(${o.voice})과 ${o.chars}자 이어서 겹쳐요 "${o.sample}..."`);
	for (const o of r.copy.warns) out.push(`  경고: 내 글(${o.voice})과 ${o.chars}자 이어서 겹쳐요 "${o.sample}..."`);
	if (!r.copy.blocks.length && !r.copy.warns.length) out.push("  겹치는 구절 없음");
	if (r.omitted) out.push("글이 길어서 검토 목록과 바뀐 곳 목록은 빼고, 사실 대조와 베끼기 검사만 했어요. 고칠 장이나 글 단위로 나눠 넣으면 볼 수 있어요");
	else if (r.mode === "edit") {
		out.push("바뀐 곳");
		for (const c of r.changes.slice(0, MAX_CHANGES)) out.push(`  "${clip(c.from)}" -> "${clip(c.to)}"`);
		if (r.changes.length > MAX_CHANGES) out.push(`  외 ${r.changes.length - MAX_CHANGES}곳`);
		if (r.changes.length === 0) out.push("  바뀐 곳 없음");
	}
	return out;
}
