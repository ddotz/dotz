// A spec as terminal text (hub/dotz-last.ts, `dotz last`): ANSI bold, dim and strikethrough, rows aligned by display width (Korean counts 2). Control characters in a string never reach the terminal.
import { elementPlain, specChildren, type MessageSpec, type SpecElement } from "./message-spec.ts";
import { inlineTokens } from "./spec-inline.ts";

/** Colour only on a terminal, and never when NO_COLOR is set (no-color.org: set and not empty). */
export const useColor = (env: Record<string, string | undefined>, isTTY: boolean): boolean => isTTY && !env.NO_COLOR;

export const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

function styles(color: boolean) {
	const on = (open: number, close: number) => (s: string) => (color && s ? `\u001b[${open}m${s}\u001b[${close}m` : s);
	const bold = on(1, 22), dim = on(2, 22), italic = on(3, 23), strike = on(9, 29);
	const inline = (s: string): string =>
		inlineTokens(clean(s))
			.map(k => (k.t === "b" ? bold(k.text) : k.t === "i" ? italic(k.text) : k.t === "s" ? strike(k.text) : k.t === "code" ? dim(k.text) : k.t === "link" ? (k.text === k.href ? k.text : `${k.text} ${dim(`(${k.href})`)}`) : k.text))
			.join("");
	return { bold, dim, strike, inline };
}

const width = (s: string): number => Bun.stringWidth(s);
const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - width(s)));

/** Rows of cells as lines with every column but the last padded to its widest cell. */
function table(rows: string[][]): string[] {
	const widths: number[] = [];
	for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, width(c))));
	return rows.map(r => r.map((c, i) => (i < r.length - 1 ? pad(c, widths[i]!) : c)).join("  ").trimEnd());
}

type Row = { key: string; value?: string; from?: string; to?: string; count?: string };

function lines(e: SpecElement, S: ReturnType<typeof styles>): string[] {
	const p = e.props as any;
	const head = (h: unknown): string[] => (h ? [S.bold(clean(String(h)))] : []);
	const facts = (rows: Row[]) =>
		table(rows.map(r => [S.bold(clean(r.key)) + (r.count ? ` (${S.inline(r.count)})` : ""), r.value !== undefined ? S.inline(r.value) : `${S.strike(clean(r.from ?? ""))} → ${S.bold(clean(r.to ?? ""))}`]));
	switch (e.type) {
		case "Facts": return [...head(p.head), ...facts(p.rows)];
		case "Section": return [...head(p.title), ...facts(p.rows).map(l => `  ${l}`)];
		case "Schedule": return [...head(p.head), ...table(p.rows.map((r: { time: string; text: string }) => [S.bold(r.time), S.inline(r.text)]))];
		case "Table": return table([...(p.head ? [p.head.map((c: string) => S.bold(clean(c)))] : []), ...p.rows.map((r: string[]) => r.map(S.inline))]);
		case "Rows": return [...head(p.title), ...table(p.rows.map((r: { title: string; sub?: string; meta?: string; badge?: string }) => [S.bold(clean(r.title)), r.sub ? S.inline(r.sub) : "", r.meta ? S.dim(clean(r.meta)) : "", r.badge ? S.dim(clean(r.badge)) : ""]))];
		case "Sources": return [...head(p.head), ...p.items.map((x: { title?: string; href: string }) => (x.title ? `${S.inline(x.title)} ${S.dim(`(${x.href})`)}` : x.href))];
		case "Quote": return p.lines.map((l: string) => `${S.dim("│")} ${S.inline(l)}`);
		case "Evidence": return [S.dim(`근거: ${clean(p.items.join(" · "))}`)];
		case "Meta": return [S.dim(clean(p.text))];
		case "Code": return clean(p.code).split("\n").map(l => `  ${S.dim(l)}`);
		case "Rule": return [S.dim("─".repeat(24))];
		case "Choice": return [S.bold(clean(p.question)), ...p.options.flatMap((o: { n: number; label: string; desc?: string }) => [`${o.n}) ${S.inline(o.label)}`, ...(o.desc ? [`   ${S.dim(clean(o.desc))}`] : [])])];
		case "Files": return [];
		default: return elementPlain(e).split("\n").map(l => (/^#{1,6}\s/.test(l) ? S.bold(clean(l.replace(/^#{1,6}\s+/, ""))) : S.inline(l)));
	}
}

export function renderTerminal(spec: MessageSpec, o: { color: boolean }): string {
	const S = styles(o.color);
	return specChildren(spec)
		.map(e => lines(e, S))
		.filter(l => l.length)
		.map(l => l.join("\n"))
		.join("\n\n");
}
