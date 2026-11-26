// The one rule ledger (<data dir>/custom/reply-drafts/rules.json): a rule is one record with a kind, a scope, a source and a state. The tone files keep only the learned voice;
// the settings screen, `correct`/`learn` and every draft read and write the same records. Narrower scope wins, then newer (decided here, in `clashes`); a mail instance reads the
// `mail` scope under its own at read time, so a lesson is never copied. Nothing is deleted: a curated line is "merged" into the record that replaced it, a removed one "off".
// A "mask" is the one record that is no rule: a narrower scope saying it does not follow that inherited line (same kind and text); it only ever takes a line out of what is read (`chainOver`).
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { banKey, contentBan, parseBan } from "../../../hub/ban.ts";
import { withLock } from "../../../hub/file-lock.ts";
import { bullets, dataDir, HEADINGS, INSTALL, levelsOf, normText, paths, recipientFile, recipientOf, roomFile, unknownSections, writeAtomic, type ToneKey } from "./tone-key.ts";

export type LedgerKind = "tone" | "correction" | "ban" | "content-ban" | "instruction" | "followup" | "request";
/** `request`: the id of the 자동 초안 규칙 whose 어떻게 the record is. */
export type LedgerScope = { app?: string; room?: string; to?: string; request?: string };
export type LedgerRecord = { id: string; text: string; kind: LedgerKind; scope: LedgerScope; at: string; by: string; ref?: string; state: "on" | "off" | "merged" | "mask"; into?: string };
type Doc = { records: LedgerRecord[]; asked: Record<string, string> };
type Draft = Pick<LedgerRecord, "text" | "kind" | "scope" | "by"> & { ref?: string; at?: Date };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const isBan = (kind: string): boolean => kind === "ban" || kind === "content-ban";
const textKey = (kind: string, text: string): string => (isBan(kind) ? banKey(parseBan(text)) : normText(text.normalize("NFC")));
const sameScope = (a: LedgerScope, b: LedgerScope): boolean => a.app === b.app && a.room === b.room && a.to === b.to && a.request === b.request;
const lines = (text: string): string[] => text.split("\n").map(oneLine).filter(Boolean);
export const banKind = (text: string): "ban" | "content-ban" => (contentBan(parseBan(text)) !== undefined ? "content-ban" : "ban");

function readDoc(dir: string): Doc {
	try {
		const v = JSON.parse(readFileSync(paths.ledger(dir), "utf8"));
		return { records: Array.isArray(v?.records) ? v.records : [], asked: v?.asked && typeof v.asked === "object" ? v.asked : {} };
	} catch {
		return { records: [], asked: {} };
	}
}
export const readLedger = (dir: string = dataDir()): LedgerRecord[] => readDoc(dir).records;

/** One locked edit of the ledger; the file is written only when `edit` changed something. */
function change<T>(dir: string, edit: (doc: Doc) => T): T {
	return withLock(paths.ledger(dir), "답장 규칙", () => {
		const doc = readDoc(dir);
		const before = JSON.stringify(doc);
		const out = edit(doc);
		if (JSON.stringify(doc) !== before) writeAtomic(paths.ledger(dir), `${JSON.stringify(doc, null, 1)}\n`);
		return out;
	});
}

const fresh = (r: Draft): LedgerRecord => ({ id: `r${randomUUID().slice(0, 8)}`, text: oneLine(r.text), kind: r.kind, scope: r.scope, at: (r.at ?? new Date()).toISOString(), by: r.by, ...(r.ref ? { ref: r.ref } : {}), state: "on" });

/** Adds one sentence; one equal (case, whitespace and Unicode composition aside) and on at the same scope is not added again, that record is returned. */
export function addRecord(r: Draft, dir: string = dataDir()): { record: LedgerRecord; added: boolean } {
	return change(dir, doc => {
		const record = fresh(r);
		const same = doc.records.find(x => x.state === "on" && x.kind === record.kind && sameScope(x.scope, record.scope) && textKey(x.kind, x.text) === textKey(record.kind, record.text));
		if (same) return { record: same, added: false };
		doc.records.push(record);
		return { record, added: true };
	});
}

/** Sets the state of records by id (`into`: the record that took its place); the records changed. */
export function setState(ids: string[], state: LedgerRecord["state"], into?: string, dir: string = dataDir()): LedgerRecord[] {
	return change(dir, doc => doc.records.filter(r => ids.includes(r.id)).map(r => (Object.assign(r, { state }), into ? (r.into = into) : delete r.into, r)));
}

/** One locked edit of the on records of exactly `scope`: every `take` line (kind and text) becomes `merged` into the record added (or `off` with no `add`); the `add` line goes in unless an equal one is on. `before` sees what is about to be taken and the record it goes into, before anything is written. */
export function replaceRecords(scope: LedgerScope, take: { kind: LedgerKind; text: string }[], add: Draft | undefined, dir: string = dataDir(), before?: (taken: LedgerRecord[], into?: LedgerRecord) => void): { taken: LedgerRecord[]; record?: LedgerRecord; added: boolean } {
	return change(dir, doc => {
		const mine = doc.records.filter(r => r.state === "on" && sameScope(r.scope, scope));
		const taken: LedgerRecord[] = [];
		for (const t of take) {
			const r = mine.find(x => x.kind === t.kind && x.text === t.text && !taken.includes(x));
			if (r) taken.push(r);
		}
		const draft = add && oneLine(add.text) ? fresh({ ...add, scope }) : undefined;
		const same = draft && doc.records.find(x => x.state === "on" && x.kind === draft.kind && sameScope(x.scope, scope) && textKey(x.kind, x.text) === textKey(draft.kind, draft.text));
		if (!taken.length && (!draft || same)) return { taken: [], record: same, added: false };
		const record = same ?? draft;
		if (taken.length) before?.(taken, record);
		if (draft && !same) doc.records.push(draft);
		for (const r of taken) Object.assign(r, { state: record ? "merged" : "off", ...(record ? { into: record.id } : {}) });
		return { taken, record, added: !!draft && !same };
	});
}

/** Takes the on records of exactly `scope` and one of `kinds` whose text `drop` accepts off; their texts. */
export const removeMatching = (scope: LedgerScope, kinds: LedgerKind[], drop: (text: string) => boolean, dir: string = dataDir()): string[] =>
	change(dir, doc => doc.records.filter(r => r.state === "on" && kinds.includes(r.kind) && sameScope(r.scope, scope) && drop(r.text)).map(r => ((r.state = "off"), r.text)));

/** Turns a record that left the ledger's lines (merged or off) back on, found by `id` or else the newest of that scope, kind and text, and adds it when none is left; false, changing nothing, when an equal line is on already. */
export function bringBack(id: string | undefined, scope: LedgerScope, kind: LedgerKind, text: string, dir: string = dataDir()): boolean {
	return change(dir, doc => {
		const same = (r: LedgerRecord): boolean => r.state !== "mask" && r.kind === kind && sameScope(r.scope, scope) && textKey(kind, r.text) === textKey(kind, text);
		if (doc.records.some(r => r.state === "on" && same(r))) return false;
		const gone = doc.records.find(r => (id !== undefined ? r.id === id : same(r)) && r.state !== "on" && r.state !== "mask") ?? doc.records.findLast(r => same(r));
		if (gone) (gone.state = "on"), delete gone.into;
		else doc.records.push(fresh({ text, kind, scope, by: "restore" }));
		return true;
	});
}

/** The on records of `kind` at exactly `scope`, as lines. */
export const textsAt = (scope: LedgerScope, kind: LedgerKind, dir: string = dataDir()): string[] => readLedger(dir).filter(r => r.state === "on" && r.kind === kind && sameScope(r.scope, scope)).map(r => r.text);

/** Makes the on records of `scope`/`kind` read as `text`, line by line (a line that stays keeps its record; a new line is added, a missing one goes off); the settings screen's way to write. */
export function setLines(scope: LedgerScope, kind: LedgerKind, text: string, by: string, dir: string = dataDir(), whole = false): void {
	change(dir, doc => {
		const want = whole ? [oneLine(text)].filter(Boolean) : lines(text);
		const mine = doc.records.filter(r => r.state === "on" && r.kind === kind && sameScope(r.scope, scope));
		const keep = new Set<string>();
		for (const line of want) {
			const found = mine.find(r => textKey(kind, r.text) === textKey(kind, line));
			if (found) keep.add(found.id);
			else doc.records.push(fresh({ text: line, kind, scope, by }));
		}
		for (const r of mine) if (!keep.has(r.id)) r.state = "off";
	});
}

/** Makes what a draft of `app` follows for `kind` (the settings screen's 기본 규칙 and 이어서 할 일: the lines it inherits, minus the ones it masks, plus its own, broad first) read as `text`, storing only the difference at the scope of `app`: an inherited line left out becomes a mask, one written again clears its mask, a new line is its own record, an own line left out goes off. */
export function setEffective(app: string, kind: LedgerKind, text: string, by: string, dir: string = dataDir()): void {
	change(dir, doc => {
		const scope = { app }, key = (t: string): string => textKey(kind, t);
		const mine = (r: LedgerRecord): boolean => r.kind === kind && sameScope(r.scope, scope);
		const inherited = new Map(chainOver(doc.records.filter(r => !(r.state === "mask" && mine(r))), { app }).filter(r => r.kind === kind && !sameScope(r.scope, scope)).map(r => [key(r.text), r.text]));
		const want = lines(text), wanted = new Set(want.map(key));
		const masks = doc.records.filter(r => r.state === "mask" && mine(r));
		for (const [k, t] of inherited) {
			const own = masks.filter(m => key(m.text) === k);
			if (wanted.has(k)) own.forEach(m => (m.state = "off"));
			else if (!own.length) doc.records.push({ ...fresh({ text: t, kind, scope, by }), state: "mask" });
		}
		const own = doc.records.filter(r => r.state === "on" && mine(r));
		for (const line of want) if (!inherited.has(key(line)) && !own.some(r => key(r.text) === key(line))) doc.records.push(fresh({ text: line, kind, scope, by }));
		for (const r of own) if (!wanted.has(key(r.text))) r.state = "off";
	});
}

export const scopeOfKey = (key: ToneKey | "install"): LedgerScope => {
	if (key === INSTALL || key.app === INSTALL) return {};
	const to = key.to === undefined ? undefined : recipientFile(key.to);
	if (to !== undefined) return { app: recipientApp(key), to: recipientOf(to)! };
	return { app: key.app, ...(key.room === undefined ? {} : { room: roomFile(key.room) }) };
};
const recipientApp = (key: ToneKey): string => (/^mail(-[a-z0-9]+)*$/.test(key.base ?? key.app) ? "mail" : (key.base ?? key.app));

/** The tone key a scope is the profile of (for the journal and the learn log). */
export const keyOfScope = (s: LedgerScope): ToneKey | "install" => (s.app === undefined ? INSTALL : { app: s.app, ...(s.room === undefined ? {} : { room: s.room }), ...(s.to === undefined ? {} : { to: s.to }) });

/** The scope a tone file stands for (`install.md`, `mail.md`, `mail/<room>.md`, `mail/to/<recipient>.md`); undefined for a name no profile has. */
export function scopeOfProfile(profile: string): LedgerScope | undefined {
	if (profile === "install.md") return {};
	const to = /^([a-z0-9-]+)\/to\/([a-z0-9_-]+)\.md$/.exec(profile);
	if (to) return recipientOf(to[2]!) === undefined || to[1] === INSTALL ? undefined : { app: to[1]!, to: recipientOf(to[2]!)! };
	const m = /^([a-z0-9-]+)(?:\/([A-Za-z0-9_-]{1,80}))?\.md$/.exec(profile);
	return m && m[1] !== INSTALL ? { app: m[1]!, ...(m[2] === undefined ? {} : { room: m[2] }) } : undefined;
}

/** The scopes a draft of `key` reads, broadest first: everywhere, the base app (a mail instance's is `mail`), the app, its room, the recipient. */
export const chainOf = (key: ToneKey): LedgerScope[] =>
	levelsOf(key).flatMap(([level, k]) => (level === "app" && k.base ? [scopeOfKey({ app: k.app }), { app: k.base }] : [scopeOfKey(k)])).reverse();

/** The on records of every scope of `key`'s chain, the narrower scope later, of one scope the older first; `rank` = the place of its scope in the chain. A line a narrower scope masks (same kind and text) is left out, and masks are never listed. */
const chainOver = (records: LedgerRecord[], key: ToneKey): (LedgerRecord & { rank: number })[] => {
	const chain = chainOf(key);
	const live = records.flatMap((r, i) => ({ r, i, rank: chain.findIndex(c => sameScope(c, { ...r.scope, request: undefined })) })).filter(x => (x.r.state === "on" || x.r.state === "mask") && x.rank >= 0 && (x.r.scope.request === undefined || x.r.kind === "request"))
		.sort((a, b) => a.rank - b.rank || a.r.at.localeCompare(b.r.at) || a.i - b.i);
	const masked = (x: (typeof live)[number]): boolean => live.some(m => m.r.state === "mask" && m.rank > x.rank && m.r.kind === x.r.kind && textKey(m.r.kind, m.r.text) === textKey(x.r.kind, x.r.text));
	return live.filter(x => x.r.state === "on" && !masked(x)).map(x => ({ ...x.r, rank: x.rank }));
};
export const chainRecords = (key: ToneKey, dir: string = dataDir()): (LedgerRecord & { rank: number })[] => chainOver(readLedger(dir), key);

/** The lines a draft of `app` follows for `kind`, broad first: what the settings screen shows. */
export const effectiveTexts = (app: string, kind: LedgerKind, dir: string = dataDir()): string[] => rulesFor({ app }, [kind], dir).map(r => r.text);

export type Ruled = { text: string; kind: string; rank: number; at?: string; ref?: string };
export type Clash = { a: number; b: number; why: "copy" | "ban-in-rule"; winner: number };
const flat = (s: string): string => normText(s.normalize("NFC"));

/** Conflicts found by code alone, with the one that wins: "copy" = one text at two scopes; "ban-in-rule" = a literal ban whose phrase sits inside a tone, correction or instruction. The narrower rank wins, at equal rank the newer, then the later in the list. Two records of one lesson (same `ref`) never clash. */
export function clashes(rs: Ruled[]): Clash[] {
	const out: Clash[] = [];
	const wins = (i: number, j: number): number => ((rs[i]!.rank - rs[j]!.rank || (rs[i]!.at ?? "").localeCompare(rs[j]!.at ?? "") || i - j) > 0 ? i : j);
	const add = (a: number, b: number, why: Clash["why"]) => {
		if (rs[a]!.ref === undefined || rs[a]!.ref !== rs[b]!.ref) out.push({ a, b, why, winner: wins(a, b) });
	};
	rs.forEach((x, i) => {
		for (let j = i + 1; j < rs.length; j++) if (flat(x.text) === flat(rs[j]!.text) && x.rank !== rs[j]!.rank) add(i, j, "copy");
	});
	rs.forEach((ban, i) => {
		const parsed = ban.kind === "ban" ? parseBan(ban.text) : undefined;
		if (parsed?.kind !== "literal") return;
		rs.forEach((rule, j) => {
			if ((rule.kind === "tone" || rule.kind === "correction" || rule.kind === "instruction") && flat(rule.text).includes(flat(parsed.text))) add(i, j, "ban-in-rule");
		});
	});
	return out;
}

/** The rules of `kinds` a draft of `key` follows: on, broad to narrow, the loser of every clash left out. */
export function rulesFor(key: ToneKey, kinds: LedgerKind[], dir: string = dataDir()): LedgerRecord[] {
	const all = chainRecords(key, dir);
	const lost = new Set(clashes(all).map(c => (c.winner === c.a ? c.b : c.a)));
	return all.filter((r, i) => !lost.has(i) && kinds.includes(r.kind));
}

// ---- the once-per-install migration, its backup and undo ----

const backupDir = (dir: string): string => join(dirname(paths.ledger(dir)), "ledger-backup");
const rel = (dir: string, file: string): string => relative(dir, file);

const strip = (md: string, drop: (heading: string) => boolean): string => {
	let skip = false;
	const kept = md.split("\n").filter(l => (/^## /.test(l) ? (skip = drop(l.trim())) : skip) === false);
	return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
};
const movedHeading = (heading: string): boolean => [HEADINGS.rules, HEADINGS.corrections, HEADINGS.forbidden, HEADINGS.merged].some(h => h === heading) || !Object.values(HEADINGS).some(h => h === heading);

/** The rule lines a tone file holds: its `## 말투`, `## 고친 점` and `## 금지` bullets and every hand-added section's. */
function fileRules(scope: LedgerScope, md: string): Draft[] {
	const mk = (kind: LedgerKind, text: string): Draft => ({ text, kind, scope, by: "migrate" });
	return [
		...bullets(md, HEADINGS.rules).map(t => mk("tone", t)),
		...bullets(md, HEADINGS.corrections).map(t => mk("correction", t)),
		...bullets(md, HEADINGS.forbidden).map(t => mk(banKind(t), t)),
		...unknownSections(md).flatMap(s => s.items.map(t => mk("tone", t))),
	];
}

const toneFiles = (): string[] => (existsSync(paths.toneDir()) ? (readdirSync(paths.toneDir(), { recursive: true }) as string[]).filter(f => f.endsWith(".md")).sort() : []);

/** Mixed copies of one sentence across the mail apps become one record at `mail`: a sentence held by two or more mail apps (apps only, not their mailboxes or recipients). */
function widest(drafts: Draft[]): Draft[] {
	const mailApp = (d: Draft): boolean => d.scope.app !== undefined && d.scope.room === undefined && d.scope.to === undefined && d.scope.request === undefined && /^mail(-[a-z0-9]+)*$/.test(d.scope.app);
	const groups = new Map<string, Draft[]>();
	for (const d of drafts.filter(mailApp)) groups.set(`${d.kind}\0${textKey(d.kind, d.text)}`, [...(groups.get(`${d.kind}\0${textKey(d.kind, d.text)}`) ?? []), d]);
	// Only a sentence every mail app holds goes up: one held by some would reach the others (and `mail`) through inheritance.
	const apps = new Set(["mail", ...drafts.filter(mailApp).map(d => d.scope.app!)]);
	const shared = new Set([...groups.values()].filter(g => g.length > 1 && new Set(g.map(d => d.scope.app)).size === apps.size).flat());
	const seen = new Set<string>();
	return drafts.flatMap(d => {
		if (!shared.has(d)) return [d];
		const key = `${d.kind}\0${textKey(d.kind, d.text)}`;
		return seen.has(key) ? [] : (seen.add(key), [{ ...d, scope: { app: "mail" } }]);
	});
}

type Plan = { edits: Map<string, string>; from: Map<string, Draft[]>; records: LedgerRecord[] };
const MAIL_APP = /^mail(-[a-z0-9]+)*$/;
/** The kinds of config.json: a mail instance had its own and never read the `mail` ones. */
const CONFIG_KINDS: LedgerKind[] = ["instruction", "followup", "request"];

/** For every mail instance seen, a mask for each `mail`-scope line of the config kinds it did not hold before, so that moving the lines up changes nobody's 기본 규칙 or 이어서 할 일. */
function maskInherited(records: LedgerRecord[], found: Draft[], instances: Set<string>, now: Date): LedgerRecord[] {
	const id = (app: string | undefined, d: { kind: LedgerKind; text: string; scope: LedgerScope }): string => `${app}\0${d.kind}\0${d.scope.request ?? ""}\0${textKey(d.kind, d.text)}`;
	const held = new Set(found.map(d => id(d.scope.app, d)));
	return [...instances].filter(app => app !== "mail").flatMap(app => records
		.filter(r => CONFIG_KINDS.includes(r.kind) && r.scope.app === "mail" && r.scope.room === undefined && r.scope.to === undefined && !held.has(id(app, r)))
		.map(r => ({ ...fresh({ text: r.text, kind: r.kind, scope: { ...r.scope, app }, by: "migrate", at: now }), state: "mask" as const })));
}

/** What the migration would do, with nothing written: the new text of every file it changes, the rule lines each file (relative to `dir`) gives up, and the records the ledger gets (equal lines of one scope and kind once). Undefined when there is nothing to move. */
function planMigration(dir: string, now: Date): Plan | undefined {
	const edits = new Map<string, string>(), from = new Map<string, Draft[]>();
	const found: Draft[] = [], instances = new Set<string>();
	for (const name of toneFiles()) {
		const file = join(paths.toneDir(), name), scope = scopeOfProfile(name.split("\\").join("/")), md = readFileSync(file, "utf8");
		if (!scope) continue;
		if (scope.app) instances.add(scope.app);
		const mine = fileRules(scope, md);
		found.push(...mine);
		if (mine.length) from.set(rel(dir, file), mine);
		if (mine.length || bullets(md, HEADINGS.merged).length) edits.set(file, strip(md, movedHeading));
	}
	let config: Record<string, any> | undefined;
	try {
		config = JSON.parse(readFileSync(paths.config(dir), "utf8"));
	} catch {
		config = undefined;
	}
	if (config && typeof config === "object") {
		for (const doc of [config.draftDefaults, config.followups, config.draftRules, config.apps, config.models, config.attachFolders]) if (doc && typeof doc === "object") for (const app of Object.keys(doc)) instances.add(app);
		const by = (kind: LedgerKind, doc: unknown) => Object.entries(doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {}).flatMap(([app, v]) => (typeof v === "string" ? lines(v).map((text): Draft => ({ text, kind, scope: { app }, by: "migrate" })) : []));
		const cfg = [...by("instruction", config.draftDefaults), ...by("followup", config.followups)];
		const rules = config.draftRules && typeof config.draftRules === "object" ? (config.draftRules as Record<string, unknown>) : {};
		for (const [app, list] of Object.entries(rules))
			for (const r of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
				if (r && typeof r.how === "string" && r.how.trim() && typeof r.id === "string") cfg.push({ text: r.how, kind: "request", scope: { app, request: r.id }, by: "migrate" });
				if (r && typeof r.how === "string") r.how = "";
			}
		found.push(...cfg);
		if (cfg.length) from.set(rel(dir, paths.config(dir)), cfg);
		if (cfg.length || config.draftDefaults || config.followups) {
			const { draftDefaults: _d, followups: _f, ...rest } = config;
			edits.set(paths.config(dir), `${JSON.stringify(rest, null, 2)}\n`);
		}
	}
	const seen = new Set<string>();
	const records = widest(found).map(d => fresh({ ...d, at: now })).filter(r => ((k: string) => !seen.has(k) && !!seen.add(k))(`${r.kind}\0${JSON.stringify(r.scope)}\0${textKey(r.kind, r.text)}`));
	const masks = maskInherited(records, found, new Set([...instances].filter(app => MAIL_APP.test(app))), now);
	return records.length || edits.size ? { edits, from, records: [...records, ...masks] } : undefined;
}

/** Moves every rule an install has into the ledger once: the tone files' rule sections, config.json's 기본 규칙, 이어서 할 일 and the 어떻게 of the 자동 초안 규칙. Every file it changes is copied to `ledger-backup/` first (with a manifest); the ledger is written last, so it also marks the install as done. Undefined when it was done before or there was nothing to move. */
export function migrateLedger(dir: string = dataDir(), now: Date = new Date()): { files: string[]; records: number } | undefined {
	const plan = existsSync(paths.ledger(dir)) ? undefined : planMigration(dir, now);
	if (!plan) return undefined;
	const { edits, records } = plan;
	const backup = backupDir(dir);
	const manifest = [...edits.keys()].map(f => ({ file: rel(dir, f), existed: existsSync(f) }));
	for (const f of edits.keys()) {
		const copy = join(backup, "files", rel(dir, f));
		if (!existsSync(copy)) writeAtomic(copy, readFileSync(f));
	}
	writeAtomic(join(backup, "manifest.json"), `${JSON.stringify({ at: now.toISOString(), files: manifest }, null, 1)}\n`);
	for (const [f, text] of edits) writeAtomic(f, text, statSync(f).mode & 0o777);
	change(dir, doc => {
		doc.records = records;
	});
	return { files: manifest.map(m => m.file), records: records.filter(r => r.state === "on").length };
}

/** What `migrateLedger` would move, for a before/after to show before an install updates; nothing is written. Per file the rule lines it gives up (relative to `dir`), and the records the ledger gets by scope and kind with their text count. Undefined when it was done before or there is nothing to move. */
export function previewMigration(dir: string = dataDir()): { files: { file: string; lines: { kind: LedgerKind; text: string }[] }[]; records: { scope: LedgerScope; kind: LedgerKind; texts: number }[] } | undefined {
	const plan = existsSync(paths.ledger(dir)) ? undefined : planMigration(dir, new Date());
	if (!plan) return undefined;
	const groups = new Map<string, { scope: LedgerScope; kind: LedgerKind; texts: number }>();
	for (const r of plan.records.filter(r => r.state === "on")) {
		const g = groups.get(`${r.kind}\0${JSON.stringify(r.scope)}`) ?? { scope: r.scope, kind: r.kind, texts: 0 };
		groups.set(`${r.kind}\0${JSON.stringify(r.scope)}`, { ...g, texts: g.texts + 1 });
	}
	return { files: [...plan.from].map(([file, lines]) => ({ file, lines: lines.map(l => ({ kind: l.kind, text: l.text })) })), records: [...groups.values()] };
}

/** Puts every file the migration changed back byte for byte and removes the ledger it wrote; the files it listed, or undefined when there is nothing to undo. */
export function undoLedger(dir: string = dataDir()): string[] | undefined {
	const manifest = join(backupDir(dir), "manifest.json");
	if (!existsSync(manifest)) return undefined;
	const { files } = JSON.parse(readFileSync(manifest, "utf8")) as { files: { file: string }[] };
	for (const { file } of files) writeAtomic(join(dir, file), readFileSync(join(backupDir(dir), "files", file)), existsSync(join(dir, file)) ? statSync(join(dir, file)).mode & 0o777 : 0o600);
	rmSync(paths.ledger(dir), { force: true });
	rmSync(backupDir(dir), { recursive: true, force: true });
	return files.map(f => f.file);
}

// ---- rules found in a tone file after the migration ----

/** The rule lines still in tone files (written by hand after the migration), by file. */
export function handRules(): { file: string; digest: string; items: Draft[] }[] {
	return toneFiles().flatMap(name => {
		const file = join(paths.toneDir(), name), scope = scopeOfProfile(name.split("\\").join("/")), md = readFileSync(file, "utf8");
		const items = scope ? fileRules(scope, md).map(d => ({ ...d, by: "hand" })) : [];
		return items.length ? [{ file, digest: createHash("sha256").update(md).digest("hex").slice(0, 16), items }] : [];
	});
}

/** The files with hand rules the owner was not asked about yet (per file content), marked as asked; none before the migration. */
export function toAskAbout(dir: string = dataDir()): string[] {
	if (!existsSync(paths.ledger(dir))) return [];
	return change(dir, doc => handRules().filter(h => doc.asked[rel(dir, h.file)] !== h.digest).map(h => ((doc.asked[rel(dir, h.file)] = h.digest), rel(dir, h.file))));
}

/** Moves the hand rules of every tone file into the ledger (each file copied to `ledger-backup/hand/` first). The number of rules moved. */
export function moveHandRules(dir: string = dataDir(), now: Date = new Date()): number {
	let n = 0;
	for (const h of handRules()) {
		const copy = join(backupDir(dir), "hand", now.toISOString().replace(/[:.]/g, "-"), rel(dir, h.file));
		writeAtomic(copy, readFileSync(h.file));
		for (const d of h.items) n += addRecord({ ...d, at: now }, dir).added ? 1 : 0;
		writeAtomic(h.file, strip(readFileSync(h.file, "utf8"), movedHeading));
	}
	return n;
}
