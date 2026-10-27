// Decision options in a message, read from the MODE choice block: `**1) name** ← recommended` or `1) name`, optionally
// quoted with ">". Pure parsing; the Discord buttons (hub/askbuttons.ts) and the web decision card use the same rules.
//
// Rules (the web card mirrors them):
// - Lines inside ``` fences are ignored. A leading ">" and "**" around the option are stripped.
// - Options are numbered 1, 2, 3 ... in a row. A number that restarts at 1 after that means several decision blocks
//   ("1 and 2"): there is no single answer to click, so no options are returned. Fewer than 2 options: none.
// - "← 추천" / "← recommended" anywhere on the option line marks the recommended one.
// - `question` is the last non-empty line before the first option, without a leading status marker.
// The choice block a gateway job appends to an issue report on alert: "결정: <question>", then 2-4 options, the first one recommended,
// each a `**n) name**` line and a one-line consequence. The web's decision buttons and the decision notices read exactly this shape.
export function issueBlock(question: string, options: { name: string; result: string }[]): string {
	return [`결정: ${question}`, ...options.flatMap((o, i) => [`**${i + 1}) ${o.name}**${i === 0 ? " ← 추천" : ""}`, o.result])].join("\n");
}

// KakaoTalk reply drafts: when the incoming message needs a decision only the owner can make, the draft model returns 2-4 short choices
// instead of a draft. Pure helpers shared by the web draft API, the CLI (features/reply-drafts/bin/draft.ts) and the model prompts.
export const OWN_CHOICE = "직접 쓸게";
export const MAX_REPLY_CHOICES = 4;
export const MAX_REPLY_CHOICE_CHARS = 24;
export const MAX_ASK_CHARS = 80;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

// The model's choices: trimmed strings of at most 24 characters, deduped, the "직접 쓸게" option removed (the UI adds it), at most 4.
// Fewer than 2 usable choices is not a question: an empty list.
export function cleanChoices(v: unknown): string[] {
	const out: string[] = [];
	for (const x of Array.isArray(v) ? v : []) {
		if (typeof x !== "string") continue;
		const c = flat(x.replace(/[*\n]/g, " "));
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
	return [`결정: ${question}`, ...choices.flatMap((c, i) => [`**${i + 1}) ${c}**`, "고른 대로 답장을 써요"]), `**${choices.length + 1}) ${OWN_CHOICE} …**`, "적은 글을 답장으로 써요"].join("\n");
}

export type ChoiceOption = { n: number; label: string; recommended: boolean; detail?: true };
type Choices = { question?: string; options: ChoiceOption[] };

const FENCE = /^\s*```/;
const OPTION = /^\s*>?\s*(?:\*\*)?\s*(\d{1,2})\)\s*(.*)$/;
const RECOMMENDED = /←\s*(?:추천|recommended)/i;
const MAX_OPTIONS = 25;

export function parseChoices(text: string): Choices {
	const options: ChoiceOption[] = [];
	let question: string | undefined;
	let before: string | undefined;
	let fence = false;
	for (const line of text.split("\n")) {
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
			const recommended = RECOMMENDED.test(m[2]!);
			const raw = m[2]!.replace(/←.*$/, "").replace(/\*\*/g, "").trim();
			const label = raw.replace(DETAIL_MARK, "").trim();
			if (!label) return { options: [] };
			if (!options.length) question = before;
			options.push({ n, label, recommended, ...(detailOf({ label, detail: DETAIL_MARK.test(raw) }) ? { detail: true as const } : {}) });
			continue;
		}
		const plain = line.replace(/^\s*>\s?/, "").replace(/\*\*/g, "").trim();
		if (plain && !options.length) before = plain.replace(/^\[[^\]]{1,10}\][ \t]*/, "");
	}
	if (options.length < 2 || options.length > MAX_OPTIONS) return { options: [] };
	return { ...(question ? { question } : {}), options };
}

// Several decisions in one message: a "결정: <title>" line opens a block, `**1) name** ← 추천` lines are its options, each with one
// description line under it. A number that restarts at 1 opens the next block. Mirrors the web card (web/js/10-decision-card.js)
// so the bell and the chat card agree on what is being asked. Blocks with fewer than two options are not decisions.
// `detail`: tapping this option asks the owner for a written reason / change first, and the answer goes out as `n) label - <text>`.
// The bot marks it with a trailing ` …` on the option name (`**2) 안 됨 …**`, MODE.md); without the mark, detailOf guesses from the label and the description.
export type DecisionOption = { n: number; label: string; desc: string; rec: boolean; detail?: true };
export const DETAIL_MARK = /\s*…\s*$/;
const DETAIL_LABEL = /^(?:안\s*됨|안\s*돼|아니|아냐|고치기|수정|다른)/;
const DETAIL_DESC = /(?:적어|알려|써|말해)\s*(?:주|줘|달라|세요)|내용.*(?:적|알려|써)/;
// Mirrors detailOf in web/js/10-decision-card.js. A marked option (`detail`) always asks; otherwise a negative / edit label or a description that asks for text does.
export const detailOf = (o: { label: string; desc?: string; detail?: boolean }): boolean => !!o.detail || DETAIL_LABEL.test(o.label) || DETAIL_DESC.test(o.desc ?? "");
// `headed`: the block was opened by a "결정:" line. Any bot message (not only an [ask]) holding a headed block with 2+ options is a decision;
// a bare numbered list without the "결정:" line is not.
type DecisionBlock = { title: string; options: DecisionOption[]; headed?: true };
export const hasDecisionHead = (blocks: DecisionBlock[]): boolean => blocks.some(b => b.headed);
const D_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*(←\s*(?:추천|recommended)|\(\s*(?:추천|recommended)\s*\))?\s*(?:\*\*)?\s*$/i;
export const DECISION_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
const D_CLOSE = /번호(?:로|를).*(?:답|알려)/;
export function parseDecisions(text: string): { question: string; blocks: DecisionBlock[] } {
	const lines = text.replace(/^\s*\[[^\]\n]+\][ \t]*/, "").split("\n");
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
		const h = DECISION_HEAD.exec(line);
		if (h) {
			cur = { title: h[1]!.trim(), options: [], headed: true };
			blocks.push(cur);
			continue;
		}
		const m = D_OPT.exec(line);
		if (!m) continue;
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
		cur.options.push({ n, label: raw.replace(DETAIL_MARK, "").trim(), desc, rec: Boolean(m[3]), ...(marked ? { detail: true as const } : {}) });
	}
	return { question, blocks: blocks.filter(b => b.options.length >= 2) };
}
