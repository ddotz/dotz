// The screen table SCREENS in web/js/03-screens.js, read from its text: one row per line, `  <id>: { key: value, ... },`, data only.
// hub/ui-surfaces.ts (the view sites) and site/demo-views.ts (the demo's sections) read the screen list here instead of each scraping its own.
export type ScreenRow = { id: string; tab?: string; nav?: number; sub?: boolean; up?: string; title?: string; ic?: string; html?: boolean; relay?: boolean; under?: string; palette?: boolean };

const ROW = /^ {2}([\w$]+): \{ (.*) \},$/;
// One field: a string, a number, true or false, or TX("key") (title keeps the i18n key).
const FIELD = /(\w+): (?:TX\("([^"]*)"\)|"([^"]*)"|(\d+)|(true|false))/g;

// The rows in table order, or null when the text has no `const SCREENS = {` table. A row that is not one line throws, naming it.
export function readScreens(js: string): ScreenRow[] | null {
	const body = /\bconst SCREENS = \{\n([\s\S]*?)\n\};/.exec(js)?.[1];
	if (body === undefined) return null;
	return body.split("\n").map(line => {
		const m = ROW.exec(line);
		if (!m) throw new Error(`web/js/03-screens.js: a SCREENS row is not one line of "  id: { ... },": ${line.trim()}`);
		const row: Record<string, string | number | boolean> = { id: m[1]! };
		for (const f of m[2]!.matchAll(FIELD)) row[f[1]!] = f[2] ?? f[3] ?? (f[4] !== undefined ? Number(f[4]) : f[5] === "true");
		return row as ScreenRow;
	});
}
