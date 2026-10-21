// Decision options in a message, read from the MODE choice block: `**1) name** ← recommended` or `1) name`, optionally
// quoted with ">". Pure parsing; the Discord buttons (hub/askbuttons.ts) and the web decision card use the same rules.
//
// Rules (the web card mirrors them):
// - Lines inside ``` fences are ignored. A leading ">" and "**" around the option are stripped.
// - Options are numbered 1, 2, 3 ... in a row. A number that restarts at 1 after that means several decision blocks
//   ("1 and 2"): there is no single answer to click, so no options are returned. Fewer than 2 options: none.
// - "← 추천" / "← recommended" anywhere on the option line marks the recommended one.
// - `question` is the last non-empty line before the first option, without a leading status marker.
export type ChoiceOption = { n: number; label: string; recommended: boolean };
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
			const label = m[2]!.replace(/←.*$/, "").replace(/\*\*/g, "").trim();
			if (!label) return { options: [] };
			if (!options.length) question = before;
			options.push({ n, label, recommended });
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
export type DecisionOption = { n: number; label: string; desc: string; rec: boolean };
type DecisionBlock = { title: string; options: DecisionOption[] };
const D_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*(←\s*(?:추천|recommended)|\(\s*(?:추천|recommended)\s*\))?\s*(?:\*\*)?\s*$/i;
const D_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
const D_CLOSE = /번호(?:로|를).*(?:답|알려)/;
export function parseDecisions(text: string): { question: string; blocks: DecisionBlock[] } {
	const lines = text.replace(/^\s*\[[^\]\n]+\][ \t]*/, "").split("\n");
	const blocks: DecisionBlock[] = [];
	let i = 0;
	let question = "";
	let cur: DecisionBlock | undefined;
	let fence = false;
	while (i < lines.length && !lines[i]!.trim()) i++;
	if (i < lines.length && !D_OPT.test(lines[i]!) && !D_HEAD.test(lines[i]!)) question = lines[i++]!.trim();
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const h = D_HEAD.exec(line);
		if (h) {
			cur = { title: h[1]!.trim(), options: [] };
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
		if (next !== undefined && next.trim() && !D_OPT.test(next) && !D_HEAD.test(next) && !D_CLOSE.test(next) && !FENCE.test(next)) {
			desc = next.trim();
			i++;
		}
		cur.options.push({ n, label: m[2]!.replace(/^\*+|\*+$/g, "").trim(), desc, rec: Boolean(m[3]) });
	}
	return { question, blocks: blocks.filter(b => b.options.length >= 2) };
}
