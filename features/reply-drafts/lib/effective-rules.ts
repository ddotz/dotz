// What applies to one target and where each rule is written, read-only: the tone files the style is merged from (settings.ts styleSources), the mailbox's
// own bans and lines (box.ts), the instance's 기본 규칙 and the matching 자동 초안 규칙's 어떻게 (rules.ts). No file is changed and no model is asked; draft-rules.ts `effective`
// hands over the key it already built, so this never builds a tone key of its own.
// Conflicts found by code alone: "copy" = one text in two records of different scopes; "ban-in-rule" = a literal ban whose phrase sits inside a tone or instruction record
// of the same target (the draft is told to write what it is told not to). Only these two; contradictions in meaning need a model and are not looked for here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBan } from "../../../hub/ban.ts";
import { fileOf } from "../../../hub/mailbox.ts";
import type { RuleAt, RuleItem } from "./draft-rules.ts";
import { boxById, boxGreeting, boxRules } from "./box.ts";
import { rulesOf } from "./rules.ts";
import { bulletLines, dataDir, HEADINGS, listedMailApps, loadSettings, paths, recipientApp, styleSources, type ToneKey, type ToneLevel } from "./settings.ts";

export type RuleScope = "everywhere" | "channel" | "mail-app" | "mailbox" | "recipient" | "request-kind";
export type RuleRecord = { text: string; kind: "tone" | "ban" | "content-ban" | "instruction" | "attach"; scope: RuleScope; source: { file: string; line?: number } };
export type RuleConflict = { a: number; b: number; why: "copy" | "ban-in-rule" };
export type EffectiveRules = { rules: RuleRecord[]; conflicts: RuleConflict[] };

const SCOPES: RuleScope[] = ["everywhere", "channel", "mail-app", "mailbox", "recipient", "request-kind"];
const norm = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

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
	for (const [what, byApp] of Object.entries({ draftDefaults: s.draftDefaults, draftRules: s.draftRules, followups: s.followups, models: s.models, attachFolders: s.attachFolders }))
		out.push(...Object.keys(byApp ?? {}).filter(stray).map(app => ({ what, app, file: paths.config(), line: jsonLine(paths.config(), app, what) })));
	return out;
}

export async function effectiveRules(key: ToneKey, at: RuleAt, item: RuleItem): Promise<EffectiveRules> {
	const records: RuleRecord[] = [];
	// A mailbox of an instance with no file of its own lists the same app file twice (as its own and as its base): one record each.
	for (const s of styleSources(key).reverse().filter((s, i, all) => all.findIndex(o => o.file === s.file) === i)) {
		for (const [heading, kind] of [[HEADINGS.rules, "tone"], [HEADINGS.corrections, "tone"], [HEADINGS.forbidden, "ban"]] as const) {
			records.push(...bulletLines(s.md, heading).map(b => ({ text: b.text, kind, scope: scopeOf(s.level, s.app), source: { file: s.file, line: b.line } })));
		}
	}
	const instance = at.instance ?? at.app ?? "mail";
	const box = at.box && at.instance ? boxById(at.instance, at.box) : undefined;
	const boxFile = fileOf(dataDir());
	const inBox = (text: string, kind: RuleRecord["kind"]): RuleRecord => ({ text, kind, scope: "mailbox", source: { file: boxFile, line: jsonLine(boxFile, text) } });
	if (box) {
		records.push(...box.bans.map(p => inBox(p, "ban")));
		if (box.how.trim()) records.push(inBox(box.how.trim(), "instruction"));
		const hello = boxGreeting(box, item.from);
		if (hello) records.push({ text: hello.line, kind: "instruction", scope: "mailbox", source: { file: boxFile, line: jsonLine(boxFile, hello.hello) } });
	}
	if (item.kind === "mail" && !box?.alone) {
		const { base, rules } = await rulesOf(instance);
		if (base.trim()) records.push({ text: base.trim(), kind: "instruction", scope: "mail-app", source: { file: paths.config(), line: jsonLine(paths.config(), base.trim(), "draftDefaults") } });
		const rule = (boxRules(box) ?? rules).find(r => r.id === at.rule?.id);
		if (rule?.how.trim()) {
			const own = boxRules(box) !== undefined;
			records.push({ text: rule.how.trim(), kind: "instruction", scope: "request-kind", source: own ? { file: boxFile, line: jsonLine(boxFile, rule.how.trim()) } : { file: paths.config(), line: jsonLine(paths.config(), rule.how.trim(), "draftRules") } });
		}
	}
	const sorted = records.map((r, i) => ({ r, i })).sort((x, y) => SCOPES.indexOf(x.r.scope) - SCOPES.indexOf(y.r.scope) || x.i - y.i).map(x => x.r);
	return { rules: sorted, conflicts: conflictsOf(sorted) };
}

function conflictsOf(rules: RuleRecord[]): RuleConflict[] {
	const out: RuleConflict[] = [];
	rules.forEach((a, i) => {
		for (let j = i + 1; j < rules.length; j++) if (norm(a.text) === norm(rules[j]!.text) && a.scope !== rules[j]!.scope) out.push({ a: i, b: j, why: "copy" });
	});
	rules.forEach((ban, i) => {
		const parsed = ban.kind === "ban" ? parseBan(ban.text) : undefined;
		if (parsed?.kind !== "literal") return;
		rules.forEach((rule, j) => {
			if ((rule.kind === "tone" || rule.kind === "instruction") && norm(rule.text).includes(norm(parsed.text))) out.push({ a: i, b: j, why: "ban-in-rule" });
		});
	});
	return out;
}
