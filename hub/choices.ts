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
export type Choices = { question?: string; options: ChoiceOption[] };

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
