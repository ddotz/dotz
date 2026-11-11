// A spec as Discord content (hub/discord-format.ts plainParts): markdown lines, no embeds. A type without an entry in DISCORD goes through the same text treatment as a message body.
// Text is `text` (readable, subtext, no model emoji), so a spec answer reads like today's. Choice stays what plainChoice makes of its plain form: hub/askbuttons.ts reads the buttons back from content.
import { elementPlain, specChildren, type MessageSpec } from "./message-spec.ts";
import { inlineTokens, STRIKE } from "./spec-inline.ts";
import { plainChoice } from "./tone.ts";

type Render = (p: any) => string | undefined;

/** `<@123>`, `<:name:1>` and `</cmd:1>` are mentions, emoji and commands to Discord; a zero-width space after the `<` keeps them text. `<#123>` stays: it is the channel link readable() writes. */
export const defang = (s: string): string => s.replace(/<(?=[@:/!]|a:|t:)/g, "<\u200b");

const mark = (s: string): string => s.replace(/[\\*_~`|\[\]]/g, "\\$&");
const safe = (s: string): string => mark(defang(s));
// Discord draws ~~text~~ itself, so in plain text (outside `code` and ```fences```) every ~~ that is not a deliberate pair (see STRIKE) is escaped and shows as two tildes.
const STRAY_TILDES = new RegExp(`${STRIKE}|~{2,}`, "g");
export const escapeStrayTildes = (s: string): string =>
	s
		.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/)
		.map((part, i) => (i % 2 ? part : part.replace(STRAY_TILDES, m => (/^~+$/.test(m) ? m.replace(/~/g, "\\~") : m))))
		.join("");

const strong = (s: string): string => `**${safe(inlineTokens(s).map(k => k.text).join(""))}**`;

/** A spec string as Discord markdown: marks kept, text escaped, a link as `[label](<url>)` (no preview), a bare url as `<url>`. */
export function inline(s: string): string {
	return inlineTokens(s)
		.map(k => {
			if (k.t === "link") return k.text === k.href ? `<${k.href}>` : `[${safe(k.text)}](<${k.href}>)`;
			const t = safe(k.text);
			return k.t === "b" ? `**${t}**` : k.t === "i" ? `*${t}*` : k.t === "s" ? `~~${t}~~` : k.t === "code" ? `\`${defang(k.text)}\`` : t;
		})
		.join("");
}

type Row = { key: string; value?: string; from?: string; to?: string; count?: string };
const fact = (r: Row): string => {
	const value = r.value !== undefined ? inline(r.value) : `~~${safe(r.from ?? "")}~~ → ${r.to ? `**${safe(r.to)}**` : ""}`;
	return `${strong(r.key)}${r.count ? ` (${inline(r.count)})` : ""} ${value}`.trimEnd();
};
const head = (h: unknown): string[] => (h ? [strong(String(h))] : []);
const dot = (cells: (string | undefined)[]): string => cells.filter(Boolean).join(" · ");

// Short rows read as a column; a row that runs to a sentence wraps on a phone, and only a list marker keeps the rows apart.
const WORDY = 30;
const facts = (rows: Row[]): string[] => (rows.some(r => (r.value ?? "").length > WORDY) ? rows.map(r => `- ${fact(r)}`) : rows.map(fact));

export const DISCORD: Partial<Record<string, Render>> = {
	Facts: p => [...head(p.head), ...facts(p.rows)].join("\n"),
	Section: p => [strong(p.title), ...facts(p.rows)].join("\n"),
	Schedule: p => [...head(p.head), ...p.rows.map((r: { time: string; text: string }) => `${strong(r.time)} ${inline(r.text)}`)].join("\n"),
	Table: p => {
		const row = (r: string[]) => dot(r.map((c, i) => (i === 0 && c ? strong(c) : inline(c))));
		return [...(p.head ? [`-# ${dot(p.head.map(inline))}`] : []), ...p.rows.map(row)].join("\n");
	},
	Rows: p => [...head(p.title), ...p.rows.map((r: { title: string; sub?: string; meta?: string; badge?: string }) => dot([strong(r.title), r.sub && inline(r.sub), r.meta && inline(r.meta), r.badge && inline(r.badge)]))].join("\n"),
	Sources: p => [...head(p.head), ...p.items.map((x: { title?: string; href: string }) => (x.title ? `[${safe(x.title)}](<${x.href}>)` : `<${x.href}>`))].join("\n"),
	Evidence: p => `-# 근거: ${p.items.map(inline).join(" · ")}`,
	Meta: p => `-# ${inline(p.text)}`,
	Rule: () => "",
	Choice: p => plainChoice(defang(elementPlain({ type: "Choice", props: p }))),
	Files: () => undefined,
};

/** The whole message: a type with an entry draws itself, any other goes through `text`; paragraphs split by a blank line, a Rule adds one. */
export function renderDiscord(spec: MessageSpec, text: (s: string) => string): string {
	return specChildren(spec)
		.map(e => (DISCORD[e.type] ? DISCORD[e.type]!(e.props) : text(defang(elementPlain(e)))))
		.filter((s): s is string => s !== undefined)
		.join("\n\n");
}
