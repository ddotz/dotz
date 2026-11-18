import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./types.ts";
import { isRecord, list } from "./util.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");
const PRINCIPLE_ID = /(?<![\w-])(?<![\w.~-]\/)principle-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g;

/** The reply an assistant message carries: its `text` blocks joined by newlines; thinking and tool-call blocks are not part of it. */
export function replyText(content: unknown): string {
	return (list(content) ?? []).flatMap(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

/** The principle skills installed next to the harness: the names of the `principle-*` directories under the skills directory. */
export function installedPrinciples(dir: string = SKILLS_DIR): Set<string> {
	return new Set(existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith("principle-")) : []);
}

/** The principle ids (`principle-<kebab>`, whole tokens not preceded by `/`) that `reply` names, that are in `known` (default: `installedPrinciples()`), and whose skill is not among `read`, the skills the run read; each id once, in the order the reply first names it. */
export function uncitedReads(reply: string, read: Iterable<string>, known: ReadonlySet<string> = installedPrinciples()): string[] {
	const seen = new Set(read);
	return [...new Set(reply.match(PRINCIPLE_ID))].filter(id => known.has(id) && !seen.has(id));
}

/** What a stop refuses a reply for when it cites principles the run did not read: one `cite:unread-principle` finding naming them, none when `reply` is undefined or cites only principles in `read` or ids that name no skill in `known` (default: `installedPrinciples()`). */
export function citationFindings(reply: string | undefined, read: Iterable<string>, known: ReadonlySet<string> = installedPrinciples()): Finding[] {
	const unread = uncitedReads(reply ?? "", read, known);
	if (unread.length === 0) return [];
	const message = `Your reply cites ${unread.join(", ")}, but this run did not read ${unread.length === 1 ? "that skill" : "those skills"}. For each, read skill://<id> and confirm it shaped the decision, or drop the citation.`;
	return [{ stage: "cite", class: "unread-principle", message }];
}
