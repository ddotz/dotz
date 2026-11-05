// The reply settings of a mailbox as a draft follows them (docs/mailbox.md "Handling"). No hub/mail.ts here: flow.ts and so the draft CLI load this file, and the mail store is the gateway's.
// Which box a mail is in: box-place.ts.
import { homedir } from "node:os";
import { join } from "node:path";
import type { DraftRule } from "../../../hub/app-settings.ts";
import { boxesOf, type Box } from "../../../hub/mailbox.ts";
import { addressesOf } from "../../../hub/reply-draft.ts";
import { dataDir } from "./settings.ts";

export const boxById = (instance: string, id: string): Box | undefined => boxesOf(dataDir(), instance).find(b => b.id === id);
/** ask, notify and quiet make no automatic draft; a requested one still works. */
export const noAutoDraft = (b: Box | undefined): boolean => b?.mode === "ask" || b?.mode === "notify" || b?.mode === "quiet";

/** The box's own rules in place of the instance's, or undefined when it has none. */
export function boxRules(b: Box | undefined): DraftRule[] | undefined {
	const list = (b?.rules ?? []).flatMap((r, i): DraftRule[] => (typeof r.when === "string" && r.when.trim() ? [{ id: typeof r.id === "string" && r.id ? r.id : `${b!.id}-${i}`, name: typeof r.name === "string" ? r.name : "", when: r.when, how: typeof r.how === "string" ? r.how : "", files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string") : [], on: r.on !== false }] : []));
	return list.length ? list : undefined;
}

/** `how`, the greeting for this sender (a greet's `addr` is an address or `@domain`) and the banned phrases, as instruction lines. */
export function boxLines(b: Box | undefined, from: string | undefined): string[] {
	if (!b) return [];
	const sender = addressesOf(from).map(a => a.toLowerCase());
	const hit = b.greets.find(g => {
		const a = g.addr.trim().toLowerCase();
		return !!g.hello && !!a && (a.startsWith("@") ? sender.some(s => s.endsWith(a)) : sender.includes(a));
	});
	return [...(b.how.trim() ? [b.how.trim(), "이 지시가 배운 말투와 어긋나면 이 지시를 따라요."] : []), hit ? `이 보낸 사람(${hit.who || hit.addr})에게는 "${hit.hello}"(으)로 인사해요.` : "", b.bans.length ? `쓰지 않을 표현: ${b.bans.join(", ")}.` : ""].filter(Boolean);
}

/** One warning line per banned phrase found in the draft (flow.ts ownerWarning words it for the card); sending is not blocked. */
export const banWarnings = (b: Box | undefined, d: { subject?: string; body: string }): string[] => {
	const text = `${d.subject ?? ""}\n${d.body}`.toLowerCase();
	return (b?.bans ?? []).filter(p => text.includes(p.toLowerCase())).map(p => `it uses the forbidden expression '${p}'`);
};

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
/** The box's 첨부 파일 folders, which go in front of the app's own. */
export const boxFolders = (b: Box | undefined): string[] => (b?.folders ?? []).map(expand);
