// The web app's screen text: web/i18n/<lang>/<area>.json (a flat key -> text or plural forms), merged per language, injected into
// /app.js as `const I18N_LANG, I18N` and used by web/js/00-i18n.js (TX). Pure on purpose: no config import, so site/build-demo.ts,
// the check and the tests load it without a running gateway. docs/web-app-design.md has the design.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Value = string | Record<string, string>;
export type Catalog = Record<string, Value>;
/** What the page is drawn from: the language of the catalog that is really loaded, and that catalog. */
export type View = { lang: string; catalog: Catalog };
/** Where area files come from: the working tree, the committed snapshot or `git show`. */
export type Reader = { areas(lang: string): string[]; read(lang: string, area: string): string | undefined };

const WEB = join(import.meta.dir, "..", "web");
const JS_SOURCE = join(WEB, "js", "00-i18n.js");

export const diskReader = (webDir = WEB): Reader => ({
	areas: lang => { try { return readdirSync(join(webDir, "i18n", lang)).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort(); } catch { return []; } },
	read: (lang, area) => { try { return readFileSync(join(webDir, "i18n", lang, `${area}.json`), "utf8"); } catch { return undefined; } },
});
/** Reader over files keyed by their path under web/ ("i18n/ko/shell.json"). */
export const mapReader = (files: ReadonlyMap<string, string>): Reader => ({
	areas: lang => [...files.keys()].flatMap(p => { const m = new RegExp(`^i18n/${lang}/([^/]+)\\.json$`).exec(p); return m ? [m[1]!] : []; }).sort(),
	read: (lang, area) => files.get(`i18n/${lang}/${area}.json`),
});

/** One language's area files, each parsed. Throws with the file name on broken JSON. */
export function loadAreas(lang: string, reader: Reader): Record<string, Catalog> {
	const out: Record<string, Catalog> = {};
	for (const area of reader.areas(lang)) {
		const text = reader.read(lang, area);
		if (text === undefined) continue;
		try { out[area] = JSON.parse(text) as Catalog; } catch (e) { throw new Error(`web/i18n/${lang}/${area}.json: ${(e as Error).message}`); }
	}
	return out;
}
export const loadCatalog = (lang: string, reader: Reader): Catalog => Object.assign({}, ...Object.values(loadAreas(lang, reader)));

// The one seam for generated catalogs (design section 6): a provider hands back the catalog of a language that is neither ko nor en.
export type CatalogProvider = (lang: string) => Catalog | undefined;
let provider: CatalogProvider | undefined;
let revision = 0;
/** Changes whenever the provider or the catalogs it hands out change; cache keys carry it. */
export const catalogRevision = (): number => revision;
export const setCatalogProvider = (fn: CatalogProvider | undefined): void => { provider = fn; revision++; };

// The owner's own words (`web:<key>` in custom/texts.json, hub/texts.ts webWords): applied over whatever catalog the page gets, ko and en too.
// `stamp` changes with the file; a word whose key is unknown or whose placeholder names differ from the catalog's is not used.
export type OwnerWords = { stamp: string; words: Record<string, string> };
let ownerWords: (() => OwnerWords) | undefined;
export const setOwnerWords = (fn: (() => OwnerWords) | undefined): void => { ownerWords = fn; revision++; };
export const ownerStamp = (): string => ownerWords?.().stamp ?? "";
export const ownerWordProblem = (catalog: Catalog, key: string, text: string): "missing" | "broken" | undefined =>
	catalog[key] === undefined ? "missing" : !text.trim() || placeholders(text).join() !== placeholders(catalog[key]!).join() ? "broken" : undefined;
function withOwnerWords(view: View): View {
	const words = ownerWords?.().words ?? {};
	const use = Object.entries(words).filter(([k, t]) => !ownerWordProblem(view.catalog, k, t));
	return use.length ? { lang: view.lang, catalog: { ...view.catalog, ...Object.fromEntries(use) } } : view;
}

/** The language the page really shows: ko stays ko, anything else is en until a provider has a catalog for it. */
export function resolveView(code: string, reader: Reader): View {
	const norm = code.trim().toLowerCase().replace(/_/g, "-") || "ko";
	const base = norm.split("-")[0]!;
	if (base === "ko") return withOwnerWords({ lang: "ko", catalog: loadCatalog("ko", reader) });
	const made = base === "en" ? undefined : provider?.(norm);
	return withOwnerWords(made ? { lang: norm, catalog: made } : { lang: "en", catalog: loadCatalog("en", reader) });
}

export const injectedConsts = (view: View): string => `const I18N_LANG = ${JSON.stringify(view.lang)}, I18N = ${JSON.stringify(view.catalog)};`;

const escHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const TOKEN = /\{\{([a-z0-9_.]+)\}\}/g;
const textOf = (v: Value | undefined): string | undefined => typeof v === "string" ? v : v?.other;
const fill = (text: string, catalog: Catalog, esc: (s: string) => string): string => text.replace(TOKEN, (m, k: string) => { const t = textOf(catalog[k]); return t === undefined ? m : esc(t); });
/** index.html: `<html lang>` and every `{{key}}` token, HTML-escaped. */
export const fillPage = (html: string, lang: string, catalog: Catalog = loadCatalog(lang, diskReader())): string =>
	fill(html.replace(/<html lang="[^"]*">/, `<html lang="${escHtml(lang)}">`), catalog, escHtml);
/** sw.js: every `{{key}}` token inside a double-quoted string, escaped for it. */
export const fillScript = (js: string, catalog: Catalog): string => fill(js, catalog, s => JSON.stringify(s).slice(1, -1));

const i18nSource = (): string => readFileSync(JS_SOURCE, "utf8");
/** `const I18N_LANG…, I18N…;` + web/js/00-i18n.js, for a test that evaluates source cut out of another web/js file. */
export const i18nPrelude = (lang = "ko", reader: Reader = diskReader()): string => `${injectedConsts(resolveView(lang, reader))}\n${i18nSource()}\n`;

type Fns = { TX: (key: string, vars?: Record<string, unknown>) => string; txInLang: (s: string) => boolean };
const fns = new WeakMap<View, Fns>();
/** The page's own formatter (web/js/00-i18n.js) evaluated for one view: server and page share one implementation. */
export function formatter(view: View): Fns {
	let f = fns.get(view);
	if (!f) { f = new Function(`${injectedConsts(view)}\n${i18nSource()}\nreturn { TX, txInLang };`)() as Fns; fns.set(view, f); }
	return f;
}
let appView: (() => View) | undefined;
let fallback: View | undefined;
/** The view `webText` uses when none is passed; hub/webapp.ts points it at the language the page is served in. */
export const setWebView = (fn: (() => View) | undefined): void => { appView = fn; };
export const webText = (key: string, vars?: Record<string, unknown>, view?: View): string =>
	formatter(view ?? appView?.() ?? (fallback ??= resolveView("ko", diskReader()))).TX(key, vars);

// ---- check rules (hub/web-i18n-check.ts runs them) ----
export const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
const KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const PLURAL_FORMS = new Set(["zero", "one", "two", "few", "many", "other"]);
const forms = (v: Value): string[] => typeof v === "string" ? [v] : Object.values(v);
export const placeholders = (v: Value): string[] => [...new Set(forms(v).flatMap(t => [...t.matchAll(/\{(\w+)(?:\+[^/{}]+\/[^{}]+)?\}/g)].map(m => m[1]!)))].sort();

function valueProblem(v: unknown): string | undefined {
	if (typeof v === "string") return v.trim() ? undefined : "empty value";
	if (!v || typeof v !== "object" || Array.isArray(v)) return "value must be a string or an object of plural forms";
	const o = v as Record<string, unknown>;
	if (typeof o.other !== "string") return "plural forms need `other`";
	for (const [f, t] of Object.entries(o)) {
		if (!PLURAL_FORMS.has(f)) return `unknown plural form ${f}`;
		if (typeof t !== "string" || !t.trim()) return `empty plural form ${f}`;
	}
	return undefined;
}

/** Problems between the ko and en catalogs (files, keys, values, placeholders, particles, Hangul in en). `enHangul`: keys whose en text may hold Hangul. */
export function catalogProblems(ko: Record<string, Catalog>, en: Record<string, Catalog>, enHangul: readonly string[] = []): string[] {
	const out: string[] = [];
	const langs: [string, Record<string, Catalog>][] = [["ko", ko], ["en", en]];
	for (const area of new Set([...Object.keys(ko), ...Object.keys(en)])) {
		if (!ko[area]) out.push(`web/i18n/en/${area}.json has no ko twin`);
		if (!en[area]) out.push(`web/i18n/ko/${area}.json has no en twin`);
	}
	for (const [lang, areas] of langs) {
		const seen = new Map<string, string>();
		for (const [area, cat] of Object.entries(areas)) for (const [key, v] of Object.entries(cat)) {
			const where = `web/i18n/${lang}/${area}.json ${key}`;
			if (!KEY.test(key)) out.push(`${where}: key must be lowercase dotted words`);
			if (seen.has(key)) out.push(`${where}: key also in ${seen.get(key)}.json`);
			seen.set(key, area);
			const bad = valueProblem(v);
			if (bad) { out.push(`${where}: ${bad}`); continue; }
		}
	}
	for (const [area, kc] of Object.entries(ko)) {
		const ec = en[area];
		if (!ec) continue;
		for (const key of Object.keys(kc)) if (!(key in ec)) out.push(`web/i18n/en/${area}.json lacks ${key}`);
		for (const key of Object.keys(ec)) if (!(key in kc)) out.push(`web/i18n/ko/${area}.json lacks ${key}`);
		for (const key of Object.keys(kc)) {
			const k = kc[key]!, e = ec[key];
			if (e === undefined || valueProblem(k) || valueProblem(e)) continue;
			if (placeholders(k).join() !== placeholders(e).join()) out.push(`${area} ${key}: placeholders differ (ko {${placeholders(k)}} en {${placeholders(e)}})`);
			if (forms(e).some(t => /\{\w+\+/.test(t))) out.push(`web/i18n/en/${area}.json ${key}: Korean particle form is for ko only`);
			if (forms(e).some(t => HANGUL.test(t)) && !enHangul.includes(key)) out.push(`web/i18n/en/${area}.json ${key}: Hangul in an en value`);
		}
	}
	return out;
}
