// Per-install settings and the user's style file of the reply-drafts feature (DESIGN.md). Everything personal lives under
// <DATA_DIR>/custom/reply-drafts/; nothing about a person is in the repo. Pure fs; never imports hub/config.ts (it loads the
// gateway config at import time), so the data dir is read from DOTZ_DIR on every call and tests can point it anywhere.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withLock } from "../../../hub/file-lock.ts";
import { banBullet, banKey, parseBan, type ShapeBan } from "../../../hub/ban.ts";
import type { ReplyStyle } from "../../../hub/reply-draft.ts";
import { UNKNOWN_USER } from "../../youtube-instagram/lib/ig-owner.ts";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
export const REPO_FEATURE = join(import.meta.dir, "..");
const root = (dir = dataDir()) => join(dir, "custom", "reply-drafts");

export const paths = {
	config: (dir?: string) => join(root(dir), "config.json"),
	legacyStyle: () => join(root(), "style.md"), // layout of the first version: read as the mail app profile until tone/mail.md exists
	toneDir: () => join(root(), "tone"),
	drafts: () => join(root(), "drafts.json"),
	learned: () => join(root(), "learned.json"), // tone profiles whose first sweep already ran: { "<profile>": iso }
	voices: () => join(root(), "box-voice.json"), // the mailboxes learned from their own sent mail (lib/box-voice.ts): { "<instance>/<box>": { at, texts, seen } }
	pairs: (app: string) => join(root(), "pairs", `${app}.jsonl`), // the user's real past replies with the message each answered, one JSON line per pair (lib/pairs.ts)
	corpusDir: () => join(root(), "sent"), // the first sweep's extract of the user's sent texts, one file per profile (re-analysis reads it)
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
// `decided` = the config file says enabled true or false (the user or onboarding chose); without it each source follows its monitoring.
export type Settings = { enabled: boolean; decided: boolean; auto: boolean; apps: Record<string, { auto: boolean }>; senders: { only: string[]; skip: string[] }; model?: string; models?: Record<string, string>; attachFolders?: Record<string, string>; followups?: Record<string, string>; draftRules?: Record<string, unknown>; draftDefaults?: Record<string, string> };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim()) : []);

// A missing or unreadable config is "off": the feature does nothing until an install turns it on. `dir`: another data dir than DOTZ_DIR's.
export function loadSettings(dir?: string): Settings {
	let raw: Record<string, any> = {};
	try {
		raw = JSON.parse(readFileSync(paths.config(dir), "utf8")) ?? {};
	} catch {
		return { enabled: false, decided: false, auto: true, apps: {}, senders: { only: [], skip: [] } };
	}
	const apps: Settings["apps"] = {};
	for (const [app, v] of Object.entries(raw.apps && typeof raw.apps === "object" ? (raw.apps as Record<string, any>) : {})) if (validApp(app)) apps[app] = { auto: v?.auto === true };
	// `models`: the model of one app or app instance's drafts (the 답장 모델 setting); an empty value means the default and is not kept.
	const models: Record<string, string> = {};
	for (const [app, v] of Object.entries(raw.models && typeof raw.models === "object" ? (raw.models as Record<string, any>) : {})) if (validApp(app) && typeof v === "string" && v.trim()) models[app] = v.trim();
	// `attachFolders`: the 첨부 파일 폴더 of one mail app instance (a folder path on this machine; hub/app-settings.ts attach_folder).
	const attachFolders: Record<string, string> = {};
	for (const [app, v] of Object.entries(raw.attachFolders && typeof raw.attachFolders === "object" ? (raw.attachFolders as Record<string, any>) : {})) if (validApp(app) && typeof v === "string" && v.trim()) attachFolders[app] = v.trim();
	// `followups`: the 이어서 할 일 rule of one app instance (hub/followup.ts); free text, empty = none.
	const followups: Record<string, string> = {};
	for (const [app, v] of Object.entries(raw.followups && typeof raw.followups === "object" ? (raw.followups as Record<string, any>) : {})) if (validApp(app) && typeof v === "string" && v.trim()) followups[app] = v.trim();
	// `draftRules` / `draftDefaults`: the 자동 초안 규칙 and 기본 규칙 of one mail app instance, validated where they are written and read (hub/app-settings.ts,
	// lib/rules.ts); kept here as they are so a save of another setting never drops them.
	const draftRules = raw.draftRules && typeof raw.draftRules === "object" && !Array.isArray(raw.draftRules) ? (raw.draftRules as Record<string, unknown>) : undefined;
	const draftDefaults: Record<string, string> = {};
	for (const [app, v] of Object.entries(raw.draftDefaults && typeof raw.draftDefaults === "object" ? (raw.draftDefaults as Record<string, any>) : {})) if (validApp(app) && typeof v === "string" && v.trim()) draftDefaults[app] = v.trim();
	return {
		enabled: raw.enabled === true,
		decided: typeof raw.enabled === "boolean",
		auto: raw.auto !== false,
		apps,
		senders: { only: strings(raw.senders?.only), skip: strings(raw.senders?.skip) },
		...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
		...(Object.keys(models).length ? { models } : {}),
		...(Object.keys(attachFolders).length ? { attachFolders } : {}),
		...(Object.keys(followups).length ? { followups } : {}),
		...(draftRules && Object.keys(draftRules).length ? { draftRules } : {}),
		...(Object.keys(draftDefaults).length ? { draftDefaults } : {}),
	};
}

export function saveSettings(patch: Partial<Settings>): Settings {
	return withLock(paths.config(), "답장 설정", () => {
		const { decided: _d, ...base } = { ...loadSettings(), ...patch };
		writeAtomic(paths.config(), `${JSON.stringify(base, null, 2)}\n`, 0o644);
		return { ...base, decided: true };
	});
}

const readJson = (file: string): any => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

// Whether the user set up monitoring of this source on this install: mail = zele turned on in config.json or a webmail-no-api site
// onboarded; youtube / instagram = that platform connected in the SNS feature. That request is the user's opt-in for suggestions.
export function monitored(app: string, dir = dataDir()): boolean {
	if (app === "youtube" || app === "instagram") return Boolean(readJson(join(dir, "custom", "sns", "config.json"))?.[app]);
	if (app !== "mail") return false;
	if (readJson(join(dir, "config.json"))?.zele?.enabled === true) return true;
	const webmail = join(dir, "custom", "webmail");
	return existsSync(webmail) && readdirSync(webmail).some(site => existsSync(join(webmail, site, "config.json")));
}

// Whether a source drafts on its own. Its own switch wins; a config the user decided (onboard on/off) rules the rest; with no decision
// yet, a source the user explicitly set up monitoring for gets suggestions (owner 2026-10-23), every other source stays off.
export function appOn(s: Settings, app: string, isMonitored: (app: string) => boolean = monitored): boolean {
	const own = s.apps[app];
	if (own) return s.enabled && own.auto;
	if (s.decided) return s.enabled && (app === "mail" ? s.auto : isMonitored(app));
	return isMonitored(app);
}

// The personal feature switch (a personal copy of the shipped feature.md with enabled: true), so the orchestrator's prompt carries how to
// answer these asks. Written when the feature is turned on, or the first time a suggestion goes out for a monitored source.
export function ensureSwitch(): void {
	if (existsSync(paths.personalFeature())) return;
	const shipped = readFileSync(join(REPO_FEATURE, "feature.md"), "utf8");
	mkdirSync(dirname(paths.personalFeature()), { recursive: true });
	writeFileSync(paths.personalFeature(), shipped.replace(/^enabled:\s*false\s*$/m, "enabled: true"));
}

// Turns one source on or off. Mail's current state is written down first, so switching another source on never switches mail on by
// way of the old top-level `auto`; turning a source on also turns the feature switch on.
export function setApp(app: string, auto: boolean): Settings {
	const s = loadSettings();
	const apps = { ...s.apps, mail: { auto: appOn(s, "mail") }, [app]: { auto } };
	// Switching one source off on an install that never decided keeps the others as they were (enabled, each following its monitoring).
	return saveSettings({ apps, ...(app === "mail" ? { auto } : {}), ...(auto || !s.decided ? { enabled: true } : {}) });
}

// `learned` = style features measured from the user's own messages (kakao-voice.ts), kept apart from `rules` so a relearn never overwrites what the user wrote;
// `profile` = the short Korean room profile the draft model wrote from reading the room; `record` = what the last learning was based on.
export const HEADINGS = { identity: "## 정체성", templates: "## 답장 틀", rules: "## 말투", samples: "## 예시", corrections: "## 고친 점", forbidden: "## 금지", learned: "## 학습한 말투", profile: "## 대화 이해", record: "## 학습 기록" } as const;

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
// `base`: the app whose profile stands in at the app level when `app` has none (a mailbox's tone of a mail app instance without a profile of its own).
/** `to`: the recipient as the channel knows it (a mail address, a comment author), whose own profile is `<app>/to/<recipientFile(to)>.md`; a `to` without a file name is no level, as if absent. */
export type ToneKey = { app: string; room?: string; base?: string; to?: string };
export type ToneLevel = "to" | "room" | "app" | "install";
/** `standing`: the owner's standing rules (the `## 말투` lines and the hand-added sections of install, app, room and recipient, install first), also part of `rules`. */
export type LoadedStyle = ReplyStyle & { samplesFrom: ToneLevel | "legacy" | "none"; standing: string[] };

export const INSTALL = "install";
const APP_ID = /^[a-z0-9-]+$/;

export function validApp(app: string): boolean {
	return APP_ID.test(app);
}

// A room id as a file name: only [A-Za-z0-9_-] survive (no dots, so no traversal), at most 80 characters.
export const roomFile = (room: string): string => room.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

const RECIPIENT_MAX = 120;
const RECIPIENT_NAME_MAX = 250;
const recipientNorm = (id: string): string => id.normalize("NFC").trim().toLowerCase().normalize("NFC");
const NOBODY = new Set(["익명", UNKNOWN_USER].map(recipientNorm));

/** A recipient id (NFC, trimmed, lowercased) as a file name: `[a-z0-9-]` stay, every other UTF-16 code unit is `_` and its four hex digits, so two ids never share a name. Undefined for an id that is empty, longer than 120 code units, whose name would not fit a file name, or that names nobody ("익명", an adapter's unknown user). */
export function recipientFile(id: string): string | undefined {
	const norm = recipientNorm(id);
	if (!norm || norm.length > RECIPIENT_MAX || NOBODY.has(norm)) return undefined;
	let name = "";
	for (let i = 0; i < norm.length; i++) {
		const c = norm[i]!;
		name += /[a-z0-9-]/.test(c) ? c : `_${norm.charCodeAt(i).toString(16).padStart(4, "0")}`;
	}
	return name.length > RECIPIENT_NAME_MAX ? undefined : name;
}

/** The recipient id a file name of `recipientFile` stands for; undefined for a name `recipientFile` never gives. */
export function recipientOf(name: string): string | undefined {
	const parts = name.match(/[a-z0-9-]|_[0-9a-f]{4}|[^]/g) ?? [];
	if (parts.some(p => p.length === 1 && !/[a-z0-9-]/.test(p))) return undefined;
	const id = parts.map(p => (p.length === 1 ? p : String.fromCharCode(Number.parseInt(p.slice(1), 16)))).join("");
	return recipientFile(id) === name ? id : undefined;
}

const MAIL_INSTANCE = /^mail(-[a-z0-9]+)*$/;
/** The app a recipient's file sits under: every mail app instance (`mail`, `mail-<slug>`) shares `mail`, since a person's address is the same in each of them; any other app is its own. */
export const recipientApp = (app: string): string => (MAIL_INSTANCE.test(app) ? "mail" : app);

/** The levels of `key`, narrowest first: the recipient (a `to` that has a file name, under `recipientApp`), the room, the app (with its `base`) and the install. */
export function levelsOf(key: ToneKey): [ToneLevel, ToneKey][] {
	const install: [ToneLevel, ToneKey] = ["install", { app: INSTALL }];
	if (key.app === INSTALL) return [install];
	return [
		...(key.to !== undefined && recipientFile(key.to) !== undefined ? [["to", { app: recipientApp(key.app), to: key.to }] as [ToneLevel, ToneKey]] : []),
		...(key.room !== undefined ? [["room", { app: key.app, room: key.room }] as [ToneLevel, ToneKey]] : []),
		["app", { app: key.app, ...(key.base ? { base: key.base } : {}) }],
		install,
	];
}

export function toneFile(key: ToneKey | "install"): string {
	if (key === INSTALL || key.app === INSTALL) return join(paths.toneDir(), "install.md");
	if (!validApp(key.app)) throw new Error(`앱 이름은 영문 소문자·숫자·-만 쓸 수 있어요: ${key.app}`);
	const to = key.to === undefined ? undefined : recipientFile(key.to);
	if (to !== undefined) return join(paths.toneDir(), recipientApp(key.app), "to", `${to}.md`);
	return key.room === undefined ? join(paths.toneDir(), `${key.app}.md`) : join(paths.toneDir(), key.app, `${roomFile(key.room)}.md`);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const unique = (xs: string[]) => [...new Set(xs)];
const SNS_APPS = new Set(["youtube", "instagram"]);

// One profile's markdown; the mail app profile falls back to the old single style.md until tone/mail.md exists.
function profile(key: ToneKey | "install"): string {
	const file = toneFile(key);
	if (existsSync(file)) return readFileSync(file, "utf8");
	return key !== INSTALL && key.app === "mail" && file === toneFile({ app: "mail" }) ? read(paths.legacyStyle()) : "";
}

export const hasSamples = (key: ToneKey | "install"): boolean => bullets(profile(key), HEADINGS.samples).length > 0;
export const identityOf = (key: ToneKey | "install"): string[] => bullets(profile(key), HEADINGS.identity);
// A mail app instance with a tone profile of its own (an identity or samples written there); the shared `mail` profile does not count.
export const hasOwnTone = (app: string): boolean => app !== "mail" && validApp(app) && (identityOf({ app }).length > 0 || hasSamples({ app }));
/** The app whose tone profile a draft of `app` reads and learns into: a second mail app instance (`mail-<slug>`) without a tone of its own shares `mail`, as its offered drafts do; every other app is itself. */
export const profileApp = (app: string): string => (app !== "mail" && MAIL_INSTANCE.test(app) && !hasOwnTone(app) ? "mail" : app);
export const correctionsOf = (key: ToneKey | "install"): string[] => bullets(profile(key), HEADINGS.corrections);

// The `## ` sections of a profile the code does not know (a hand-added `## 보낸 사람 신분별`), with their bullets.
const KNOWN = new Set<string>(Object.values(HEADINGS));
function unknownSections(md: string): { heading: string; items: string[] }[] {
	const out: { heading: string; items: string[] }[] = [];
	let current: { heading: string; items: string[] } | undefined;
	for (const line of md.split("\n")) {
		if (/^## /.test(line)) {
			current = KNOWN.has(line.trim()) ? undefined : { heading: line.trim(), items: [] };
			if (current) out.push(current);
		} else {
			const m = current && /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
			if (m) current!.items.push(m[1]!);
		}
	}
	return out;
}
// A profile the user tuned by hand: corrections recorded, or a section of their own.
export const isTuned = (key: ToneKey | "install"): boolean => correctionsOf(key).length > 0 || unknownSections(profile(key)).length > 0;

// learned.json: which profiles ran their first sweep (and at which version), plus the marks of the pair reads (tone.ts refreshPairs).
export function readLearned(): Record<string, string> {
	if (!existsSync(paths.learned())) return {};
	try {
		return JSON.parse(readFileSync(paths.learned(), "utf8")) ?? {};
	} catch {
		return {};
	}
}
export const markLearned = (marks: string[], now: Date): void => writeAtomic(paths.learned(), `${JSON.stringify({ ...readLearned(), ...Object.fromEntries(marks.map(m => [m, now.toISOString()])) }, null, 1)}\n`);

/** A `## ` section outside HEADINGS (one the user added by hand) is a standing instruction too: its bullets follow the known rule sections.
 * Samples come from the narrowest profile that has any (levelsOf: recipient -> room -> app -> install; for the youtube and instagram apps the old
 * custom/sns/tone.md examples sit between app and install); rules, corrections and forbidden expressions are merged from every level,
 * install first and the narrower ones later. `recipient` lists the rules and corrections of the recipient level, absent when it has none. */
export function loadStyle(key: ToneKey): LoadedStyle {
	const levels = levelsOf(key).map(([level, k]): [ToneLevel, string] => [level, level === "app" ? profile({ app: k.app }) || (k.base ? profile({ app: k.base }) : "") : profile(k)]);
	let samples: string[] = [];
	let samplesFrom: LoadedStyle["samplesFrom"] = "none";
	const legacy = SNS_APPS.has(key.app) ? bullets(read(paths.snsTone()), HEADINGS.samples) : [];
	for (const [level, md] of levels) {
		let own = bullets(md, HEADINGS.samples);
		let from: LoadedStyle["samplesFrom"] = level;
		if (!own.length && level === "app" && legacy.length) [own, from] = [legacy, "legacy"];
		if (own.length) {
			[samples, samplesFrom] = [own, from];
			break;
		}
	}
	const broadFirst = levels.map(([, md]) => md).reverse();
	const merged = (...headings: string[]) => unique(broadFirst.flatMap(md => headings.flatMap(h => bullets(md, h))));
	const handAdded = broadFirst.flatMap(md => unknownSections(md).flatMap(s => s.items));
	// The identity (who the user is as a writer) comes from the narrowest profile that has one, like the samples.
	const narrowest = (heading: string) => levels.map(([, md]) => bullets(md, heading)).find(xs => xs.length) ?? [];
	const identity = narrowest(HEADINGS.identity);
	const to = levels.find(([level]) => level === "to")?.[1] ?? "";
	const recipient = unique([...[HEADINGS.rules, HEADINGS.learned, HEADINGS.profile].flatMap(h => bullets(to, h)), ...unknownSections(to).flatMap(s => s.items), ...bullets(to, HEADINGS.corrections)]);
	return { identity, templates: narrowest(HEADINGS.templates), samples, samplesFrom, rules: unique([...merged(HEADINGS.rules, HEADINGS.learned, HEADINGS.profile), ...handAdded]), standing: unique([...merged(HEADINGS.rules), ...handAdded]), corrections: merged(HEADINGS.corrections), forbidden: merged(HEADINGS.forbidden), ...(recipient.length ? { recipient } : {}) };
}

function editProfile(key: ToneKey | "install", edit: (md: string) => string | undefined): void {
	const file = toneFile(key);
	withLock(file, "말투", () => {
		const next = edit(profile(key));
		if (next !== undefined) writeAtomic(file, next);
	});
}

// Writes into exactly that profile (a legacy style.md is carried over first when the mail profile is written for the first time).
export function writeExamples(key: ToneKey | "install", examples: string[]): void {
	editProfile(key, md => setSection(md, HEADINGS.samples, examples));
}

// Replaces several sections of exactly that profile at once (every other section stays).
export function writeSections(key: ToneKey | "install", sections: [heading: string, items: string[]][]): void {
	editProfile(key, md => sections.reduce((acc, [heading, items]) => setSection(acc, heading, items), md));
}

export const profileBullets = (key: ToneKey | "install", heading: string): string[] => bullets(profile(key), heading);

export function writeIdentity(key: ToneKey | "install", lines: string[], templates?: string[]): void {
	editProfile(key, md => {
		const withIdentity = setSection(md, HEADINGS.identity, lines);
		return templates?.length ? setSection(withIdentity, HEADINGS.templates, templates) : withIdentity;
	});
}
export const templatesOf = (key: ToneKey | "install"): string[] => bullets(profile(key), HEADINGS.templates);

const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function sectionOf(lines: string[], heading: string): { start: number; end: number } | undefined {
	const start = lines.findIndex(l => l.trim() === heading);
	if (start < 0) return undefined;
	const next = lines.findIndex((l, i) => i > start && /^## /.test(l));
	return { start, end: next < 0 ? lines.length : next };
}

function appendBullet(md: string, heading: string, item: string): string {
	const eol = md.includes("\r\n") ? "\r\n" : "\n";
	const lines = md.split(/(?<=\n)/);
	const at = sectionOf(lines, heading);
	if (!at) return `${md}${!md || md.endsWith(`${eol}${eol}`) ? "" : md.endsWith("\n") ? eol : eol + eol}${heading}${eol}${eol}- ${item}${eol}`;
	const inSection = (i: number) => i >= at.start && i < at.end;
	const lastBullet = lines.findLastIndex((l, i) => inSection(i) && BULLET.test(l));
	const added = lastBullet < 0 ? ["", `- ${item}`] : [`- ${item}`];
	let after = lastBullet < 0 ? lines.findLastIndex((l, i) => inSection(i) && !!l.trim()) : lastBullet;
	while (lastBullet >= 0 && after + 1 < at.end && /^\s+\S/.test(lines[after + 1]!) && !BULLET.test(lines[after + 1]!)) after++;
	const last = after === lines.length - 1 && !lines[after]!.endsWith("\n");
	if (last) lines[after] += eol;
	lines.splice(after + 1, 0, ...added.map((l, i) => (last && i === added.length - 1 ? l : l + eol)));
	return lines.join("");
}

function dropBullets(md: string, heading: string, drop: (item: string) => boolean): { md: string; removed: string[] } | undefined {
	const lines = md.split(/(?<=\n)/);
	const at = sectionOf(lines, heading);
	if (!at) return undefined;
	const removed: string[] = [];
	const kept = lines.filter((l, i) => {
		const item = i > at.start && i < at.end ? BULLET.exec(l)?.[1] : undefined;
		if (item === undefined || !drop(item)) return true;
		removed.push(item);
		return false;
	});
	if (!removed.length) return undefined;
	const out = kept.join("");
	return { md: md.endsWith("\n") ? out : out.replace(/\r?\n$/, ""), removed };
}

// The user's change request, verbatim and dated, in the profile of the draft that was revised, so every later draft there follows it.
export function recordCorrection(key: ToneKey, change: string, now: Date): void {
	const line = `${now.toISOString().slice(0, 10)}: ${oneLine(change)}`;
	editProfile(key, md => appendBullet(md, HEADINGS.corrections, line));
}

/** Takes every `## 고친 점` line of exactly that profile that contains the text (trimmed, case aside) out; returns the removed lines. */
export const removeCorrection = (key: ToneKey | "install", text: string): string[] => removeLines(key, HEADINGS.corrections, text);

/** Takes every `## 말투` line of exactly that profile that contains the text (trimmed, case aside) out; returns the removed lines. */
export const removeRule = (key: ToneKey | "install", text: string): string[] => removeLines(key, HEADINGS.rules, text);

function removeLines(key: ToneKey | "install", heading: string, text: string): string[] {
	const needle = lineKey(text);
	let removed: string[] = [];
	editProfile(key, md => {
		const out = needle ? dropBullets(md, heading, l => lineKey(l).includes(needle)) : undefined;
		removed = out?.removed ?? [];
		return out?.md;
	});
	return removed;
}

/** One bullet of a profile section. */
export type SectionLine = { heading: string; line: string };

/** One locked edit of exactly that profile: takes each `take` bullet out of its section (one equal bullet each), hands what was taken to `before` while the old file is still on disk (a throw there writes nothing), then adds `add` at the end of its section (with `once`, not when a bullet equal apart from case and whitespace is there). What was taken and whether `add` went in. */
export function replaceBullets<T extends SectionLine>(key: ToneKey | "install", take: T[], add?: SectionLine & { once?: boolean }, before?: (taken: T[]) => void): { taken: T[]; added: boolean } {
	let taken: T[] = [];
	let added = false;
	editProfile(key, md => {
		let out = md;
		taken = [];
		for (const heading of unique(take.map(t => t.heading))) {
			const want = take.filter(t => t.heading === heading);
			const got: T[] = [];
			const dropped = dropBullets(out, heading, item => {
				const at = want.findIndex(w => w.line === item);
				if (at >= 0) got.push(...want.splice(at, 1));
				return at >= 0;
			});
			if (!dropped) continue;
			out = dropped.md;
			taken.push(...got);
		}
		const line = oneLine(add?.line ?? "");
		added = !!add && !!line && !(add.once && bullets(out, add.heading).some(b => normText(b) === normText(line)));
		if (add && added) out = appendBullet(out, add.heading, line);
		if (!taken.length && !added) return undefined;
		if (taken.length) before?.(taken);
		return out;
	});
	return { taken, added };
}

/** One locked edit of exactly that profile: when the section of `heading` holds nothing but bullets and they still equal `expect` (in order), hands control to `before` while the old file is still on disk (a throw there writes nothing) and replaces them with `items`; false, writing nothing, when they changed or the section holds any other line (a note, a sub-heading, a continuation line), which a rewrite would lose. */
export function rewriteSection(key: ToneKey | "install", heading: string, expect: string[], items: string[], before?: () => void): boolean {
	let done = false;
	editProfile(key, md => {
		const now = bullets(md, heading);
		const lines = md.split(/\r?\n/);
		const at = sectionOf(lines, heading);
		const onlyBullets = !!at && lines.slice(at.start + 1, at.end).every(l => !l.trim() || /^[-*]\s+\S/.test(l));
		done = onlyBullets && now.length === expect.length && now.every((b, i) => b === expect[i]);
		if (!done) return undefined;
		before?.();
		return setSection(md, heading, items);
	});
	return done;
}

/** Adds a standing rule, undated and on one line, to the `## 말투` section of exactly that profile; a line equal apart from case and whitespace is not added again. */
export function recordRule(key: ToneKey | "install", line: string): void {
	const rule = oneLine(line);
	if (!rule) return;
	editProfile(key, md => (bullets(md, HEADINGS.rules).some(h => normText(h) === normText(rule)) ? undefined : appendBullet(md, HEADINGS.rules, rule)));
}

/** Where a learned line goes: under the install key (the user said it holds always or everywhere) a standing rule of install.md, which no later lesson pushes out of a prompt; under any other key a dated correction of that profile. */
export function recordLearned(key: ToneKey, line: string, now: Date): "rule" | "correction" {
	if (key.app === INSTALL) {
		recordRule(INSTALL, line);
		return "rule";
	}
	recordCorrection(key, line, now);
	return "correction";
}

const lineKey = (word: string) => oneLine(word.normalize("NFC")).toLowerCase();
const bulletKey = (bullet: string) => banKey(parseBan(bullet));

/** Adds wordings the user banned, each on one line, to the `## 금지` section of exactly that profile; one already there (whitespace, case and Unicode composition aside) is not added again. */
export function recordForbidden(key: ToneKey | "install", words: string[]): void {
	editProfile(key, md => {
		const have = bullets(md, HEADINGS.forbidden).map(bulletKey);
		let next: string | undefined;
		for (const word of words.map(oneLine)) {
			if (!word || have.includes(bulletKey(word))) continue;
			have.push(bulletKey(word));
			next = appendBullet(next ?? md, HEADINGS.forbidden, word);
		}
		return next;
	});
}

/** Adds a wording rule as its `shape <JSON>` bullet to the `## 금지` section of exactly that profile; false when one with the same parts is already there. */
export function recordPattern(key: ToneKey | "install", ban: ShapeBan): boolean {
	let added = false;
	editProfile(key, md => {
		if (bullets(md, HEADINGS.forbidden).some(b => bulletKey(b) === banKey(ban))) return undefined;
		added = true;
		return appendBullet(md, HEADINGS.forbidden, banBullet(ban));
	});
	return added;
}

/** Takes a wording, or a wording rule by its label, out of the `## 금지` section of exactly that profile (whitespace, case and Unicode composition aside); false when it was not there. */
export function removeForbidden(key: ToneKey | "install", word: string): boolean {
	let removed = false;
	editProfile(key, md => {
		const out = dropBullets(md, HEADINGS.forbidden, h => {
			const ban = parseBan(h);
			return lineKey(h) === lineKey(word) || (ban.kind === "shape" && lineKey(ban.label) === lineKey(word));
		});
		removed = !!out;
		return out?.md;
	});
	return removed;
}

/** The owner's own past replies of every app (all stored pairs), the install's corpus a proposed wording pattern must not hit too often. */
export function ownReplies(): string[] {
	const dir = dirname(paths.pairs("mail"));
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(f => f.endsWith(".jsonl")).flatMap(f => loadPairs(f.slice(0, -".jsonl".length)).map(p => p.reply));
}

/** The `## ` sections of exactly that profile that the owner added by hand (outside HEADINGS), with their bullets. */
export const handSections = (key: ToneKey | "install"): { heading: string; items: string[] }[] => unknownSections(profile(key));

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

/** `from`: the address of the person the reply went to (absent in pairs stored before it was kept). `source`: the mail source whose sent folder it came from (a mail site, a plugin); absent = zele (comment pairs have their own file per source, so no tag).
 * `edited`: the user changed the draft by hand before sending. `thread`: the post a comment pair sits under.
 * `conv`: the mail conversation, `subj`: its subject, `account`: the zele address it was sent from: what says which mailbox a reply belongs to (lib/box-voice.ts), read fresh so a move or an undo needs no rewrite. */
export type Pair = { received: string; reply: string; at: number; from?: string; source?: string; edited?: true; thread?: string; conv?: string; subj?: string; account?: string };

export const MAX_PAIRS = 1000;

export const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export function loadPairs(app: string): Pair[] {
	const file = paths.pairs(app);
	if (!existsSync(file)) return [];
	const out: Pair[] = [];
	let unreadable = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const p = JSON.parse(line);
			if (p && typeof p.received === "string" && typeof p.reply === "string" && typeof p.at === "number" && p.reply.trim()) out.push({ received: p.received, reply: p.reply, at: p.at, ...(typeof p.from === "string" && p.from ? { from: p.from } : {}), ...(typeof p.source === "string" && p.source ? { source: p.source } : {}), ...(p.edited === true ? { edited: true as const } : {}), ...(typeof p.thread === "string" && p.thread ? { thread: p.thread } : {}), ...(typeof p.conv === "string" && p.conv ? { conv: p.conv } : {}), ...(typeof p.subj === "string" && p.subj ? { subj: p.subj } : {}), ...(typeof p.account === "string" && p.account ? { account: p.account } : {}) });
		} catch {
			unreadable++;
		}
	}
	if (unreadable) console.error(`reply draft: ${unreadable} unreadable line(s) in ${file} skipped`);
	return out;
}

// Deduped by reply + received (the newest of a repeat stays, but takes the sender, the edited mark, the post and the mailbox facts from a copy that has one, so a re-read upgrades an old pair and never drops a mark),
// the newest MAX_PAIRS of each source kept (a big sent folder of one source never pushes out another's), oldest first.
export function savePairs(app: string, pairs: Pair[]): void {
	const seen = new Map<string, Pair>();
	for (const p of [...pairs].sort((a, b) => b.at - a.at)) {
		const k = `${p.source ?? ""}\n${normText(p.reply)}\n${normText(p.received)}`;
		const before = seen.get(k);
		if (!before) seen.set(k, p);
		else seen.set(k, { ...before, ...(!before.from && p.from ? { from: p.from } : {}), ...(!before.edited && p.edited ? { edited: true as const } : {}), ...(!before.thread && p.thread ? { thread: p.thread } : {}), ...(!before.conv && p.conv ? { conv: p.conv } : {}), ...(!before.subj && p.subj ? { subj: p.subj } : {}), ...(!before.account && p.account ? { account: p.account } : {}) });
	}
	const count = new Map<string, number>();
	const kept = [...seen.values()].filter(p => {
		const n = (count.get(p.source ?? "") ?? 0) + 1;
		count.set(p.source ?? "", n);
		return n <= MAX_PAIRS;
	});
	writeAtomic(paths.pairs(app), kept.reverse().map(p => JSON.stringify(p)).join("\n") + (kept.length ? "\n" : ""));
}

// What a first sweep learned, shown at the end of onboarding so the owner can say whether it sounds like them. A correction or a line under `## 말투` outlives a relearn; an edit to the identity does not.
const LEARNED_SHOWN = 4;
export function learnedCheck(key: ToneKey): string {
	const lines = identityOf(key).slice(0, LEARNED_SHOWN);
	if (!lines.length) return "";
	return `이렇게 배웠어요, 내 글 같은지 봐 주세요:\n${lines.map(l => `- ${l}`).join("\n")}\n다른 점은 초안에서 고치기로 알려 주거나 ${toneFile(key)}의 ${HEADINGS.rules}에 적어 주세요. 다시 배워도 남아요.`;
}
