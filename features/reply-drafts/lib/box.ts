// The reply settings of a mailbox as a draft follows them (docs/mailbox.md "Handling"). No hub/mail.ts here: flow.ts and so the draft CLI load this file, and the mail store is the gateway's.
// Which box a mail is in: box-place.ts.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DraftRule } from "../../../hub/app-settings.ts";
import { withLock } from "../../../hub/file-lock.ts";
import { boxesOf, loadMailboxes, saveMailboxes, type Box } from "../../../hub/mailbox.ts";
import { addressesOf } from "../../../hub/reply-draft.ts";
import { dataDir, writeAtomic } from "./settings.ts";

export const boxById = (instance: string, id: string): Box | undefined => boxesOf(dataDir(), instance).find(b => b.id === id);
/** ask, notify and quiet make no automatic draft; a requested one still works. */
export const noAutoDraft = (b: Box | undefined): boolean => b?.mode === "ask" || b?.mode === "notify" || b?.mode === "quiet";

/** The box's own rules in place of the instance's, or undefined when it has none. */
export function boxRules(b: Box | undefined): DraftRule[] | undefined {
	const list = (b?.rules ?? []).flatMap((r, i): DraftRule[] => (typeof r.when === "string" && r.when.trim() ? [{ id: typeof r.id === "string" && r.id ? r.id : `${b!.id}-${i}`, name: typeof r.name === "string" ? r.name : "", when: r.when, how: typeof r.how === "string" ? r.how : "", files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string") : [], on: r.on !== false }] : []));
	return list.length ? list : undefined;
}

/** The greeting the box sets for this sender (a greet's `addr` is an address or `@domain`) with the greet it came from; undefined when none matches. */
export function boxGreeting(b: Box, from: string | undefined): { line: string; hello: string } | undefined {
	const sender = addressesOf(from).map(a => a.toLowerCase());
	const hit = b.greets.find(g => {
		const a = g.addr.trim().toLowerCase();
		return !!g.hello && !!a && (a.startsWith("@") ? sender.some(s => s.endsWith(a)) : sender.includes(a));
	});
	return hit && { line: `이 보낸 사람(${hit.who || hit.addr})에게는 "${hit.hello}"(으)로 인사해요.`, hello: hit.hello };
}

/** `how`, the greeting for this sender and the banned phrases, as instruction lines of the configured instruction (rules.ts ruleInstruction), which a newer learned correction outranks. */
export function boxLines(b: Box | undefined, from: string | undefined): string[] {
	if (!b) return [];
	return [b.how.trim(), boxGreeting(b, from)?.line ?? "", b.bans.length ? `쓰지 않을 표현: ${b.bans.join(", ")}.` : ""].filter(Boolean);
}

/** One mailbox setting a learned correction rewrote (learn.ts): the box's `how`, or the `how` of its rule `rule`, from `before` to `after`; `undoneAt` once put back. */
export type BoxFix = { at: string; instance: string; box: string; rule?: string; before: string; after: string; ref: string; undoneAt?: string };
const fixFile = () => join(dataDir(), "mailbox-fixes.jsonl");
const FIX_LOCK = "메일함 설정 고침";
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The fixes, oldest first; an entry's number is its place in this list counted from 1. */
export const boxFixes = (): BoxFix[] => (existsSync(fixFile()) ? readFileSync(fixFile(), "utf8").split("\n").flatMap(l => { try { return l.trim() ? [JSON.parse(l) as BoxFix] : []; } catch { return []; } }) : []);

// Sets the text that now reads `from` (whitespace aside) in box `boxId` of `instance` to `to`: its own `how` or one rule's. The place it changed, or undefined when no such text is there.
function setBoxText(instance: string, boxId: string, from: string, to: string, rule?: string): { rule?: string } | undefined {
	const dir = dataDir(), store = structuredClone(loadMailboxes(dir));
	const box = store.accounts[instance]?.boxes.find(b => b.id === boxId);
	if (!box) return undefined;
	const ids = box.rules.map((r, i) => (typeof r.id === "string" && r.id ? r.id : `${box.id}-${i}`));
	const own = rule === undefined && flat(box.how) === flat(from);
	const at = own ? -1 : box.rules.findIndex((r, i) => (rule === undefined || ids[i] === rule) && typeof r.how === "string" && flat(r.how) === flat(from));
	if (own) box.how = to;
	else if (at >= 0) box.rules[at] = { ...box.rules[at], how: to };
	else return undefined;
	saveMailboxes(dir, store);
	return at >= 0 ? { rule: ids[at] ?? String(at) } : {};
}

/** Rewrites the mailbox setting `before` of box `boxId` to the learned line `after`, keeping the line before in mailbox-fixes.jsonl so `undoBoxFix` puts it back. The fix's number, or undefined when that setting is no longer there. */
export function fixBoxSetting(instance: string, boxId: string, before: string, after: string, ref: string, now: Date = new Date()): number | undefined {
	return withLock(fixFile(), FIX_LOCK, () => {
		const place = setBoxText(instance, boxId, before, after);
		if (!place) return undefined;
		const fix: BoxFix = { at: now.toISOString(), instance, box: boxId, ...place, before, after, ref };
		appendFileSync(fixFile(), `${JSON.stringify(fix)}\n`, { mode: 0o600 });
		return boxFixes().length;
	});
}

/** Puts the line before fix `n` back, when the setting still reads what the fix wrote. The fix, `put` whether the line went back; undefined when there is no fix `n`. */
export function undoBoxFix(n: number, now: Date = new Date()): { fix: BoxFix; put: boolean } | undefined {
	return withLock(fixFile(), FIX_LOCK, () => {
		const all = boxFixes(), fix = Number.isInteger(n) && n >= 1 ? all[n - 1] : undefined;
		if (!fix) return undefined;
		const put = !fix.undoneAt && !!setBoxText(fix.instance, fix.box, fix.after, fix.before, fix.rule);
		if (put) writeAtomic(fixFile(), all.map((f, i) => `${JSON.stringify(i === n - 1 ? { ...f, undoneAt: now.toISOString() } : f)}\n`).join(""));
		return { fix, put };
	});
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
/** The box's 첨부 파일 folders, which go in front of the app's own. */
export const boxFolders = (b: Box | undefined): string[] => (b?.folders ?? []).map(expand);
