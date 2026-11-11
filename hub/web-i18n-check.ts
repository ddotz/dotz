// The guard for the web app's screen text (design section 8):  bun hub/web-i18n-check.ts [--update]
// Hangul outside comments may only go down per file (hub/web-i18n-baseline.json), the ko and en catalogs must agree, and every key in
// code must exist and every key in a catalog must be used. It prints I18N_OK as its last line and exits 0 only when all of it holds.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogProblems, diskReader, loadAreas, type Catalog } from "./web-i18n.ts";

export type Baseline = {
	/** Hangul runs allowed outside comments, per file; `why` says what the text is (or "pending": not migrated yet). */
	files: Record<string, { count: number; why: string }>;
	/** Catalog keys whose en text may hold Hangul (a language's own name, say). */
	enHangulKeys: string[];
	/** Key prefixes that may sit in a catalog before any code uses them, with the reason. */
	unusedKeyPrefixes: Record<string, string>;
};
export type Result = { problems: string[]; counts: Record<string, number>; pending: number };

const HANGUL_RUN = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]+/g;
const IDENT = /[A-Za-z0-9_$]/;
const KEYWORDS_BEFORE_REGEX = ["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "yield", "await"];

/** JS or TS source without its comments. Strings, templates and regex literals are kept (a Korean string is text, not a comment). */
export function stripJs(src: string): string {
	let tail = "";
	const regexAllowed = (): boolean => {
		if (!tail) return true;
		const c = tail[tail.length - 1]!;
		if ("(,=:[!&|?{};+-*%<>~^".includes(c)) return true;
		const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(tail)?.[0];
		return !!word && KEYWORDS_BEFORE_REGEX.includes(word);
	};
	const scan = (from: number, inTemplate: boolean): { out: string; end: number } => {
		let out = "", i = from, depth = 0;
		const keep = (s: string) => { out += s; const t = s.replace(/\s+/g, ""); if (t) tail = (tail + t).slice(-12); };
		while (i < src.length) {
			const c = src[i]!, d = src[i + 1];
			if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
			if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const skipped = src.slice(i, e < 0 ? src.length : e + 2); out += skipped.includes("\n") ? "\n" : " "; i = e < 0 ? src.length : e + 2; continue; }
			if (c === '"' || c === "'") {
				let j = i + 1;
				while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
				keep(src.slice(i, j + 1)); i = j + 1; continue;
			}
			if (c === "`") {
				let j = i + 1, text = "`";
				while (j < src.length && src[j] !== "`") {
					if (src[j] === "\\") { text += src.slice(j, j + 2); j += 2; continue; }
					if (src[j] === "$" && src[j + 1] === "{") { const inner = scan(j + 2, true); text += "${" + inner.out + "}"; j = inner.end + 1; continue; }
					text += src[j]; j++;
				}
				keep(text + "`"); i = j + 1; continue;
			}
			if (c === "/" && regexAllowed()) {
				let j = i + 1, cls = false;
				while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
				j++;
				while (j < src.length && IDENT.test(src[j]!)) j++;
				keep(src.slice(i, j)); i = j; continue;
			}
			if (inTemplate) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) return { out, end: i }; depth--; } }
			keep(c); i++;
		}
		return { out, end: i };
	};
	return scan(0, false).out;
}
const stripCss = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, " ");
export function stripHtml(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, a: string, body: string, z: string) => a + stripJs(body) + z)
		.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a: string, body: string, z: string) => a + stripCss(body) + z);
}
const strip = (file: string, text: string): string => file.endsWith(".html") ? stripHtml(text) : file.endsWith(".css") ? stripCss(text) : stripJs(text);
export const hangulRuns = (text: string): number => text.match(HANGUL_RUN)?.length ?? 0;

const list = (dir: string, ext: string, skip: (f: string) => boolean = () => false): string[] => {
	try { return readdirSync(dir).filter(f => f.endsWith(ext) && !skip(f)).sort(); } catch { return []; }
};
/** Files whose Hangul is counted, as paths under the repo root. */
export function guardedFiles(root: string): string[] {
	const web = join(root, "web");
	return [
		...list(join(web, "js"), ".js").map(f => `web/js/${f}`),
		...list(join(web, "css"), ".css").map(f => `web/css/${f}`),
		...["custom.js", "sw.js", "index.html"].filter(f => existsSync(join(web, f))).map(f => `web/${f}`),
	];
}
const codeFiles = (root: string): string[] => [
	...guardedFiles(root).filter(f => !f.endsWith(".css")),
	...list(join(root, "hub"), ".ts", f => f.endsWith(".test.ts") || f.startsWith("web-i18n")).map(f => `hub/${f}`),
];

export function countHangul(root: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const f of guardedFiles(root)) { const n = hangulRuns(strip(f, readFileSync(join(root, f), "utf8"))); if (n) out[f] = n; }
	return out;
}

const KEY_LITERAL = /["'`]([a-z0-9_]+(?:\.[a-z0-9_]+)+)["'`]/g;
const KEY_CALL = /\b(?:TX|webText)\(\s*(?:(["'])([^"'\n]*)\1|(`))/g;
const KEY_TOKEN = /\{\{([a-z0-9_.]+)\}\}/g;

export function check(root: string, baseline: Baseline): Result {
	const problems: string[] = [];
	const counts = countHangul(root);

	for (const f of new Set([...Object.keys(counts), ...Object.keys(baseline.files)])) {
		const n = counts[f] ?? 0, allowed = baseline.files[f]?.count ?? 0;
		if (n > allowed) problems.push(`${f}: ${n} Hangul runs outside comments, ${allowed} allowed (use TX("key") with a web/i18n entry)`);
		else if (n < allowed) problems.push(`${f}: ${n} Hangul runs now, baseline says ${allowed}: run bun hub/web-i18n-check.ts --update`);
		if (allowed > 0 && !baseline.files[f]?.why.trim()) problems.push(`${f}: baseline needs a \`why\` (or "pending")`);
	}
	const pending = Object.values(baseline.files).filter(e => e.why === "pending").length;

	const reader = diskReader(join(root, "web"));
	let ko: Record<string, Catalog> = {}, en: Record<string, Catalog> = {};
	try { ko = loadAreas("ko", reader); en = loadAreas("en", reader); } catch (e) { problems.push((e as Error).message); }
	problems.push(...catalogProblems(ko, en, baseline.enHangulKeys));

	const keys = new Set(Object.values(ko).flatMap(c => Object.keys(c)));
	const literal = new Set<string>(), called = new Map<string, string>();
	for (const f of codeFiles(root)) {
		const text = strip(f, readFileSync(join(root, f), "utf8"));
		for (const m of text.matchAll(KEY_LITERAL)) literal.add(m[1]!);
		for (const m of text.matchAll(KEY_CALL)) {
			if (m[3]) problems.push(`${f}: TX( / webText( with a template literal; the key must be a plain string`);
			else called.set(m[2]!, f);
		}
		if (f.endsWith(".html") || f === "web/sw.js") for (const m of text.matchAll(KEY_TOKEN)) { literal.add(m[1]!); called.set(m[1]!, f); }
	}
	for (const [key, f] of called) if (!keys.has(key)) problems.push(`${f}: key ${key} is not in web/i18n/ko`);
	const free = Object.keys(baseline.unusedKeyPrefixes);
	for (const key of keys) if (!literal.has(key) && !free.some(p => key.startsWith(p))) problems.push(`web/i18n: key ${key} is not used anywhere in code`);

	return { problems, counts, pending };
}

/** The baseline with every allowance lowered to today's count (a file at 0 leaves it); never raises one, never adds a file. */
export function lowered(counts: Record<string, number>, baseline: Baseline): Baseline {
	const files: Baseline["files"] = {};
	for (const [f, e] of Object.entries(baseline.files)) { const n = Math.min(counts[f] ?? 0, e.count); if (n > 0) files[f] = { ...e, count: n }; }
	return { ...baseline, files };
}
/** First baseline: every file that holds Hangul today, all pending. */
export const firstBaseline = (counts: Record<string, number>): Baseline => ({
	files: Object.fromEntries(Object.entries(counts).map(([f, count]) => [f, { count, why: "pending" }])),
	enHangulKeys: [],
	unusedKeyPrefixes: {},
});

if (import.meta.main) {
	const root = join(import.meta.dir, ".."), path = join(import.meta.dir, "web-i18n-baseline.json");
	let baseline: Baseline | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Baseline : undefined;
	if (process.argv.includes("--update")) {
		const counts = countHangul(root);
		baseline = baseline ? lowered(counts, baseline) : firstBaseline(counts);
		writeFileSync(`${path}.tmp`, `${JSON.stringify(baseline, null, 2)}\n`);
		renameSync(`${path}.tmp`, path);
	}
	if (!baseline) { console.log("hub/web-i18n-baseline.json is missing: run bun hub/web-i18n-check.ts --update"); process.exit(1); }
	const r = check(root, baseline);
	for (const p of r.problems) console.log(`FAIL ${p}`);
	if (r.problems.length) process.exit(1);
	console.log(`${Object.keys(r.counts).length} files still hold Hangul, ${r.pending} pending`);
	console.log("I18N_OK");
}
