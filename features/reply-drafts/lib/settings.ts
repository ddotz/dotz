// Per-install settings and the user's style file of the reply-drafts feature (DESIGN.md). Everything personal lives under
// <DATA_DIR>/custom/reply-drafts/; nothing about a person is in the repo. Pure fs; never imports hub/config.ts (it loads the
// gateway config at import time), so the data dir is read from DOTZ_DIR on every call and tests can point it anywhere.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withLock } from "../../../hub/file-lock.ts";
import { appEntries } from "../../../hub/integrations.ts";
import { banBullet, parseBan, type ShapeBan } from "../../../hub/ban.ts";
import type { ReplyStyle } from "../../../hub/reply-draft.ts";
import { bulletLines, bullets, dataDir, HEADINGS, INSTALL, levelsOf, normText, paths, recipientApp, recipientFile, roomFile, unknownSections, validApp, writeAtomic, type ToneKey, type ToneLevel } from "./tone-key.ts";
export { bulletLines, bullets, dataDir, HEADINGS, INSTALL, levelsOf, normText, paths, recipientApp, recipientFile, recipientOf, roomFile, unknownSections, validApp, writeAtomic, type ToneKey, type ToneLevel } from "./tone-key.ts";
export { effectiveTexts, migrateLedger, moveHandRules, setEffective, setLines, textsAt, toAskAbout, undoLedger } from "./ledger.ts";
import { addRecord, banKind, type LedgerKind, removeMatching, rulesFor, scopeOfKey, textsAt } from "./ledger.ts";

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
	writeAtomic(paths.personalFeature(), shipped.replace(/^enabled:\s*false\s*$/m, "enabled: true"), 0o644);
}

// Turns one source on or off. Mail's current state is written down first, so switching another source on never switches mail on by
// way of the old top-level `auto`; turning a source on also turns the feature switch on.
export function setApp(app: string, auto: boolean): Settings {
	const s = loadSettings();
	const apps = { ...s.apps, mail: { auto: appOn(s, "mail") }, [app]: { auto } };
	// Switching one source off on an install that never decided keeps the others as they were (enabled, each following its monitoring).
	return saveSettings({ apps, ...(app === "mail" ? { auto } : {}), ...(auto || !s.decided ? { enabled: true } : {}) });
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

export const REPO_FEATURE = join(import.meta.dir, "..");

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

// One profile's markdown and the file it is read from; the mail app profile falls back to the old single style.md until tone/mail.md exists.
function profileAt(key: ToneKey | "install"): { file: string; md: string } {
	const file = toneFile(key);
	if (existsSync(file)) return { file, md: readFileSync(file, "utf8") };
	return key !== INSTALL && key.app === "mail" && file === toneFile({ app: "mail" }) ? { file: paths.legacyStyle(), md: read(paths.legacyStyle()) } : { file, md: "" };
}
const profile = (key: ToneKey | "install"): string => profileAt(key).md;

export const hasSamples = (key: ToneKey | "install"): boolean => bullets(profile(key), HEADINGS.samples).length > 0;
export const identityOf = (key: ToneKey | "install"): string[] => bullets(profile(key), HEADINGS.identity);
// A mail app instance with a tone profile of its own (an identity or samples written there); the shared `mail` profile does not count.
export const hasOwnTone = (app: string): boolean => app !== "mail" && validApp(app) && (identityOf({ app }).length > 0 || hasSamples({ app }));
/** The mail app instances of the app list (custom/apps.json), the default `mail` apart: the only mail apps whose drafts exist, so the only tone files that are read. */
export const listedMailApps = (): string[] => appEntries(dataDir()).filter(e => e.created && e.app === "mail" && !e.gone).map(e => e.key);
export const correctionsOf = (key: ToneKey | "install"): string[] => profileBullets(key, HEADINGS.corrections);

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

/** The profiles a style is merged from, narrowest level first, each with the app it belongs to and its file. The app level of a key with a `base`: its own file and, when that holds no identity or samples (only lessons, or nothing), the base's file under it. */
export function styleSources(key: ToneKey): { level: ToneLevel; app: string; file: string; md: string }[] {
	return levelsOf(key).flatMap(([level, k]) => {
		if (level !== "app") return [{ level, app: k.app, ...profileAt(k) }];
		const own = profileAt({ app: k.app });
		const under = k.base && !bullets(own.md, HEADINGS.identity).length && !bullets(own.md, HEADINGS.samples).length ? [{ level, app: k.base, ...profileAt({ app: k.base }) }] : [];
		return own.md || !under.length ? [{ level, app: k.app, ...own }, ...under] : under;
	});
}

/** A `## ` section outside HEADINGS (one the user added by hand) is a standing instruction too: its bullets follow the known rule sections.
 * Samples come from the narrowest profile that has any (levelsOf: recipient -> room -> app -> install; for the youtube and instagram apps the old
 * custom/sns/tone.md examples sit between app and install); rules, corrections and forbidden expressions are merged from every level,
 * install first and the narrower ones later. `recipient` lists the rules and corrections of the recipient level, absent when it has none. */
export function loadStyle(key: ToneKey): LoadedStyle {
	const levels = styleSources(key).map((s): [ToneLevel, string] => [s.level, s.md]);
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
	const live = rulesFor(key, ["tone", "correction", "ban", "content-ban"]);
	const ledger = (...kinds: LedgerKind[]) => live.filter(r => kinds.includes(r.kind)).map(r => r.text);
	// The identity (who the user is as a writer) comes from the narrowest profile that has one, like the samples.
	const narrowest = (heading: string) => levels.map(([, md]) => bullets(md, heading)).find(xs => xs.length) ?? [];
	const identity = narrowest(HEADINGS.identity);
	const to = levels.find(([level]) => level === "to")?.[1] ?? "";
	const recipient = unique([...live.filter(r => r.scope.to !== undefined && !KINDS[HEADINGS.forbidden]!.includes(r.kind)).map(r => r.text), ...[HEADINGS.rules, HEADINGS.learned, HEADINGS.profile, HEADINGS.corrections].flatMap(h => bullets(to, h)), ...unknownSections(to).flatMap(s => s.items)]);
	const standing = unique([...ledger("tone"), ...merged(HEADINGS.rules), ...handAdded]);
	return { identity, templates: narrowest(HEADINGS.templates), samples, samplesFrom, rules: unique([...standing, ...merged(HEADINGS.learned, HEADINGS.profile)]), standing, corrections: unique([...ledger("correction"), ...merged(HEADINGS.corrections)]), forbidden: unique([...ledger("ban", "content-ban"), ...merged(HEADINGS.forbidden)]), ...(recipient.length ? { recipient } : {}) };
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


export function writeIdentity(key: ToneKey | "install", lines: string[], templates?: string[]): void {
	editProfile(key, md => {
		const withIdentity = setSection(md, HEADINGS.identity, lines);
		return templates?.length ? setSection(withIdentity, HEADINGS.templates, templates) : withIdentity;
	});
}
export const templatesOf = (key: ToneKey | "install"): string[] => bullets(profile(key), HEADINGS.templates);

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const lineKey = (word: string) => oneLine(word.normalize("NFC")).toLowerCase();
const containing = (text: string) => ((needle: string) => (line: string): boolean => !!needle && lineKey(line).includes(needle))(lineKey(text));
const put = (key: ToneKey | "install", kind: LedgerKind, text: string, by: string, ref?: string, at?: Date) => addRecord({ text, kind, scope: scopeOfKey(key), by, ref, at });
const KINDS: Record<string, LedgerKind[]> = { [HEADINGS.rules]: ["tone"], [HEADINGS.corrections]: ["correction"], [HEADINGS.forbidden]: ["ban", "content-ban"] };

/** The 이어서 할 일 of an app instance (hub/followup.ts): its own lines and, for a mail app instance, the mail app's under them. */
export const followupText = (app: string): string => rulesFor({ app }, ["followup"]).map(r => r.text).join("\n");

/** The bullets of one section of exactly that profile: the ledger's lines of its scope for `## 말투`, `## 고친 점` and `## 금지`, the file's for every other section. */
export const profileBullets = (key: ToneKey | "install", heading: string): string[] => (KINDS[heading] ? KINDS[heading]!.flatMap(k => textsAt(scopeOfKey(key), k)) : bullets(profile(key), heading));

// The user's change request, verbatim and dated, in the scope of the draft that was revised, so every later draft there follows it.
export function recordCorrection(key: ToneKey, change: string, now: Date, ref?: string): void {
	put(key, "correction", `${now.toISOString().slice(0, 10)}: ${oneLine(change)}`, "correct", ref, now);
}

/** Takes every `## 고친 점` line of exactly that scope that contains the text (trimmed, case aside) out; returns the removed lines. */
export const removeCorrection = (key: ToneKey | "install", text: string): string[] => removeMatching(scopeOfKey(key), ["correction"], containing(text));

/** Takes every `## 말투` line of exactly that scope that contains the text (trimmed, case aside) out; returns the removed lines. */
export const removeRule = (key: ToneKey | "install", text: string): string[] => removeMatching(scopeOfKey(key), ["tone"], containing(text));

/** Adds a standing rule, undated and on one line, to exactly that scope; a line equal apart from case and whitespace is not added again. */
export function recordRule(key: ToneKey | "install", line: string, ref?: string): void {
	if (oneLine(line)) put(key, "tone", line, "rule", ref);
}

/** Where a learned line goes: under the install key (the user said it holds always or everywhere) a standing rule of install, which no later lesson pushes out of a prompt; under any other key a dated correction of that scope. */
export function recordLearned(key: ToneKey, line: string, now: Date): "rule" | "correction" {
	if (key.app === INSTALL) {
		recordRule(INSTALL, line);
		return "rule";
	}
	recordCorrection(key, line, now);
	return "correction";
}

/** Adds wordings the user banned, each on one line, to exactly that scope; one already there (whitespace, case and Unicode composition aside) is not added again. */
export function recordForbidden(key: ToneKey | "install", words: string[], ref?: string): void {
	for (const word of words.map(oneLine)) if (word) put(key, banKind(word), word, "ban", ref);
}

/** Adds a wording rule as its `shape <JSON>` bullet to exactly that scope; false when one with the same parts is already there. */
export const recordPattern = (key: ToneKey | "install", ban: ShapeBan, ref?: string): boolean => put(key, "ban", banBullet(ban), "ban", ref).added;

/** Takes a wording, or a wording rule by its label, out of exactly that scope's bans (whitespace, case and Unicode composition aside); false when it was not there. */
export const removeForbidden = (key: ToneKey | "install", word: string): boolean =>
	removeMatching(scopeOfKey(key), ["ban", "content-ban"], h => lineKey(h) === lineKey(word) || ((ban: ReturnType<typeof parseBan>) => ban.kind === "shape" && lineKey(ban.label) === lineKey(word))(parseBan(h))).length > 0;

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

/** `from`: the address of the person the reply went to (absent in pairs stored before it was kept). `fromId`: the platform id of a comment pair's author (hub/comments/past.ts; absent when the platform gave none). `source`: the mail source whose sent folder it came from (a mail site, a plugin); absent = zele (comment pairs have their own file per source, so no tag).
 * `edited`: the user changed the draft by hand before sending. `thread`: the post a comment pair sits under.
 * `conv`: the mail conversation, `subj`: its subject, `account`: the zele address it was sent from: what says which mailbox a reply belongs to (lib/box-voice.ts), read fresh so a move or an undo needs no rewrite. */
/** `via`: where the message it answers came from when that is not a mail (`comment:<comment source key>`: a mail that rode on a comment reply answers that comment). */
export type Pair = { received: string; reply: string; at: number; from?: string; fromId?: string; source?: string; edited?: true; thread?: string; conv?: string; subj?: string; account?: string; via?: string };

export const MAX_PAIRS = 1000;



export function loadPairs(app: string): Pair[] {
	const file = paths.pairs(app);
	if (!existsSync(file)) return [];
	const out: Pair[] = [];
	let unreadable = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const p = JSON.parse(line);
			if (p && typeof p.received === "string" && typeof p.reply === "string" && typeof p.at === "number" && p.reply.trim()) out.push({ received: p.received, reply: p.reply, at: p.at, ...(typeof p.from === "string" && p.from ? { from: p.from } : {}), ...(typeof p.fromId === "string" && p.fromId ? { fromId: p.fromId } : {}), ...(typeof p.source === "string" && p.source ? { source: p.source } : {}), ...(p.edited === true ? { edited: true as const } : {}), ...(typeof p.thread === "string" && p.thread ? { thread: p.thread } : {}), ...(typeof p.conv === "string" && p.conv ? { conv: p.conv } : {}), ...(typeof p.subj === "string" && p.subj ? { subj: p.subj } : {}), ...(typeof p.account === "string" && p.account ? { account: p.account } : {}), ...(typeof p.via === "string" && p.via ? { via: p.via } : {}) });
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
		else seen.set(k, { ...before, ...(!before.from && p.from ? { from: p.from } : {}), ...(!before.fromId && p.fromId ? { fromId: p.fromId } : {}), ...(!before.edited && p.edited ? { edited: true as const } : {}), ...(!before.thread && p.thread ? { thread: p.thread } : {}), ...(!before.conv && p.conv ? { conv: p.conv } : {}), ...(!before.subj && p.subj ? { subj: p.subj } : {}), ...(!before.account && p.account ? { account: p.account } : {}), ...(!before.via && p.via ? { via: p.via } : {}) });
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
