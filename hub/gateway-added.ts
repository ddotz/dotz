// The one place that decides which parts of a prompt the gateway added for the model; every text made from a prompt that goes to a screen uses ownerView.
// The line shapes come from the catalogs that write them (hub/i18n-*.ts), not from a second copy of the wording.
import { CATALOGS, msg } from "./i18n.ts";
import type { Catalog } from "./i18n-en.ts";

const SLOT = "\u0001";
const INBOX_HEAD = /^\[dotz inbox\]/;
const GATEWAY_HEAD = "[dotz gateway]";
// Tags that start a line the gateway or the extension adds to an owner prompt: the preface and contract re-read ([dotz gateway], [dotz]:
// i18n-*.ts youAre / replayLead, extension/index.ts contract after a compaction, owner-values.ts, task-cap.ts) and the guard notes
// ([orchestrator-guard]: extension/guard.ts, guard-notes.ts). [dotz inbox] and [dotz lane <name>] are other tags and stay out.
const ADDED_TAGS = [GATEWAY_HEAD, "[dotz]", "[orchestrator-guard]"];

const shapes = (c: Catalog): [before: string, after: string][] =>
	[c.workChannels([SLOT]), c.replyIn(SLOT, false), c.replyIn(SLOT, true), c.ownerAnswerNudge, c.decisionAsked(SLOT), c.laneLanguage(SLOT), c.nowRunning, c.retainNudge]
		.map(s => s.split(SLOT))
		.map(parts => [parts[0]!, parts.length > 1 ? parts.at(-1)! : ""]);

export function isGatewayNote(line: string): boolean {
	const l = line.trimStart();
	return [...Object.values(CATALOGS), msg()].some(c => shapes(c).some(([pre, post]) => l.startsWith(pre) && (!post || l.trimEnd().endsWith(post) || l.length < pre.length + post.length)));
}

// Where a gateway-added part starts: a note's first line is enough (a note may span lines), so only the opening is compared.
const startsAdded = (line: string): boolean => {
	const l = line.trimStart();
	return ADDED_TAGS.some(t => l.startsWith(t)) || [...Object.values(CATALOGS), msg()].some(c => shapes(c).some(([pre]) => pre && l.startsWith(pre)));
};

/** A prompt as the owner may read it; "" when nothing in it is the owner's. With a [dotz inbox] header the owner's part is what follows it up to the first gateway-added line, and the rest is cut. A stored copy cut inside a note's closing parenthesis still counts as a note. */
export function ownerView(prompt: string): string {
	const all = prompt.split("\n");
	const head = all.findIndex(l => INBOX_HEAD.test(l));
	if (head >= 0) {
		const rest = all.slice(head + 1);
		const cut = rest.findIndex(startsAdded);
		return (cut < 0 ? rest : rest.slice(0, cut)).join("\n").trim();
	}
	if (prompt.startsWith(GATEWAY_HEAD)) return "";
	return all
		.filter(l => !isGatewayNote(l))
		.join("\n")
		.trim();
}
