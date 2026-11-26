// Learning one lesson line into the rule ledger at the scope of the profile it was given for (design 3.4). A lesson for the whole mail app is one record at the `mail` scope that every
// mail app instance reads under its own, never a copy. Every learning path (correct, revise, the owner's own edit, a 보내지 않기 reason) goes through here.
import { CONTENT_PREFIX } from "../../../hub/ban.ts";
import { curate, curateAsk, journalAdd, type LearnKind, profileOf } from "./curate.ts";
import type { FlowDeps } from "./flow.ts";
import { type LedgerKind, replaceRecords, scopeOfKey } from "./ledger.ts";
import { HEADINGS, INSTALL, normText, profileBullets, recordForbidden, type ToneKey } from "./settings.ts";

// A correction phrased as a prohibition ("용도를 묻지 않기", "~하지 마") is a content ban, not a dated 고친 점: it stays in the prompt and the check whatever its age.
const PROHIBITION = /지\s*(?:마(?:요|라|세요)?|말(?:기|아|라|자)|않기)[\s.!。]*$/u;

/** The ledger line a learned `text` of `kind` is stored as at `now`: a standing rule as it is, a prohibition a content ban, any other correction dated. */
export const putOf = (kind: LearnKind, text: string, now: Date): { kind: LedgerKind; text: string } =>
	kind === "rule" ? { kind: "tone", text } : PROHIBITION.test(text) ? { kind: "content-ban", text: `${CONTENT_PREFIX} ${text}` } : { kind: "correction", text: `${now.toISOString().slice(0, 10)}: ${text}` };

/** What `learnLine` did: whether the line went in (`id`: its record), as what, the old lines it replaced, and the standing rule that already says it (`same`, nothing stored). */
export type LineLearned = { stored: boolean; kind: LearnKind; replaced: string[]; same?: string; id?: string };

/** Learns one line the owner asked for into the scope of `key`: `curate` (through `deps.learnCall`) names the lines it repeats or overrides; a standing rule an existing rule already says stores nothing, else the named lines are journalled and become `merged` into the new record, in one locked edit. Without a call, or when it fails, the line is stored as it is. `ref`: the card the lesson came from. */
export async function learnLine(key: ToneKey | "install", line: string, kind: LearnKind, deps: FlowDeps, ref?: string): Promise<LineLearned> {
	const text = line.replace(/\s+/g, " ").trim();
	if (!text) return { stored: false, kind, replaced: [] };
	const now = (deps.now ?? (() => new Date()))();
	const put = putOf(kind, text, now);
	if (put.kind === "content-ban") {
		recordForbidden(key, [put.text], ref);
		return { stored: true, kind, replaced: [] };
	}
	const rules = profileBullets(key, HEADINGS.rules), corrections = profileBullets(key, HEADINGS.corrections);
	const equal = kind === "rule" ? rules.find(r => normText(r) === normText(text)) : undefined;
	if (equal !== undefined) return { stored: false, kind, replaced: [], same: equal };
	const app = key === INSTALL ? INSTALL : key.app;
	const learnCall = deps.learnCall;
	const { replaces } = learnCall ? await curate({ rules, corrections }, { line: text, kind }, curateAsk((system, user) => learnCall(app)(system, user))) : { replaces: [] };
	const lineOf = (id: string): string => (id.startsWith("R") ? rules : corrections)[Number(id.slice(1)) - 1] ?? "";
	const same = kind === "rule" ? replaces.map(r => (r.id.startsWith("R") && r.why === "same" ? lineOf(r.id) : "")).find(l => l && rules.includes(l)) : undefined;
	if (same) return { stored: false, kind, replaced: [], same };
	const take = replaces.map(r => ({ kind: (r.id.startsWith("R") ? "tone" : "correction") as LedgerKind, text: lineOf(r.id), why: r.why }));
	const profile = profileOf(key);
	const journal = (taken: { id: string; text: string; kind: LedgerKind }[], into?: { text: string }) =>
		journalAdd(taken.map(t => ({ at: now.toISOString(), profile, heading: t.kind === "tone" ? HEADINGS.rules : HEADINGS.corrections, line: t.text, id: t.id, why: take.find(k => k.text === t.text)!.why, by: "curate" as const, newLine: into?.text ?? "" })));
	const done = replaceRecords(scopeOfKey(key), take, { ...put, scope: scopeOfKey(key), by: "learn", ref, at: now }, undefined, journal);
	return { stored: done.added, kind, replaced: done.taken.map(t => t.text), ...(done.record ? { id: done.record.id } : {}) };
}
