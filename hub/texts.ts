// Per-install overrides of the bot-facing texts of the message catalog (hub/i18n-*.ts: wake prompts, notice templates), kept in the
// custom layer <data dir>/custom/texts.json so an update never touches them. Read at use time (cached by file stamp), never in the repo.
//
//   { "<catalog key>": { "text": "...", "default": "<hash of the shipped text when written>" } }   (a plain string value has no check)
//
// A key whose shipped value is a function takes `{1}`, `{2}` ... for its arguments in order. The template of such a key is the shipped
// function called with those placeholders; `default` is the hash of that template (or of the shipped string). When the key is gone or the
// shipped text changed since the override was written, the override still applies and `reportTexts` names it once, so the owner's bot can
// re-check it (hub/main.ts wakes it at start). Only top-level string or function keys can be overridden; `locked` keys (the leads the
// gateway matches later) cannot.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";

export const TEXTS_FILE = "texts.json";
export type Entry = { text: string; default?: string };
export type Problem = { key: string; kind: "missing" | "stale" | "locked" };
type Fn = (...args: string[]) => string;

export const textsPath = (dataDir: string): string => join(dataDir, "custom", TEXTS_FILE);
const hash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 8);

/** The shipped text of `key` as an overridable template, or undefined when the key cannot be overridden. */
export function defaultTemplate(base: object, key: string, locked: ReadonlySet<string> = new Set()): string | undefined {
	if (locked.has(key) || !Object.hasOwn(base, key)) return undefined;
	const v = (base as Record<string, unknown>)[key];
	if (typeof v === "string") return v;
	if (typeof v !== "function") return undefined;
	try {
		const t = (v as Fn)(...Array.from({ length: v.length }, (_, i) => `{${i + 1}}`));
		return typeof t === "string" ? t : undefined;
	} catch {
		return undefined;
	}
}
export const defaultHash = (base: object, key: string, locked?: ReadonlySet<string>): string | undefined => {
	const t = defaultTemplate(base, key, locked);
	return t === undefined ? undefined : hash(t);
};

/** The entries of texts.json; a missing, unreadable or malformed file is an empty layer, a malformed entry is skipped. */
export function readTexts(dataDir: string): Record<string, Entry> {
	const out: Record<string, Entry> = {};
	let doc: unknown;
	try {
		doc = JSON.parse(readFileSync(textsPath(dataDir), "utf8"));
	} catch {
		return out;
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
	for (const [key, v] of Object.entries(doc)) {
		if (typeof v === "string") out[key] = { text: v };
		else if (v && typeof (v as Entry).text === "string") out[key] = { text: (v as Entry).text, ...(typeof (v as Entry).default === "string" ? { default: (v as Entry).default } : {}) };
	}
	return out;
}

const fill = (text: string, args: unknown[]): string => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n) - 1] ?? ""));

const cache = new WeakMap<object, { stamp: string; out: object }>();
/** `base` with the owner's overrides applied; `base` itself when there is none. Overrides of unknown or locked keys are ignored. */
export function applyTexts<T extends object>(base: T, dataDir: string, locked: ReadonlySet<string> = new Set()): T {
	const file = textsPath(dataDir);
	if (!existsSync(file)) return base;
	const st = statSync(file);
	const stamp = `${dataDir}|${st.mtimeMs}|${st.size}`;
	const hit = cache.get(base);
	if (hit?.stamp === stamp) return hit.out as T;
	const out: Record<string, unknown> = { ...base };
	for (const [key, e] of Object.entries(readTexts(dataDir))) {
		if (defaultTemplate(base, key, locked) === undefined) continue;
		out[key] = typeof (base as Record<string, unknown>)[key] === "function" ? (...args: unknown[]) => fill(e.text, args) : e.text;
	}
	cache.set(base, { stamp, out });
	return out as T;
}

/** Overrides that no longer fit the shipped catalog: key gone or locked, or the shipped default changed since the override was written. */
export function textProblems(base: object, dataDir: string, locked: ReadonlySet<string> = new Set()): Problem[] {
	const out: Problem[] = [];
	for (const [key, e] of Object.entries(readTexts(dataDir))) {
		if (locked.has(key)) out.push({ key, kind: "locked" });
		else if (defaultTemplate(base, key) === undefined) out.push({ key, kind: "missing" });
		else if (e.default !== undefined && e.default !== defaultHash(base, key)) out.push({ key, kind: "stale" });
	}
	return out;
}

const reportedFile = (dataDir: string) => join(dataDir, "texts-reported.json");
/** The problems not reported yet, as one line per key. A problem is reported once per state (a key gone, or one shipped text hash);
 *  fixing it and breaking it again, or another change of the shipped text, reports it again. */
export function reportTexts(base: object, dataDir: string, locked: ReadonlySet<string> = new Set()): string[] {
	let seen: Record<string, string> = {};
	try {
		seen = JSON.parse(readFileSync(reportedFile(dataDir), "utf8")) ?? {};
	} catch {
		// nothing reported yet
	}
	const now: Record<string, string> = {};
	const lines: string[] = [];
	for (const p of textProblems(base, dataDir, locked)) {
		now[p.key] = p.kind === "stale" ? `stale:${defaultHash(base, p.key)}` : p.kind;
		if (seen[p.key] === now[p.key]) continue;
		lines.push(`- ${p.key}: ${p.kind === "stale" ? "새 버전에서 기본 문구가 바뀌었어요" : p.kind === "locked" ? "고칠 수 없는 키예요" : "이 키가 새 버전에는 없어요"}`);
	}
	if (JSON.stringify(now) !== JSON.stringify(seen)) writeAtomic(reportedFile(dataDir), `${JSON.stringify(now, null, 1)}\n`);
	return lines;
}

/** Writes (or replaces) one override with the current default's hash. Throws for a key that cannot be overridden. */
export function setText(base: object, dataDir: string, key: string, text: string, locked: ReadonlySet<string> = new Set()): void {
	const d = defaultHash(base, key, locked);
	if (!d) throw new Error(`"${key}"는 고칠 수 있는 키가 아니에요`);
	const doc: Record<string, Entry | string> = {};
	for (const [k, e] of Object.entries(readTexts(dataDir))) doc[k] = e.default ? e : e.text;
	doc[key] = { text, default: d };
	writeAtomic(textsPath(dataDir), `${JSON.stringify(doc, null, 1)}\n`);
}
