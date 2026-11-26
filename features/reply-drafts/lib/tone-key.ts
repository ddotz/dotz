// Where a tone profile lives and what it is called: the data dir, the files' paths, the tone key (app, room, recipient) and its levels, the section headings and their bullets.
// A leaf module (settings.ts and ledger.ts both stand on it, so neither imports the other); settings.ts re-exports it.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UNKNOWN_USER } from "../../youtube-instagram/lib/ig-owner.ts";

export const dataDir = () => process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
const root = (dir = dataDir()) => join(dir, "custom", "reply-drafts");

export const paths = {
	config: (dir?: string) => join(root(dir), "config.json"),
	legacyStyle: () => join(root(), "style.md"), // layout of the first version: read as the mail app profile until tone/mail.md exists
	toneDir: () => join(root(), "tone"),
	drafts: () => join(root(), "drafts.json"),
	ledger: (dir?: string) => join(root(dir), "rules.json"), // the rule ledger (lib/ledger.ts): every rule, its scope, source and state
	learned: () => join(root(), "learned.json"), // tone profiles whose first sweep already ran: { "<profile>": iso }
	learnLog: () => join(root(), "learn-log.json"), // what each learned line did and where (lib/learn.ts): [{ ref, at, source, line, state, scope, keys, stored, forbid, replaced }], the last 500
	compactFailed: () => join(root(), "compact-failed.json"), // tone profiles whose last compaction failed (lib/compact.ts): { "<profile>": { at, why, lines } }
	voices: () => join(root(), "box-voice.json"), // the mailboxes learned from their own sent mail (lib/box-voice.ts): { "<instance>/<box>": { at, texts, seen } }
	pairs: (app: string) => join(root(), "pairs", `${app}.jsonl`), // the user's real past replies with the message each answered, one JSON line per pair (lib/pairs.ts)
	corpusDir: () => join(root(), "sent"), // the first sweep's extract of the user's sent texts, one file per profile (re-analysis reads it)
	snsTone: () => join(dataDir(), "custom", "sns", "tone.md"),
	inbox: () => join(dataDir(), "inbox.jsonl"),
	personalFeature: () => join(dataDir(), "features", "reply-drafts", "feature.md"),
};

export function writeAtomic(file: string, text: string | Uint8Array, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, file);
}

// `learned` = style features measured from the user's own messages (kakao-voice.ts), kept apart from `rules` so a relearn never overwrites what the user wrote;
// `profile` = the short Korean room profile the draft model wrote from reading the room; `record` = what the last learning was based on.
export const HEADINGS = { identity: "## 정체성", templates: "## 답장 틀", rules: "## 말투", samples: "## 예시", corrections: "## 고친 점", forbidden: "## 금지", learned: "## 학습한 말투", profile: "## 대화 이해", record: "## 학습 기록", merged: "## 합쳐진 고친 점" } as const;

export function bullets(md: string, heading: string): string[] {
	return bulletLines(md, heading).map(b => b.text);
}

/** The bullets of a section with the 1-based line each stands on. */
export function bulletLines(md: string, heading: string): { text: string; line: number }[] {
	const lines = md.split("\n");
	const start = lines.findIndex(l => l.trim() === heading);
	if (start < 0) return [];
	const out: { text: string; line: number }[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i]!)) break;
		const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(lines[i]!);
		if (m) out.push({ text: m[1]!, line: i + 1 });
	}
	return out;
}


// Tone store: <DATA_DIR>/custom/reply-drafts/tone/install.md (whole install), <app>.md (mail, youtube, kakao, ...) and
// <app>/<room>.md (one conversation of a messenger). Each file has the four sections above.
// `base`: the app whose profile stands in at the app level when `app` has none (a mailbox's tone of a mail app instance without a profile of its own).
/** `to`: the recipient as the channel knows it (a mail address, a commenter's platform id: YouTube channel id, Instagram handle), whose own profile is `<app>/to/<recipientFile(to)>.md`; a `to` without a file name is no level, as if absent. */
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

/** The levels of `key`, narrowest first: the recipient (a `to` that has a file name, under `recipientApp` of its `base` when it has one), the room, the app (with its `base`; a mail app instance reads `mail` under its own) and the install. */
export function levelsOf(key: ToneKey): [ToneLevel, ToneKey][] {
	const install: [ToneLevel, ToneKey] = ["install", { app: INSTALL }];
	if (key.app === INSTALL) return [install];
	const base = key.base ?? (key.app !== "mail" && MAIL_INSTANCE.test(key.app) ? "mail" : undefined);
	return [
		...(key.to !== undefined && recipientFile(key.to) !== undefined ? [["to", { app: recipientApp(key.base ?? key.app), to: key.to }] as [ToneLevel, ToneKey]] : []),
		...(key.room !== undefined ? [["room", { app: key.app, room: key.room }] as [ToneLevel, ToneKey]] : []),
		["app", { app: key.app, ...(base ? { base } : {}) }],
		install,
	];
}


export const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// The `## ` sections of a profile the code does not know (a hand-added `## 보낸 사람 신분별`), with their bullets.
const KNOWN = new Set<string>(Object.values(HEADINGS));
export function unknownSections(md: string): { heading: string; items: string[] }[] {
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
