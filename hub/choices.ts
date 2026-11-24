// Decision options in a message, read from the MODE choice block: `**1) name**` or `1) name`, optionally
// quoted with ">". Pure parsing; the Discord buttons (hub/askbuttons.ts) and the web decision card use the same rules.
//
// Rules (the web card mirrors them):
// - Lines inside ``` fences are ignored. A leading ">" and "**" around the option are stripped.
// - Options are numbered 1, 2, 3 ... in a row. A number that restarts at 1 after that means several decision blocks
//   ("1 and 2"): there is no single answer to click, so no options are returned. Fewer than 2 options: none.
// - The recommendation mark older messages carry on an option line is dropped (stripRecommendMark): nothing shows or keys on it.
// The choice block a gateway job appends to an issue report on alert: "결정: <question>", then 2-4 options,
// each a `**n) name**` line and a one-line consequence. The web's decision buttons and the decision notices read exactly this shape.
export function issueBlock(question: string, options: { name: string; result: string }[]): string {
	return [`결정: ${question}`, ...options.flatMap((o, i) => [`**${i + 1}) ${unnumbered(o.name)}**`, ...(o.result ? [o.result] : [])])].join("\n");
}

/** One answer-needed card in the D1 shape (docs/notifications.md): the head `결정: <subject> · <question>`, the card's own evidence lines,
 * then each option as a `**n) name**` line and the line that says what picking it does. Every surface reads the evidence as this card's.
 * Text from data that a parser would read as a head, an option, a fence or a dropped line gets an INERT mark, so every parser reads the card as given.
 * Throws on a call no card can come from: fewer than two options, an option without a name, or no subject and no question. */
export function cardBlock(card: { subject: string; question: string; evidence?: string[]; options: { name: string; result: string }[] }): string {
	const title = [card.subject, card.question].map(flat).filter(Boolean).join(" · ");
	if (!title) throw new Error("cardBlock: a card needs a subject or a question");
	if (card.options.length < 2) throw new Error("cardBlock: a card needs at least two options");
	if (card.options.some(o => !flat(o.name))) throw new Error("cardBlock: every option needs a name");
	const evidence = (card.evidence ?? []).map(flat).filter(Boolean).map(inertLine);
	return [`결정: ${inertWithin(title, TITLE_START)}`, ...evidence, ...card.options.flatMap((o, i) => [`**${i + 1}) ${inertWithin(flat(o.name), NAME_START)}**`, ...(flat(o.result) ? [inertLine(flat(o.result))] : [])])].join("\n");
}
/** The invisible mark cardBlock puts into a data line the parsers would otherwise read as structure: the owner reads the same words. */
export const INERT = "\u200b";
const STRUCTURE_START = /^(?:[>*`[]|\d+\s*[).]|결정|decision)/i;
const TITLE_START = /^(?:\[|결정|decision)/i;
const NAME_START = /^(?:\d{1,2}[).]|\*)/;
const inertLine = (s: string): string => {
	const t = D_CLOSE.test(s) ? s.replace(/번(?=호[로를])/g, `번${INERT}`) : s;
	return STRUCTURE_START.test(t) ? `${INERT}${t}` : t;
};
const inertWithin = (s: string, start: RegExp): string => {
	const t = (start.test(s) ? `${INERT}${s}` : s).replace(/\*(?=\*)/g, `*${INERT}`);
	return t.endsWith("*") ? `${t}${INERT}` : t;
};

// KakaoTalk reply drafts: when the incoming message needs a decision only the owner can make, the draft model returns 2-4 short choices
// instead of a draft. Pure helpers shared by the web draft API, the CLI (features/reply-drafts/bin/draft.ts) and the model prompts.
export const OWN_CHOICE = "직접 쓸게";
export const MAX_REPLY_CHOICES = 4;
export const MAX_REPLY_CHOICE_CHARS = 24;
export const MAX_ASK_CHARS = 80;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** A choice label without a number the model wrote into it ("1) 회사 메일로 받기" -> "회사 메일로 받기"): the option's own number is the only one shown and sent. */
export const unnumbered = (label: string): string => label.replace(/^(?:\d{1,2}[).]\s+)+/, "").trim() || label;

// The model's choices: trimmed strings of at most 24 characters, deduped, the "직접 쓸게" option removed (the UI adds it), at most 4.
// Fewer than 2 usable choices is not a question: an empty list.
export function cleanChoices(v: unknown): string[] {
	const out: string[] = [];
	for (const x of Array.isArray(v) ? v : []) {
		if (typeof x !== "string") continue;
		const c = unnumbered(flat(x.replace(/[*\n]/g, " ")));
		if (!c || [...c].length > MAX_REPLY_CHOICE_CHARS || c === OWN_CHOICE || out.includes(c)) continue;
		out.push(c);
	}
	return out.length >= 2 ? out.slice(0, MAX_REPLY_CHOICES) : [];
}

export const cleanQuestion = (v: unknown): string => {
	const q = typeof v === "string" ? flat(v) : "";
	return [...q].length > MAX_ASK_CHARS ? `${[...q].slice(0, MAX_ASK_CHARS - 1).join("")}…` : q;
};

// The choice block the orchestrator posts unchanged (the issue-report shape: "결정: <question>", `**n) name**` lines, one description line each;
// the last option is "직접 쓸게 …": the trailing mark makes the answer carry the owner's own text).
export function replyChoiceBlock(question: string, choices: string[]): string {
	return [`결정: ${question}`, ...choices.flatMap((c, i) => [`**${i + 1}) ${unnumbered(c)}**`, "고른 대로 답장을 써요"]), `**${choices.length + 1}) ${OWN_CHOICE} …**`, "적은 글을 답장으로 써요"].join("\n");
}

export type ChoiceOption = { n: number; label: string; detail?: true };
type Choices = { question?: string; options: ChoiceOption[] };

const FENCE = /^\s*```/;
const OPTION = /^\s*>?\s*(?:\*\*)?\s*(\d{1,2})\)\s*(.*)$/;
const MAX_OPTIONS = 25;

// A numbered list in the body above a "결정:" line is text, not a first decision block.
function fromFirstHead(lines: string[]): string[] {
	let fence = false;
	for (let i = 0; i < lines.length; i++) {
		if (FENCE.test(lines[i]!)) fence = !fence;
		else if (!fence && DECISION_HEAD.test(lines[i]!)) return lines.slice(i);
	}
	return lines;
}

// Older messages, and gateways on an older version, still mark one option as recommended. Mirrors stripRecMark in web/js/10-decision-card.js.
const REC_MARK = /^([ \t]*>?[ \t]*(?:\*\*)?[ \t]*\d{1,2}(?:\)|\.[ \t]).*?)[ \t]*(?:(?:←|<-)[ \t]*(?:추천|recommended)|\([ \t]*(?:추천|권장|recommended)[ \t]*\))/gim;
export const stripRecommendMark = (text: string): string => text.replace(REC_MARK, "$1");

export function parseChoices(text: string): Choices {
	const options: ChoiceOption[] = [];
	let question: string | undefined;
	let before: string | undefined;
	let headed = false;
	let fence = false;
	for (const line of fromFirstHead(text.split("\n"))) {
		if (FENCE.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const m = OPTION.exec(line);
		if (m) {
			const n = Number(m[1]);
			if (n !== options.length + 1) {
				// A new block restarting at 1 is a second decision; any other jump is not a choice block.
				if (options.length) return { options: [] };
				continue;
			}
			const raw = stripRecommendMark(`1) ${m[2]!}`).slice(3).replace(/\*\*/g, "").trim();
			const label = unnumbered(raw.replace(DETAIL_MARK, "").trim());
			if (!label) return { options: [] };
			if (!options.length) question = before;
			options.push({ n, label, ...(detailOf({ label, detail: DETAIL_MARK.test(raw) }) ? { detail: true as const } : {}) });
			continue;
		}
		const plain = line.replace(/^\s*>\s?/, "").replace(/\*\*/g, "").trim();
		if (!plain || options.length) continue;
		const said = oneHead(plain.replace(/^\[[^\]]{1,10}\][ \t]*/, ""));
		const head = DECISION_HEAD.test(said);
		if (head || !headed) before = said;
		headed ||= head;
	}
	if (options.length < 2 || options.length > MAX_OPTIONS) return { options: [] };
	return { ...(question ? { question } : {}), options };
}

// Several decisions in one message: a "결정: <title>" line opens a block, `**1) name**` lines are its options, each with one
// description line under it. A number that restarts at 1 opens the next block. Mirrors the web card (web/js/10-decision-card.js)
// so the bell and the chat card agree on what is being asked. Blocks with fewer than two options are not decisions.
// `detail`: tapping this option asks the owner for a written reason / change first, and the answer goes out as `n) label - <text>`.
// The bot marks it with a trailing ` …` on the option name (`**2) 안 됨 …**`, MODE.md); without the mark, detailOf guesses from the label and the description.
export type DecisionOption = { n: number; label: string; desc: string; detail?: true };
export const DETAIL_MARK = /\s*…\s*$/;
// "아니요" and "다른 …" are answers in themselves: only a refusal that needs its reason or an edit asks for text unmarked.
const DETAIL_LABEL = /^(?:안\s*됨|안\s*돼|고치기|수정)/;
export const DETAIL_DESC = /(?:적어|알려|써|말해)\s*(?:주|줘|달라|세요)|내용.*(?:적|알려|써)/;
// Mirrors detailOf in web/js/10-decision-card.js. A marked option (`detail`) always asks; otherwise a negative / edit label or a description that asks for text does.
export const detailOf = (o: { label: string; desc?: string; detail?: boolean }): boolean => !!o.detail || DETAIL_LABEL.test(o.label) || DETAIL_DESC.test(o.desc ?? "");
// `headed`: the block was opened by a "결정:" line. Any bot message (not only an [ask]) holding a headed block with 2+ options is a decision;
// a bare numbered list without the "결정:" line is not.
type DecisionBlock = { title: string; options: DecisionOption[]; headed?: true; evidence?: string[] };
export const hasDecisionHead = (blocks: DecisionBlock[]): boolean => blocks.some(b => b.headed);
export const D_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*$/;
export const DECISION_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)(?:\s*#?\d{1,2})?\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
// The question written for an ask that names none (hub/ask-normalize.ts): two asks under it are not the same question (hub/notices-store.ts putDecision).
export const FILLER_QUESTIONS = { ko: "어떻게 할까요?", en: "How should I proceed?" };
export const D_CLOSE = /번호(?:로|를).*(?:답|알려)/;
// A head written twice ("결정: [ask] 결정: <question>", outbox 2026-11-09) is one head: the marker and the second label after the first go.
const DOUBLED_HEAD = /^(\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)(?:\s*#?\d{1,2})?\s*[:：]\s*)(?:\[[^\]\n]{1,10}\][ \t]*|(?:결정|decision(?: needed)?)\s*[:：][ \t]*)+/i;
const oneHead = (line: string): string => line.replace(DOUBLED_HEAD, "$1");
const FILE_LINE = /^\s*\[file\]\s+\S/;
const isEvidence = (line: string): boolean => !!line.trim() && !D_CLOSE.test(line) && !FILE_LINE.test(line) && !D_OPT.test(line) && !DECISION_HEAD.test(line);
/** One decision of a several-decision message, as its notice stores it: the card's evidence lines (the lines between its "결정:" head and its
 * first option), the lead text before the first head, then the block's lines after its options. Option lines (the buttons show them), the head
 * and the other decisions never appear. `index` counts the blocks parseDecisions keeps (a head with 2+ options), so a head with no or one
 * option shifts nothing; a message with no such block at all (no card) counts every head, so its text is never lost. Empty when nothing is left. */
export function decisionText(body: string, index: number): string {
	const lines = stripRecommendMark(body).replace(/^\s*\[[^\]\n]+\][ \t]*/, "").split("\n");
	const lead: string[] = [];
	const parts: { evidence: string[]; rest: string[]; options: number; last: number; restarted: boolean }[] = [];
	let fence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) fence = !fence;
		if (!fence && DECISION_HEAD.test(line)) {
			parts.push({ evidence: [], rest: [], options: 0, last: 0, restarted: false });
			continue;
		}
		if (!fence && D_CLOSE.test(line)) continue;
		const part = parts[parts.length - 1];
		const opt = !fence && part ? D_OPT.exec(line) : null;
		if (part && opt) {
			const n = Number(opt[1]);
			if (part.options && n <= part.last) part.restarted = true;
			if (!part.restarted) {
				part.options++;
				part.last = n;
			}
			const nx = lines[i + 1];
			if (nx !== undefined && nx.trim() && !D_OPT.test(nx) && !DECISION_HEAD.test(nx) && !D_CLOSE.test(nx) && !FENCE.test(nx)) i++;
			continue;
		}
		if (!part) lead.push(line);
		else if (!fence && !part.options && !FENCE.test(line) && isEvidence(line)) part.evidence.push(line.trim());
		else part.rest.push(line);
	}
	const cards = parts.filter(p => p.options >= 2), own = (cards.length ? cards : parts)[index];
	const evidence = own?.evidence.length ? [...own.evidence, ""] : [];
	return [...evidence, ...lead, "", ...(own?.rest ?? [])].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// A message for a place with no buttons (the main chat's compact result card): each "결정:" line keeps its question in words, its option lines and their
// description lines go (a summary cut inside the block left a head with one option: a card that could not be, 2026-11-10 "라이선스").
export function plainDecisions(text: string): string {
	const lines = text.split("\n"), out: string[] = [];
	let fence = false, headed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) fence = !fence;
		const h = fence ? null : DECISION_HEAD.exec(oneHead(line));
		if (h || (!fence && headed && (D_OPT.test(line) || D_CLOSE.test(line)))) {
			if (h) out.push(h[1]!);
			const nx = lines[i + 1];
			if (!h && D_OPT.test(line) && nx !== undefined && nx.trim() && !D_OPT.test(nx) && !DECISION_HEAD.test(nx) && !D_CLOSE.test(nx) && !FENCE.test(nx)) i++;
			headed = true;
			continue;
		}
		if (line.trim()) headed = false;
		out.push(line);
	}
	return out.join("\n");
}
export function parseDecisions(text: string): { question: string; blocks: DecisionBlock[] } {
	const lines = stripRecommendMark(text).replace(/^\s*\[[^\]\n]+\][ \t]*/, "").split("\n");
	const blocks: DecisionBlock[] = [];
	let i = 0;
	let question = "";
	let cur: DecisionBlock | undefined;
	let fence = false;
	while (i < lines.length && !lines[i]!.trim()) i++;
	if (i < lines.length && !D_OPT.test(lines[i]!) && !DECISION_HEAD.test(lines[i]!)) question = lines[i++]!.trim();
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const h = DECISION_HEAD.exec(oneHead(line));
		if (h) {
			cur = { title: h[1]!.trim(), options: [], headed: true };
			blocks.push(cur);
			continue;
		}
		const m = D_OPT.exec(line);
		if (!m) {
			if (cur?.headed && !cur.options.length && isEvidence(line)) (cur.evidence ??= []).push(line.trim());
			continue;
		}
		const n = Number(m[1]);
		if (!cur || (cur.options.length && n <= cur.options[cur.options.length - 1]!.n)) {
			cur = { title: "", options: [] };
			blocks.push(cur);
		}
		let desc = "";
		const next = lines[i + 1];
		if (next !== undefined && next.trim() && !D_OPT.test(next) && !DECISION_HEAD.test(next) && !D_CLOSE.test(next) && !FENCE.test(next)) {
			desc = next.trim();
			i++;
		}
		const raw = m[2]!.replace(/^\*+|\*+$/g, "").trim();
		const marked = DETAIL_MARK.test(raw);
		cur.options.push({ n, label: unnumbered(raw.replace(DETAIL_MARK, "").trim()), desc, ...(marked ? { detail: true as const } : {}) });
	}
	// Only a block a "결정:" line opened is a decision (owner 2026-11-01): a numbered or bold list in the body ("**1) 답변 필요:** ...") is text, never an option.
	return { question, blocks: blocks.filter(b => b.headed && b.options.length >= 2) };
}
