// A spec as Slack Block Kit blocks (hub/messenger-slack.ts sends them beside `text`, which stays the shown text). mrkdwn escapes & < >, so `<@U1>` and `<!channel>` arrive as text.
// Slack limits: 50 blocks, 3000 chars per text, 10 fields of 2000. A component past one is drawn as mrkdwn text in sections; past 50 blocks everything is text in sections; still over, there are no blocks.
import { elementPlain, specChildren, type MessageSpec, type SpecElement } from "./message-spec.ts";
import { inlineTokens } from "./spec-inline.ts";

export type Block = Record<string, unknown>;
export const SLACK_LIMITS = { blocks: 50, text: 3000, fields: 10, field: 2000 };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A spec string as mrkdwn: marks kept, `<url|label>` for a link, everything else escaped. */
export function mrkdwn(s: string): string {
	return inlineTokens(s)
		.map(k => {
			const t = esc(k.text);
			if (k.t === "link") return k.text === k.href ? `<${k.href!.replace(/[&|]/g, c => (c === "&" ? "&amp;" : "%7C"))}>` : `<${k.href!.replace(/[&|]/g, c => (c === "&" ? "&amp;" : "%7C"))}|${t}>`;
			return k.t === "b" ? `*${t}*` : k.t === "i" ? `_${t}_` : k.t === "s" ? `~${t}~` : k.t === "code" ? `\`${t}\`` : t;
		})
		.join("");
}
const strong = (s: string): string => `*${esc(inlineTokens(s).map(k => k.text).join(""))}*`;

/** Model markdown as mrkdwn, line by line: a heading is bold, a quote keeps its `>`, a ``` fence is left alone. */
function body(s: string): string[] {
	let fence = false;
	return s.split("\n").map(line => {
		if (/^\s*```/.test(line)) {
			fence = !fence;
			return "```";
		}
		if (fence) return esc(line);
		const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (h) return strong(h[1]!);
		return line.startsWith("> ") ? `> ${mrkdwn(line.slice(2))}` : mrkdwn(line);
	});
}

type Row = { key: string; value?: string; from?: string; to?: string; count?: string };
const change = (r: Row): string => (r.value !== undefined ? mrkdwn(r.value) : `~${esc(r.from ?? "")}~ → *${esc(r.to ?? "")}*`);
const fact = (r: Row): string => `${strong(r.key)}${r.count ? ` (${mrkdwn(r.count)})` : ""} ${change(r)}`.trimEnd();
const head = (h: unknown): string[] => (h ? [strong(String(h))] : []);
const dot = (cells: (string | undefined)[]): string => cells.filter(Boolean).join(" · ");

const LINES: Partial<Record<string, (p: any) => string[]>> = {
	Text: p => body(p.text),
	Facts: p => [...head(p.head), ...p.rows.map(fact)],
	Section: p => [strong(p.title), ...p.rows.map(fact)],
	Schedule: p => [...head(p.head), ...p.rows.map((r: { time: string; text: string }) => `*${r.time}* ${mrkdwn(r.text)}`)],
	Table: p => [...(p.head ? [`_${esc(p.head.join(" · "))}_`] : []), ...p.rows.map((r: string[]) => dot(r.map((c, i) => (i === 0 && c ? strong(c) : mrkdwn(c)))))],
	Rows: p => [...head(p.title), ...p.rows.map((r: { title: string; sub?: string; meta?: string; badge?: string }) => dot([strong(r.title), r.sub && mrkdwn(r.sub), r.meta && mrkdwn(r.meta), r.badge && mrkdwn(r.badge)]))],
	Sources: p => [...head(p.head), ...p.items.map((x: { title?: string; href: string }) => mrkdwn(x.title ? `[${x.title.replace(/[\][]/g, "")}](${x.href})` : x.href))],
	Evidence: p => [`_근거: ${p.items.map(mrkdwn).join(" · ")}_`],
	Meta: p => [`_${mrkdwn(p.text)}_`],
	Rule: () => [""],
	Files: () => [],
};

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });

/** Lines as sections of at most 3000 chars, cut between lines (a line past 3000 is cut where it stands). */
function sections(lines: string[]): Block[] {
	const out: string[] = [];
	let cur = "";
	for (const line of lines) {
		for (let rest = line; ; rest = rest.slice(SLACK_LIMITS.text)) {
			const piece = rest.slice(0, SLACK_LIMITS.text);
			if (cur && cur.length + 1 + piece.length > SLACK_LIMITS.text) {
				out.push(cur);
				cur = piece;
			} else cur = cur ? `${cur}\n${piece}` : piece;
			if (rest.length <= SLACK_LIMITS.text) break;
		}
	}
	return [...out, cur].filter(t => t.trim()).map(section);
}

/** Code as fenced sections, cut between lines when it is long. */
function codeBlocks(code: string): Block[] {
	const room = SLACK_LIMITS.text - 8;
	const parts: string[] = [];
	let cur = "";
	for (const line of esc(code).split("\n")) {
		for (let rest = line; ; rest = rest.slice(room)) {
			const piece = rest.slice(0, room);
			if (cur && cur.length + 1 + piece.length > room) {
				parts.push(cur);
				cur = piece;
			} else cur = cur ? `${cur}\n${piece}` : piece;
			if (rest.length <= room) break;
		}
	}
	return [...parts, cur].map(t => section(`\`\`\`\n${t}\n\`\`\``));
}

const context = (text: string): Block[] | undefined => (text.length <= SLACK_LIMITS.text ? [{ type: "context", elements: [{ type: "mrkdwn", text }] }] : undefined);

/** The components that are more than lines of text; undefined means the component does not fit its block and is drawn as text. */
const RICH: Partial<Record<string, (p: any) => Block[] | undefined>> = {
	Facts: p => {
		const fields = p.rows.map((r: Row) => ({ type: "mrkdwn", text: `${strong(r.key)}\n${change(r)}` }));
		if (fields.length > SLACK_LIMITS.fields || fields.some((f: { text: string }) => f.text.length > SLACK_LIMITS.field)) return undefined;
		return [...(p.head ? [section(strong(String(p.head)))] : []), { type: "section", fields }];
	},
	Evidence: p => context(LINES.Evidence!(p).join("")),
	Meta: p => context(LINES.Meta!(p).join("")),
	Rule: () => [{ type: "divider" }],
	Code: p => codeBlocks(p.code),
};

const linesOf = (e: SpecElement): string[] => (LINES[e.type] ?? ((p: unknown) => body(elementPlain({ ...e, props: p as Record<string, unknown> }))))(e.props);

/** Every component as rich as it fits; a component past a limit is text in sections. */
const rich = (els: SpecElement[]): Block[] => els.flatMap(e => RICH[e.type]?.(e.props) ?? sections(linesOf(e)));

/** Everything as text in sections: neighbouring components share a section, a Rule is a blank line. */
function flat(els: SpecElement[]): Block[] {
	const out: Block[] = [];
	let run: string[] = [];
	const close = () => {
		out.push(...sections(run));
		run = [];
	};
	for (const e of els) {
		if (e.type === "Code") {
			close();
			out.push(...codeBlocks(e.props.code as string));
		} else {
			const lines = linesOf(e);
			if (lines.length) run.push(...(run.length ? [""] : []), ...lines);
		}
	}
	close();
	return out;
}

function lead(blocks: Block[], emoji: string): Block[] {
	const first = blocks[0] as { type?: string; text?: { text: string } } | undefined;
	if (first?.type === "section" && first.text && first.text.text.length + emoji.length + 1 <= SLACK_LIMITS.text) {
		return [section(`${emoji} ${first.text.text}`), ...blocks.slice(1)];
	}
	return [section(emoji), ...blocks];
}

/** The blocks of a spec: `emoji` leads the first one, `link` (already mrkdwn) closes. Undefined when even the all-text form is over Slack's 50 blocks. */
export function slackBlocks(spec: MessageSpec, o: { emoji?: string; link?: string } = {}): Block[] | undefined {
	const els = specChildren(spec);
	for (const make of [rich, flat]) {
		let blocks = make(els);
		if (o.emoji) blocks = lead(blocks, o.emoji);
		if (o.link) blocks.push(...(context(o.link) ?? []));
		if (blocks.length && blocks.length <= SLACK_LIMITS.blocks) return blocks;
	}
	return undefined;
}
