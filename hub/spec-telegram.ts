// A spec as Telegram messages (hub/messenger-telegram.ts, parse_mode HTML): b, i, s, code, pre, a and blockquote only. Every string is escaped, so `<script>` and `<@123>` arrive as text.
// Each part carries its `plain` form too: Telegram answers 400 for markup it cannot parse, and the adapter then sends the plain text once so the answer is never lost.
import { elementPlain, specChildren, type MessageSpec, type SpecElement } from "./message-spec.ts";
import { inlineTokens } from "./spec-inline.ts";

export type TelegramPart = { html: string; plain: string };
export const TELEGRAM_LIMIT = 4096;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A spec string as HTML: marks kept, a link as `<a href>` (http(s) only, by inlineTokens), everything else escaped. */
export function html(s: string): string {
	return inlineTokens(s)
		.map(k => {
			const t = esc(k.text);
			if (k.t === "link") return `<a href="${esc(k.href!).replace(/"/g, "&quot;")}">${t}</a>`;
			return k.t === "b" ? `<b>${t}</b>` : k.t === "i" ? `<i>${t}</i>` : k.t === "s" ? `<s>${t}</s>` : k.t === "code" ? `<code>${t}</code>` : t;
		})
		.join("");
}
const strong = (s: string): string => `<b>${esc(inlineTokens(s).map(k => k.text).join(""))}</b>`;
const pre = (code: string, lang = ""): string => (/^[\w+#.-]{1,20}$/.test(lang) ? `<pre><code class="language-${lang}">${esc(code)}</code></pre>` : `<pre>${esc(code)}</pre>`);

/** Model markdown as HTML: a heading is bold, a run of `> ` lines is one blockquote, a ``` fence is a pre. */
function body(s: string): string {
	const out: string[] = [];
	const lines = s.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = /^\s*```(\S*)/.exec(line);
		if (fence) {
			const code: string[] = [];
			for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
			out.push(pre(code.join("\n"), fence[1]));
			continue;
		}
		const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (h) out.push(strong(h[1]!));
		else if (line.startsWith("> ")) {
			const quote: string[] = [];
			for (; i < lines.length && lines[i]!.startsWith("> "); i++) quote.push(html(lines[i]!.slice(2)));
			i--;
			out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
		} else out.push(html(line));
	}
	return out.join("\n");
}

type Row = { key: string; value?: string; from?: string; to?: string; count?: string };
const fact = (r: Row): string => `${strong(r.key)}${r.count ? ` (${html(r.count)})` : ""}: ${r.value !== undefined ? html(r.value) : `<s>${esc(r.from ?? "")}</s> → <b>${esc(r.to ?? "")}</b>`}`;
const head = (h: unknown): string[] => (h ? [strong(String(h))] : []);
const dot = (cells: (string | undefined)[]): string => cells.filter(Boolean).join(" · ");

const HTML: Partial<Record<string, (p: any) => string>> = {
	Text: p => body(p.text),
	Facts: p => [...head(p.head), ...p.rows.map(fact)].join("\n"),
	Section: p => [strong(p.title), ...p.rows.map(fact)].join("\n"),
	Schedule: p => [...head(p.head), ...p.rows.map((r: { time: string; text: string }) => `<b>${r.time}</b> ${html(r.text)}`)].join("\n"),
	Table: p => [...(p.head ? [`<i>${esc(p.head.join(" · "))}</i>`] : []), ...p.rows.map((r: string[]) => dot(r.map((c, i) => (i === 0 && c ? strong(c) : html(c)))))].join("\n"),
	Rows: p => [...head(p.title), ...p.rows.map((r: { title: string; sub?: string; meta?: string; badge?: string }) => dot([strong(r.title), r.sub && html(r.sub), r.meta && html(r.meta), r.badge && html(r.badge)]))].join("\n"),
	Sources: p => [...head(p.head), ...p.items.map((x: { title?: string; href: string }) => html(x.title ? `[${x.title.replace(/[\][]/g, "")}](${x.href})` : x.href))].join("\n"),
	Quote: p => `<blockquote>${p.lines.map(html).join("\n")}</blockquote>`,
	Evidence: p => `<i>근거: ${p.items.map(html).join(" · ")}</i>`,
	Meta: p => `<i>${html(p.text)}</i>`,
	Code: p => pre(p.code, p.lang),
	Rule: () => "───────",
};

const partOf = (e: SpecElement): TelegramPart | undefined => (e.type === "Files" ? undefined : { html: HTML[e.type]?.(e.props) ?? body(elementPlain(e)), plain: elementPlain(e) });

/** A piece longer than a message is cut between lines of its plain text and sent without markup. */
function cut(p: TelegramPart, limit: number): TelegramPart[] {
	if (p.html.length <= limit) return [p];
	const step = Math.floor(limit / 5);
	const out: string[] = [];
	let cur = "";
	for (const line of p.plain.split("\n")) {
		for (let at = 0; at === 0 || at < line.length; at += step) {
			const piece = line.slice(at, at + step);
			if (cur && esc(cur).length + 1 + esc(piece).length > limit) {
				out.push(cur);
				cur = piece;
			} else cur = cur ? `${cur}\n${piece}` : piece;
		}
	}
	return [...out, cur].map(plain => ({ html: esc(plain), plain }));
}

/** The messages of a spec, each at most `limit` of HTML, cut only between components (a component past the limit is cut between its lines). `emoji` leads the first. */
export function telegramParts(spec: MessageSpec, o: { emoji?: string; limit?: number } = {}): TelegramPart[] {
	const limit = o.limit ?? TELEGRAM_LIMIT;
	const items = specChildren(spec).map(partOf).filter((p): p is TelegramPart => !!p);
	if (o.emoji) items[0] = items[0] ? { html: `${o.emoji} ${items[0].html}`, plain: `${o.emoji} ${items[0].plain}` } : { html: o.emoji, plain: o.emoji };
	const parts: TelegramPart[] = [];
	for (const p of items.flatMap(x => cut(x, limit))) {
		const last = parts.at(-1);
		if (last && last.html.length + 2 + p.html.length <= limit) parts[parts.length - 1] = { html: `${last.html}\n\n${p.html}`, plain: `${last.plain}\n\n${p.plain}` };
		else parts.push(p);
	}
	return parts;
}
