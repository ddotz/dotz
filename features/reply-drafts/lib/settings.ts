// Per-install settings and the user's style file of the reply-drafts feature (DESIGN.md). Everything personal lives under
// <DATA_DIR>/custom/reply-drafts/; nothing about a person is in the repo. Pure fs; never imports hub/config.ts (it loads the
// gateway config at import time), so the data dir is read from DOTZ_DIR on every call and tests can point it anywhere.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReplyStyle } from "../../../hub/reply-draft.ts";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const REPO_FEATURE = join(import.meta.dir, "..");
const root = () => join(dataDir(), "custom", "reply-drafts");

export const paths = {
	config: () => join(root(), "config.json"),
	legacyStyle: () => join(root(), "style.md"), // layout of the first version: read as the mail app profile until tone/mail.md exists
	toneDir: () => join(root(), "tone"),
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

// `enabled` is the feature switch; `apps` has one switch per source (mail, youtube, instagram, ...), every source off until turned on.
// A config from before `apps` existed has no apps.mail: mail then follows the top-level `auto` (kept valid, and kept in sync by setApp).
export type Settings = { enabled: boolean; auto: boolean; apps: Record<string, { auto: boolean }>; senders: { only: string[]; skip: string[] }; model?: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim()) : []);

// A missing or unreadable config is "off": the feature does nothing until an install turns it on.
export function loadSettings(): Settings {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(readFileSync(paths.config(), "utf8")) ?? {};
	} catch {
		return { enabled: false, auto: true, apps: {}, senders: { only: [], skip: [] } };
	}
	const apps: Settings["apps"] = {};
	for (const [app, v] of Object.entries(raw.apps && typeof raw.apps === "object" ? (raw.apps as Record<string, any>) : {})) if (validApp(app)) apps[app] = { auto: v?.auto === true };
	return {
		enabled: raw.enabled === true,
		auto: raw.auto !== false,
		apps,
		senders: { only: strings(raw.senders?.only), skip: strings(raw.senders?.skip) },
		...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
	};
}

export function saveSettings(patch: Partial<Settings>): Settings {
	const next = { ...loadSettings(), ...patch };
	writeAtomic(paths.config(), `${JSON.stringify(next, null, 2)}\n`, 0o644);
	return next;
}

// Whether a source drafts on its own: the feature is on and that source's own switch is on.
export const appOn = (s: Settings, app: string): boolean => s.enabled && (s.apps[app]?.auto ?? (app === "mail" ? s.auto : false));

// Turns one source on or off. Mail's current state is written down first, so switching another source on never switches mail on by
// way of the old top-level `auto`; turning a source on also turns the feature switch on.
export function setApp(app: string, auto: boolean): Settings {
	const s = loadSettings();
	const apps = { ...s.apps, mail: { auto: appOn(s, "mail") }, [app]: { auto } };
	return saveSettings({ apps, ...(app === "mail" ? { auto } : {}), ...(auto ? { enabled: true } : {}) });
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

// Tone store: <DATA_DIR>/custom/reply-drafts/tone/install.md (whole install), <app>.md (mail, youtube, kakao, ...) and
// <app>/<room>.md (one conversation of a messenger). Each file has the four sections above.
export type ToneKey = { app: string; room?: string };
export type ToneLevel = "room" | "app" | "install";
export type LoadedStyle = ReplyStyle & { samplesFrom: ToneLevel | "legacy" | "none" };

export const INSTALL = "install";
const APP_ID = /^[a-z0-9-]+$/;

export function validApp(app: string): boolean {
	return APP_ID.test(app);
}

// A room id as a file name: only [A-Za-z0-9_-] survive (no dots, so no traversal), at most 80 characters.
export const roomFile = (room: string): string => room.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

export function toneFile(key: ToneKey | "install"): string {
	if (key === INSTALL || key.app === INSTALL) return join(paths.toneDir(), "install.md");
	if (!validApp(key.app)) throw new Error(`앱 이름은 영문 소문자·숫자·-만 쓸 수 있어요: ${key.app}`);
	return key.room === undefined ? join(paths.toneDir(), `${key.app}.md`) : join(paths.toneDir(), key.app, `${roomFile(key.room)}.md`);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const unique = (xs: string[]) => [...new Set(xs)];
const SNS_APPS = new Set(["youtube", "instagram"]);

// One profile's markdown; the mail app profile falls back to the old single style.md until tone/mail.md exists.
function profile(key: ToneKey | "install"): string {
	const file = toneFile(key);
	if (existsSync(file)) return readFileSync(file, "utf8");
	return key !== INSTALL && key.app === "mail" && key.room === undefined ? read(paths.legacyStyle()) : "";
}

export const hasSamples = (key: ToneKey | "install"): boolean => bullets(profile(key), HEADINGS.samples).length > 0;

// Samples come from the narrowest profile that has any (room -> app -> install; for the youtube and instagram apps the old
// custom/sns/tone.md examples sit between app and install); rules, corrections and forbidden expressions are merged from every level,
// install first and the narrower ones later.
export function loadStyle(key: ToneKey): LoadedStyle {
	const room = key.room === undefined ? undefined : profile(key);
	const app = profile({ app: key.app });
	const install = profile("install");
	const levels: [ToneLevel, string | undefined][] = [["room", room], ["app", app], ["install", install]];
	let samples: string[] = [];
	let samplesFrom: LoadedStyle["samplesFrom"] = "none";
	const legacy = SNS_APPS.has(key.app) ? bullets(read(paths.snsTone()), HEADINGS.samples) : [];
	for (const [level, md] of levels) {
		if (md === undefined) continue;
		let own = bullets(md, HEADINGS.samples);
		let from: LoadedStyle["samplesFrom"] = level;
		if (!own.length && level === "app" && legacy.length) [own, from] = [legacy, "legacy"];
		if (own.length) {
			[samples, samplesFrom] = [own, from];
			break;
		}
	}
	const merged = (heading: string) => unique([install, app, room ?? ""].flatMap(md => bullets(md, heading)));
	return { samples, samplesFrom, rules: merged(HEADINGS.rules), corrections: merged(HEADINGS.corrections), forbidden: merged(HEADINGS.forbidden) };
}

// Writes into exactly that profile (a legacy style.md is carried over first when the mail profile is written for the first time).
export function writeExamples(key: ToneKey | "install", examples: string[]): void {
	writeAtomic(toneFile(key), setSection(profile(key), HEADINGS.samples, examples));
}

// The user's change request, verbatim and dated, in the profile of the draft that was revised, so every later draft there follows it.
export function recordCorrection(key: ToneKey, change: string, now: Date): void {
	const md = profile(key);
	const line = `${now.toISOString().slice(0, 10)}: ${change.replace(/\s+/g, " ").trim()}`;
	writeAtomic(toneFile(key), setSection(md, HEADINGS.corrections, [...bullets(md, HEADINGS.corrections), line]));
}

// Profile files that exist, relative to the tone dir (for `onboard.ts status`).
export function listProfiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string) => {
		if (!existsSync(dir)) return;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
			else if (e.name.endsWith(".md")) out.push(`${rel}${e.name}`);
		}
	};
	walk(paths.toneDir(), "");
	if (!out.includes("mail.md") && existsSync(paths.legacyStyle())) out.push("mail.md (style.md)");
	return out.sort();
}
