import { readFileSync } from "node:fs";

const RULE =
	"Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const LANES = /(\d+) lanes? on `verify-[^`<>\s]+` at the PR head/;
const REGRESSION = "Regression lane against trunk.";
const SUB_BLOCKS = [
	"Depends on.",
	"Files.",
	"Build.",
	"You see.",
	"Verify, unit.",
	"Verify, live.",
	"Verify, perf.",
	"Review gate.",
	"Merge.",
];
const PROGRAM_H3 = ["Arm the program", "Spawn owners", "PR mechanics", "Verdict and merge", "Boot recipe"];
const PROGRAM_MARKERS = ["skill://ulw/playbooks/", "loop mode", "status message"];
const HOW_TO_READ_MARKERS = [
	"One box is one unit of work",
	"names the evidence",
	"Check a box only when its evidence exists",
	"skill://ulw/playbooks/",
	RULE,
];
const PERF_ITEMS = ["Metric.", "Probe.", "Baseline.", "Rule."];
const BOX = /^( *)- \[[ xX]\] (.*)$/;
const LIST_ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])( +)\S/;

interface Line {
	n: number;
	text: string;
	code: boolean;
	nested: boolean;
}
interface Section {
	title: string;
	n: number;
	body: Line[];
}
interface Head {
	name: string;
	n: number;
	rest: string;
	lines: Line[];
}
interface Fence {
	char: string;
	length: number;
	column: number;
}

const file = process.argv[2];
if (!file) {
	console.error("Usage: bun check-plan.ts <plan.md>");
	process.exit(2);
}

const raw = readFileSync(file, "utf8").split(/\r?\n/);
const problems: string[] = [];
const fail = (line: number, message: string) => problems.push(`${file}:${line}: ${message}`);

let start = 0;
if (raw[0] === "---") {
	start = raw.indexOf("---", 1) + 1;
}

const openingFence = (text: string, column: number): Fence | null => {
	const match = text.match(/^( *)(`{3,}|~{3,})(.*)$/);
	if (!match || match[1].length > column + 3 || (match[2][0] === "`" && match[3].includes("`"))) return null;
	return { char: match[2][0], length: match[2].length, column };
};
const closingFence = (text: string, opening: Fence): boolean => {
	const match = text.match(/^( *)(`+|~+)[ \t]*$/);
	return Boolean(
		match && match[1].length <= opening.column + 3 && match[2][0] === opening.char && match[2].length >= opening.length,
	);
};

const lines: Line[] = [];
let fence: Fence | null = null;
let column = 0;
let top: number | null = null;
for (let i = start; i < raw.length; i++) {
	const text = raw[i];
	const n = i + 1;
	let code = Boolean(fence);
	let closing = false;
	if (fence && closingFence(text, fence)) {
		code = false;
		closing = true;
		fence = null;
	} else if (!fence) {
		fence = openingFence(text, column);
		code = Boolean(fence);
	}
	let nested = false;
	if (!code && !closing && text.trim() !== "") {
		const indent = text.length - text.trimStart().length;
		const item = text.match(LIST_ITEM);
		const box = text.match(BOX);
		if (item) column = item[1].length + text.trimStart().search(/\s/) + item[2].length;
		else if (indent < column) column = 0;
		if (box) {
			nested = top !== null && box[1].length >= top + 2;
			if (!nested) top = box[1].length;
		} else if (top !== null && indent < top + 2) top = null;
	}
	lines.push({ n, text, code, nested });
	if (code) continue;
	const prose = text
		.replace(/(?<!`)(`+)(?!`)(.*?)(?<!`)\1(?!`)/g, "`")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\]\([^)]*\)/g, "]");
	if (/[\u2013\u2014]/.test(prose)) fail(n, "long dash");
	if (/[\u2018\u2019\u201c\u201d]/.test(prose)) fail(n, "curly quote");
	if (/: \S/.test(prose)) fail(n, "mid-sentence colon");
}

const sections: Section[] = [];
for (const l of lines) {
	if (!l.code && l.text.startsWith("## ")) sections.push({ title: l.text.slice(3).trim(), n: l.n, body: [] });
	else if (sections.length) sections[sections.length - 1].body.push(l);
}
const find = (title: string) => sections.find((s) => s.title === title);
const bodyText = (s: Section) => s.body.map((l) => l.text).join("\n");
const boxes = (ls: Line[]) =>
	ls.flatMap((l) => {
		const m = l.code || l.nested ? null : l.text.match(BOX);
		return m ? [{ n: l.n, text: m[2] }] : [];
	});

const h1 = lines.findIndex((l) => !l.code && l.text.startsWith("# "));
if (h1 === -1) fail(1, "no H1 title");
const howToRead = find("How to read this");
if (!howToRead) fail(1, 'no "## How to read this" section');
if (h1 !== -1 && howToRead) {
	const intro = lines.slice(h1 + 1).filter((l) => l.n < howToRead.n && l.text.trim() !== "");
	if (intro.length >= 10) fail(lines[h1].n, `intro is ${intro.length} lines, under ten required`);
	for (const marker of HOW_TO_READ_MARKERS) {
		if (!bodyText(howToRead).includes(marker)) fail(howToRead.n, `How to read this lacks "${marker}"`);
	}
}

const program = find("Program checklist");
if (!program) fail(1, 'no "## Program checklist" section');
else {
	const h3s = program.body.filter((l) => !l.code && l.text.startsWith("### ")).map((l) => l.text.slice(4).trim());
	let cursor = 0;
	for (const name of PROGRAM_H3) {
		const at = h3s.findIndex((t, i) => i >= cursor && t.startsWith(name));
		if (at === -1) fail(program.n, `Program checklist lacks "### ${name}" in order`);
		else cursor = at + 1;
	}
	for (const marker of PROGRAM_MARKERS) {
		if (!bodyText(program).includes(marker)) fail(program.n, `Program checklist lacks "${marker}"`);
	}
}

const close = find("Close the program");
if (!close) fail(1, 'no "## Close the program" section');
const programIndex = program ? sections.indexOf(program) : -1;
const closeIndex = close ? sections.indexOf(close) : -1;
const prSections = programIndex === -1 || closeIndex === -1 ? [] : sections.slice(programIndex + 1, closeIndex);
if (prSections.length === 0) fail(1, "no PR sections between Program checklist and Close the program");

const report: string[] = [];
for (const pr of prSections) {
	const heads: Head[] = [];
	for (const l of pr.body) {
		if (l.code) continue;
		const m = l.text.match(/^\*\*([^*]+)\*\*(.*)$/);
		if (m && SUB_BLOCKS.includes(m[1])) heads.push({ name: m[1], n: l.n, rest: m[2].trim(), lines: [] });
		else if (heads.length) heads[heads.length - 1].lines.push(l);
	}
	const names = heads.map((h) => h.name);
	if (names.join("|") !== SUB_BLOCKS.join("|")) {
		fail(pr.n, `${pr.title}: sub-blocks are [${names.join(", ")}], expected [${SUB_BLOCKS.join(", ")}]`);
	}
	const block = (name: string) => heads.find((h) => h.name === name);
	const counts: Record<string, number> = {};
	for (const h of heads) counts[h.name] = boxes(h.lines).length;

	const depends = block("Depends on.");
	if (depends && depends.rest === "") fail(depends.n, `${pr.title}: Depends on names nothing`);
	for (const name of ["Files.", "Build.", "You see.", "Verify, unit.", "Merge."]) {
		const b = block(name);
		if (b && boxes(b.lines).length === 0) fail(b.n, `${pr.title}: ${name} has no box`);
	}
	for (const name of ["Verify, unit.", "Verify, live.", "Verify, perf."]) {
		const b = block(name);
		if (b && !b.rest.startsWith(RULE)) fail(b.n, `${pr.title}: ${name} does not open with the rule`);
	}

	const live = block("Verify, live.");
	if (live) {
		const header = LANES.exec(live.rest);
		const lanes = boxes(live.lines).map((b) => ({ ...b, m: b.text.match(/^Lane (\d+)\. /) }));
		if (!header) {
			fail(live.n, `${pr.title}: Verify, live lacks "<N> lanes on \`verify-<app>\` at the PR head" with the app filled in`);
		} else {
			const count = Number(header[1]);
			const expected = Array.from({ length: count }, (_, i) => i + 1).join(",");
			const numbers = lanes.flatMap((b) => (b.m ? [Number(b.m[1])] : [])).join(",");
			if (count < 1) fail(live.n, `${pr.title}: lane count is ${count}, at least 1 required`);
			else if (numbers !== expected) fail(live.n, `${pr.title}: lanes are [${numbers}], expected 1 to ${count} in order`);
		}
		for (const lane of lanes) {
			if (!lane.m) fail(lane.n, `${pr.title}: live box is not a lane`);
			else if (!/Save `[^`]+`/.test(lane.text)) fail(lane.n, `${pr.title}: lane ${lane.m[1]} names no artifact path`);
			else if (!lane.text.includes("Pass when")) fail(lane.n, `${pr.title}: lane ${lane.m[1]} has no pass predicate`);
			else if (lane.m[1] === "1" && !lane.text.startsWith(`Lane 1. ${REGRESSION}`)) {
				fail(lane.n, `${pr.title}: lane 1 is not the "${REGRESSION}"`);
			}
		}
	}

	const perf = block("Verify, perf.");
	if (perf) {
		const items = boxes(perf.lines).map((b) => b.text.split(" ")[0]);
		if (items.join("|") !== PERF_ITEMS.join("|")) {
			fail(perf.n, `${pr.title}: perf boxes are [${items.join(", ")}], expected [${PERF_ITEMS.join(", ")}]`);
		}
	}

	const gate = block("Review gate.");
	if (gate) {
		const gateBoxes = boxes(gate.lines);
		if (gate.rest.startsWith("None.")) {
			if (gateBoxes.length) fail(gate.n, `${pr.title}: Review gate says None but has boxes`);
		} else {
			const text = gate.lines.map((l) => l.text).join("\n");
			if (gateBoxes.length === 0) fail(gate.n, `${pr.title}: Review gate has no box`);
			for (const word of ["screenshot", "video", "operator"]) {
				if (!text.includes(word)) fail(gate.n, `${pr.title}: Review gate lacks "${word}"`);
			}
		}
	}

	const total = boxes(pr.body).length;
	const cells = SUB_BLOCKS.filter((s) => s !== "Depends on.").map(
		(s) => `${s.replace(/[ ,.]+/g, "-").replace(/-$/, "").toLowerCase()}=${counts[s] ?? 0}`,
	);
	report.push(`${pr.title}  boxes=${total}  ${cells.join(" ")}`);
}

if (closeIndex !== -1) {
	const tail = sections.slice(closeIndex + 1);
	for (const s of tail) {
		if (!s.title.startsWith("Appendix")) fail(s.n, `"## ${s.title}" after Close the program is not an appendix`);
	}
	if (!tail.some((s) => s.title.includes("Prototype evidence"))) {
		fail(close ? close.n : 1, 'no "## Appendix ... Prototype evidence" section');
	}
}

for (const line of report) console.log(line);
console.log(`${prSections.length} PR sections, ${problems.length} problems`);
for (const p of problems) console.error(p);
process.exit(problems.length ? 1 : 0);
