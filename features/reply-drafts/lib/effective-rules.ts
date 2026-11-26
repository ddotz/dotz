// What applies to one target and where each rule is written, read-only: a view over the rule ledger (ledger.ts chainRecords: the records of every scope the target reads, with the id
// each is written under), the hand-written lines still in tone files (settings.ts styleSources) and the mailbox's own bans and lines (box.ts). No file is changed and no model is asked;
// draft-rules.ts `effective` hands over the key it already built, so this never builds a tone key of its own.
// Conflicts found by code alone (ledger.ts clashes): "copy" = one text in two records of different scopes; "ban-in-rule" = a literal ban whose phrase sits inside a tone or instruction record
// of the same target. `winner` is the one the draft follows (narrower scope, then newer). Contradictions in meaning need a model and are not looked for here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentBan, parseBan } from "../../../hub/ban.ts";
import { fileOf } from "../../../hub/mailbox.ts";
import type { RuleAt, RuleItem } from "./draft-rules.ts";
import { boxById, boxGreeting, boxRules } from "./box.ts";
import { chainRecords, clashes, readLedger, textsAt } from "./ledger.ts";
import { bulletLines, dataDir, HEADINGS, listedMailApps, loadSettings, paths, recipientApp, styleSources, type ToneKey, type ToneLevel } from "./settings.ts";

export type RuleScope = "everywhere" | "channel" | "mail-app" | "mailbox" | "recipient" | "request-kind";
export type RuleRecord = { text: string; kind: "tone" | "ban" | "content-ban" | "instruction" | "attach"; scope: RuleScope; source: { file: string; line?: number; id?: string } };
export type RuleConflict = { a: number; b: number; why: "copy" | "ban-in-rule"; winner: number };
export type EffectiveRules = { rules: RuleRecord[]; conflicts: RuleConflict[] };

const SCOPES: RuleScope[] = ["everywhere", "channel", "mail-app", "mailbox", "recipient", "request-kind"];
function scopeOf(level: ToneLevel, app: string): RuleScope {
	const mail = recipientApp(app) === "mail";
	return level === "install" ? "everywhere" : level === "to" ? "recipient" : level === "room" ? (mail ? "mailbox" : "recipient") : mail && app !== "mail" ? "mail-app" : "channel";
}

/** The line of `file` that holds `text` (as a JSON string), looking from the line holding `after`; undefined when it is not there. */
function jsonLine(file: string, text: string, after?: string): number | undefined {
	if (!existsSync(file)) return undefined;
	const lines = readFileSync(file, "utf8").split("\n");
	const from = after === undefined ? 0 : Math.max(0, lines.findIndex(l => l.includes(`"${after}"`)));
	const at = lines.findIndex((l, i) => i >= from && l.includes(JSON.stringify(text).slice(1, -1)));
	return at < 0 ? undefined : at + 1;
}

/** Tone files and config.json keys of a mail app that is not in the app list: no draft is made for it, so nothing reads them. Only mail apps are judged: the list is the whole truth for them, not for a comment source. */
export function unreadSources(): { what: string; app: string; file: string; line?: number }[] {
	const listed = new Set(["mail", ...listedMailApps()]);
	const stray = (app: string): boolean => recipientApp(app) === "mail" && !listed.has(app);
	const out: { what: string; app: string; file: string; line?: number }[] = [];
	const entries = existsSync(paths.toneDir()) ? readdirSync(paths.toneDir(), { withFileTypes: true }) : [];
	for (const e of entries) {
		const app = e.isDirectory() ? e.name : e.name.replace(/\.md$/, "");
		if (!stray(app) || (!e.isDirectory() && !e.name.endsWith(".md"))) continue;
		const files = e.isDirectory() ? readdirSync(join(paths.toneDir(), e.name)).filter(f => f.endsWith(".md")).sort().map(f => join(paths.toneDir(), e.name, f)) : [join(paths.toneDir(), e.name)];
		out.push(...files.map(file => ({ what: "말투 파일", app, file })));
	}
	out.sort((x, y) => (x.file < y.file ? -1 : 1));
	const s = loadSettings();
	for (const [what, byApp] of Object.entries({ draftRules: s.draftRules, models: s.models, attachFolders: s.attachFolders }))
		out.push(...Object.keys(byApp ?? {}).filter(stray).map(app => ({ what, app, file: paths.config(), line: jsonLine(paths.config(), app, what) })));
	out.push(...readLedger().filter(r => r.state === "on" && r.scope.app !== undefined && stray(r.scope.app)).map(r => ({ what: "규칙 장부", app: r.scope.app!, file: paths.ledger() })));
	return out;
}

export async function effectiveRules(key: ToneKey, at: RuleAt, item: RuleItem): Promise<EffectiveRules> {
	const records: (RuleRecord & { rank: number; at?: string; ref?: string })[] = [];
	const other = (r: RuleRecord) => records.push({ ...r, rank: 10 + SCOPES.indexOf(r.scope) });
	// A mailbox of an instance with no file of its own lists the same app file twice (as its own and as its base): one record each.
	for (const s of styleSources(key).reverse().filter((s, i, all) => all.findIndex(o => o.file === s.file) === i)) {
		for (const [heading, kind] of [[HEADINGS.rules, "tone"], [HEADINGS.corrections, "tone"], [HEADINGS.forbidden, "ban"]] as const) {
			bulletLines(s.md, heading).forEach(b => other({ text: b.text, kind: kind === "ban" && contentBan(parseBan(b.text)) !== undefined ? "content-ban" : kind, scope: scopeOf(s.level, s.app), source: { file: s.file, line: b.line } }));
		}
	}
	const instance = at.instance ?? at.app ?? "mail";
	const box = at.box && at.instance ? boxById(at.instance, at.box) : undefined;
	const boxFile = fileOf(dataDir());
	const inBox = (text: string, kind: RuleRecord["kind"]): RuleRecord => ({ text, kind, scope: "mailbox", source: { file: boxFile, line: jsonLine(boxFile, text) } });
	const rules = item.kind === "mail" && !box?.alone;
	for (const r of chainRecords(key)) {
		if (r.kind === "request" || r.kind === "followup" || (r.kind === "instruction" && !rules)) continue;
		const scope: RuleScope = r.kind === "instruction" ? "mail-app" : r.scope.to !== undefined ? "recipient" : r.scope.room !== undefined ? (recipientApp(r.scope.app!) === "mail" ? "mailbox" : "recipient") : r.scope.app === undefined ? "everywhere" : recipientApp(r.scope.app) === "mail" && r.scope.app !== "mail" ? "mail-app" : "channel";
		records.push({ text: r.text, kind: r.kind === "correction" ? "tone" : r.kind, scope, source: { file: paths.ledger(), id: r.id }, rank: r.rank, at: r.at, ref: r.ref });
	}
	if (box) {
		box.bans.forEach(p => other(inBox(p, "ban")));
		if (box.how.trim()) other(inBox(box.how.trim(), "instruction"));
		const hello = boxGreeting(box, item.from);
		if (hello) other({ text: hello.line, kind: "instruction", scope: "mailbox", source: { file: boxFile, line: jsonLine(boxFile, hello.hello) } });
	}
	if (rules && at.rule) {
		const own = boxRules(box)?.find(r => r.id === at.rule?.id);
		const how = own?.how.trim() ?? textsAt({ app: instance, request: at.rule.id }, "request").join("\n");
		if (how) other({ text: how, kind: "instruction", scope: "request-kind", source: own ? { file: boxFile, line: jsonLine(boxFile, how) } : { file: paths.ledger() } });
	}
	const sorted = records.map((r, i) => ({ r, i })).sort((x, y) => SCOPES.indexOf(x.r.scope) - SCOPES.indexOf(y.r.scope) || x.i - y.i).map(x => x.r);
	return { rules: sorted.map(({ rank: _r, at: _a, ref: _f, ...r }) => r), conflicts: clashes(sorted) };
}
