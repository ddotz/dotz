// Learning one lesson line into the tone profiles that read it (design 3.4): the profile it was given for and, for the whole mail app, each mail app
// instance whose drafts read a file of their own. Every learning path (correct, revise, the owner's own edit, a 보내지 않기 reason) goes through here.
import { CONTENT_PREFIX } from "../../../hub/ban.ts";
import { curate, curateAsk, journalAdd, type LearnKind, profileOf } from "./curate.ts";
import type { FlowDeps } from "./flow.ts";
import { HEADINGS, INSTALL, normText, ownToneMailApps, profileBullets, recordForbidden as recordForbiddenIn, replaceBullets, type ToneKey } from "./settings.ts";

/** The mail app instances a lesson of `key` is also learned into: a lesson for the whole mail app (no room, recipient or base) goes into each instance whose drafts read a file of its own (ownToneMailApps), since those drafts would not see it in mail.md alone. */
export const alsoInto = (key: ToneKey | "install"): ToneKey[] => (key !== INSTALL && key.app === "mail" && key.room === undefined && key.to === undefined && key.base === undefined ? ownToneMailApps().map(app => ({ app })) : []);

/** Forbidden wordings written under `## 금지` of `key`, and of every profile `alsoInto(key)` names. */
export function recordForbidden(key: ToneKey | "install", words: string[]): void {
	for (const k of [key, ...alsoInto(key)]) recordForbiddenIn(k, words);
}

// A correction phrased as a prohibition ("용도를 묻지 않기", "~하지 마") is a content ban, not a dated 고친 점: it stays in the prompt and the check whatever its age.
const PROHIBITION = /지\s*(?:마(?:요|라|세요)?|말(?:기|아|라|자)|않기)[\s.!。]*$/u;

/** What `learnLine` did: whether the line went in, as what, the old lines it replaced, and the standing rule that already says it (`same`, nothing stored); `also`: the same for each profile of `alsoInto(key)`. */
export type LineLearned = { stored: boolean; kind: LearnKind; replaced: string[]; same?: string; also?: (LineLearned & { app: string })[] };

/** Learns one line the owner asked for into the profile of `key` and, the same way, into each of `alsoInto(key)` (every learning path: correct, revise, the owner's own edit, a 보내지 않기 reason). */
export async function learnLine(key: ToneKey | "install", line: string, kind: LearnKind, deps: FlowDeps): Promise<LineLearned> {
	const learned = await learnInto(key, line, kind, deps);
	const also: (LineLearned & { app: string })[] = [];
	for (const sub of alsoInto(key)) also.push({ app: sub.app, ...(await learnInto(sub, line, kind, deps)) });
	return also.length ? { ...learned, also } : learned;
}

/** Learns one line into exactly the profile of `key`: `curate` (through `deps.learnCall`) names the lines it repeats or overrides; a standing rule an existing rule already says stores nothing, else the named lines are journalled and taken out and the line is stored as `recordRule` / `recordCorrection` store it (a correction dated today), in one locked edit. Without a call, or when it fails, the line is stored as it is. */
async function learnInto(key: ToneKey | "install", line: string, kind: LearnKind, deps: FlowDeps): Promise<LineLearned> {
	const text = line.replace(/\s+/g, " ").trim();
	if (!text) return { stored: false, kind, replaced: [] };
	if (kind === "correction" && PROHIBITION.test(text)) {
		recordForbiddenIn(key, [`${CONTENT_PREFIX} ${text}`]);
		return { stored: true, kind, replaced: [] };
	}
	const rules = profileBullets(key, HEADINGS.rules), corrections = profileBullets(key, HEADINGS.corrections);
	const equal = kind === "rule" ? rules.find(r => normText(r) === normText(text)) : undefined;
	if (equal !== undefined) return { stored: false, kind, replaced: [], same: equal };
	const app = key === INSTALL ? INSTALL : key.app;
	const learnCall = deps.learnCall;
	const { replaces } = learnCall ? await curate({ rules, corrections }, { line: text, kind }, curateAsk((system, user) => learnCall(app)(system, user))) : { replaces: [] };
	const lineOf = (id: string): string => (id.startsWith("R") ? rules : corrections)[Number(id.slice(1)) - 1] ?? "";
	const same = kind === "rule" ? replaces.map(r => (r.id.startsWith("R") && r.why === "same" ? lineOf(r.id) : "")).find(l => l && profileBullets(key, HEADINGS.rules).includes(l)) : undefined;
	if (same) return { stored: false, kind, replaced: [], same };
	const now = (deps.now ?? (() => new Date()))();
	const newLine = kind === "rule" ? text : `${now.toISOString().slice(0, 10)}: ${text}`;
	const take = replaces.map(r => ({ heading: r.id.startsWith("R") ? HEADINGS.rules : HEADINGS.corrections, line: lineOf(r.id), why: r.why, into: newLine }));
	const profile = profileOf(key);
	const journal = (taken: typeof take) => journalAdd(taken.map(t => ({ at: now.toISOString(), profile, heading: t.heading, line: t.line, why: t.why, by: "curate", newLine })));
	const done = replaceBullets(key, take, { heading: kind === "rule" ? HEADINGS.rules : HEADINGS.corrections, line: newLine, once: kind === "rule" }, journal);
	return { stored: done.added, kind, replaced: done.taken.map(t => t.line) };
}
