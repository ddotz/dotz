// Per-install settings and the user's style file of the reply-drafts feature (DESIGN.md). Everything personal lives under
// <DATA_DIR>/custom/reply-drafts/; nothing about a person is in the repo. Pure fs; never imports hub/config.ts (it loads the
// gateway config at import time), so the data dir is read from DOTZ_DIR on every call and tests can point it anywhere.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReplyKind, ReplyStyle } from "../../../hub/reply-draft.ts";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const REPO_FEATURE = join(import.meta.dir, "..");
const root = () => join(dataDir(), "custom", "reply-drafts");

export const paths = {
	config: () => join(root(), "config.json"),
	style: () => join(root(), "style.md"),
	drafts: () => join(root(), "drafts.json"),
	snsTone: () => join(dataDir(), "custom", "sns", "tone.md"),
	inbox: () => join(dataDir(), "inbox.jsonl"),
	personalFeature: () => join(dataDir(), "features", "reply-drafts", "feature.md"),
};

export function writeAtomic(file: string, text: string, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, file);
}

export type Settings = { enabled: boolean; auto: boolean; senders: { only: string[]; skip: string[] }; model?: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim()) : []);

// A missing or unreadable config is "off": the feature does nothing until an install turns it on.
export function loadSettings(): Settings {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(readFileSync(paths.config(), "utf8")) ?? {};
	} catch {
		return { enabled: false, auto: true, senders: { only: [], skip: [] } };
	}
	return {
		enabled: raw.enabled === true,
		auto: raw.auto !== false,
		senders: { only: strings(raw.senders?.only), skip: strings(raw.senders?.skip) },
		...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
	};
}

export function saveSettings(patch: Partial<Settings>): Settings {
	const next = { ...loadSettings(), ...patch };
	writeAtomic(paths.config(), `${JSON.stringify(next, null, 2)}\n`, 0o644);
	return next;
}

export const HEADINGS = { rules: "## 말투", samples: "## 예시", corrections: "## 고친 점", forbidden: "## 금지" } as const;

export function bullets(md: string, heading: string): string[] {
	const lines = md.split("\n");
	const start = lines.findIndex(l => l.trim() === heading);
	if (start < 0) return [];
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^## /.test(line)) break;
		const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
		if (m) out.push(m[1]!);
	}
	return out;
}

// Replaces one section (up to the next `## ` heading) with bullets and keeps everything else; appends it when missing.
export function setSection(existing: string, heading: string, items: string[]): string {
	const section = `${heading}\n\n${items.map(e => `- ${e}`).join("\n")}\n`;
	const lines = existing.split("\n");
	const start = lines.findIndex(l => l.trim() === heading);
	if (start < 0) return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${section}`;
	const next = lines.findIndex((l, i) => i > start && /^## /.test(l));
	const tail = next < 0 ? "" : `\n${lines.slice(next).join("\n")}`;
	return `${lines.slice(0, start).join("\n")}${start ? "\n" : ""}${section}${tail}`;
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const unique = (xs: string[]) => [...new Set(xs)];

export function loadStyle(kind: ReplyKind): ReplyStyle {
	const md = read(paths.style());
	const own = bullets(md, HEADINGS.samples);
	const samples = kind === "comment" ? unique([...own, ...bullets(read(paths.snsTone()), HEADINGS.samples)]) : own;
	return { samples, rules: bullets(md, HEADINGS.rules), corrections: bullets(md, HEADINGS.corrections), forbidden: bullets(md, HEADINGS.forbidden) };
}

export function writeExamples(examples: string[]): void {
	writeAtomic(paths.style(), setSection(read(paths.style()), HEADINGS.samples, examples));
}

// The owner's change request, verbatim and dated, so every later draft follows it.
export function recordCorrection(change: string, now: Date): void {
	const md = read(paths.style());
	const line = `${now.toISOString().slice(0, 10)}: ${change.replace(/\s+/g, " ").trim()}`;
	writeAtomic(paths.style(), setSection(md, HEADINGS.corrections, [...bullets(md, HEADINGS.corrections), line]));
}
