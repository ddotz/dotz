// An outside style guide (a markdown file a plugin's session wrote drafts from, like a company mail's) moved into the reply engine's one store:
// its rule bullets become ledger records of the app's tone profile and its examples the profile's samples, so the same checks, judge and
// lessons reach it. Both files are copied to ledger-backup/import/<at>/ first; `undoImport` puts them back. The guide itself is left in place.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { addRecord, readLedger, setState } from "./ledger.ts";
import { paths, toneFile, writeAtomic, writeExamples } from "./settings.ts";
import { dataDir, HEADINGS, validApp } from "./tone-key.ts";

const EXAMPLE = /예시|example/i;
const importDir = (dir: string): string => join(dirname(paths.ledger(dir)), "ledger-backup", "import");
const stamp = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");

/** The guide's rule lines (every `- ` bullet outside an example section) and its examples (each `> ` block of an example section, one line). */
export function styleGuide(md: string): { rules: string[]; examples: string[] } {
	const rules: string[] = [], examples: string[] = [];
	let inExample = false, block: string[] = [];
	const flush = () => {
		if (block.length) examples.push(block.join(" "));
		block = [];
	};
	for (const line of md.split("\n")) {
		const l = line.trim();
		if (/^#{1,6} /.test(l)) {
			flush();
			inExample = /^## /.test(l) && EXAMPLE.test(l);
			continue;
		}
		if (inExample && l.startsWith(">")) {
			const text = l.replace(/^>\s?/, "").trim();
			if (text) block.push(text);
			continue;
		}
		if (inExample) {
			flush();
			continue;
		}
		const bullet = /^[-*]\s+(.+)$/.exec(l)?.[1]?.trim();
		if (bullet) rules.push(bullet);
	}
	flush();
	return { rules, examples };
}

/** Moves the guide `file` into the tone profile of `app`: rules as "tone" records at `{ app }` (ref `import:<at>`), examples as its `## 예시` (kept ones first). Counts only. */
export function importStyle(file: string, app: string, dir: string = dataDir(), now: Date = new Date()): { at: string; rules: number; samples: number } {
	if (!validApp(app)) throw new Error(`앱 이름은 영문 소문자·숫자·-만 쓸 수 있어요: ${app}`);
	const md = readFileSync(file, "utf8");
	const { rules, examples } = styleGuide(md);
	const at = stamp(now), backup = join(importDir(dir), at), tone = toneFile({ app });
	writeAtomic(join(backup, "guide", basename(file)), md);
	writeAtomic(join(backup, "meta.json"), `${JSON.stringify({ file, app, tone, toneExisted: existsSync(tone) }, null, 1)}\n`);
	if (existsSync(tone)) writeAtomic(join(backup, "tone.md"), readFileSync(tone));
	let added = 0;
	for (const text of rules) added += addRecord({ text, kind: "tone", scope: { app }, by: "import", ref: `import:${at}`, at: now }, dir).added ? 1 : 0;
	if (examples.length) writeExamples({ app }, [...new Set([...currentSamples(tone), ...examples])]);
	return { at, rules: added, samples: examples.length };
}

const currentSamples = (tone: string): string[] => {
	const lines = existsSync(tone) ? readFileSync(tone, "utf8").split("\n") : [], start = lines.findIndex(l => l.trim() === HEADINGS.samples);
	if (start < 0) return [];
	const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
	return lines.slice(start + 1, end < 0 ? undefined : end).filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
};

export const imports = (dir: string = dataDir()): string[] => (existsSync(importDir(dir)) ? readdirSync(importDir(dir)).sort() : []);

/** Undoes import `at` (the newest when absent): its records go off and the tone file is put back as it was (removed when it did not exist). The import undone, or undefined when there is none. */
export function undoImport(at: string | undefined, dir: string = dataDir()): string | undefined {
	const which = at ?? imports(dir).at(-1);
	const backup = which && join(importDir(dir), which);
	if (!backup || !existsSync(join(backup, "meta.json"))) return undefined;
	const meta = JSON.parse(readFileSync(join(backup, "meta.json"), "utf8")) as { tone: string; toneExisted: boolean };
	setState(readLedger(dir).filter(r => r.ref === `import:${which}` && r.state === "on").map(r => r.id), "off", undefined, dir);
	if (meta.toneExisted) writeAtomic(meta.tone, readFileSync(join(backup, "tone.md")));
	else rmSync(meta.tone, { force: true });
	rmSync(backup, { recursive: true, force: true });
	return which;
}
