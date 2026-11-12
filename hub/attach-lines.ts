// A send approval a session wrote itself (not a dotz mail draft; its own tool sends the mail): the owner's send sheet can open a `> 첨부:` file only
// through a `[file] /absolute/path` line of the same post (hub/draft-attach.ts askedFiles). A post that names a file with no such line goes back to
// its author once, per ref; the same ref posted again is not held, so the author is never trapped. The posts it applies to cost one substring test.
import { basename } from "node:path";
import { parseDraftApproval } from "./draft-approval.ts";
import { isDotzDraft } from "./draft-attach.ts";
import { fileLinePaths } from "./files.ts";

const nfc = (s: string) => s.normalize("NFC").trim();
const returned = new Set<string>();
const RETURNED_MAX = 500;

// The note for the author of a send approval with files named and no [file] line for them; undefined when there is nothing to return.
export function attachNote(text: string): string | undefined {
	if (!text.includes("> 첨부")) return undefined;
	const draft = parseDraftApproval(text);
	const ref = draft?.ref;
	if (!draft || !ref || returned.has(ref) || isDotzDraft(ref)) return undefined;
	const lines = fileLinePaths(text).map(p => nfc(basename(p)));
	const missing = (draft.attachments ?? []).map(a => a.name).filter(name => !lines.includes(nfc(name)));
	if (!missing.length) return undefined;
	returned.add(ref);
	if (returned.size > RETURNED_MAX) returned.delete(returned.values().next().value!);
	return `[dotz gateway] This send approval names ${missing.map(n => `"${n}"`).join(", ")} in its "> 첨부:" lines but has no "[file] /absolute/path" line for ${missing.length > 1 ? "them" : "it"}, so the owner's send sheet cannot show or open ${missing.length > 1 ? "them" : "it"}. That post was held back and not delivered: send the whole post again with one "[file] /absolute/path" line added per file named.`;
}
