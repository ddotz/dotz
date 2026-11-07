// A spec as JANDI body text (hub/messenger-jandi.ts). The incoming webhook shows `body` as plain text and `connectInfo` as title/description cards; the cards stay for the 웹에서 보기 link,
// so a component is a few plain lines. Marks are dropped, a link is `label url`, and nothing is escaped because JANDI draws no markup from body.
import { elementPlain, specChildren, type MessageSpec } from "./message-spec.ts";
import { inlinePlain } from "./spec-inline.ts";
import { plainChoice } from "./tone.ts";

type Row = { key: string; value?: string; from?: string; to?: string; count?: string };
const fact = (r: Row): string => `${inlinePlain(r.key)}${r.count ? ` (${inlinePlain(r.count)})` : ""}: ${r.value !== undefined ? inlinePlain(r.value) : `${r.from ?? ""} → ${r.to ?? ""}`}`;
const head = (h: unknown): string[] => (h ? [inlinePlain(String(h))] : []);
const dot = (cells: (string | undefined)[]): string => cells.filter(Boolean).map(c => inlinePlain(c!)).join(" · ");

const JANDI: Partial<Record<string, (p: any) => string | undefined>> = {
	Facts: p => [...head(p.head), ...p.rows.map(fact)].join("\n"),
	Section: p => [inlinePlain(p.title), ...p.rows.map(fact)].join("\n"),
	Schedule: p => [...head(p.head), ...p.rows.map((r: { time: string; text: string }) => `${r.time} ${inlinePlain(r.text)}`)].join("\n"),
	Table: p => [...(p.head ? [dot(p.head)] : []), ...p.rows.map(dot)].join("\n"),
	Rows: p => [...head(p.title), ...p.rows.map((r: { title: string; sub?: string; meta?: string; badge?: string }) => dot([r.title, r.sub, r.meta, r.badge]))].join("\n"),
	Sources: p => [...head(p.head), ...p.items.map((x: { title?: string; href: string }) => (x.title ? `${inlinePlain(x.title)}: ${x.href}` : x.href))].join("\n"),
	Evidence: p => `근거: ${p.items.map(inlinePlain).join(" · ")}`,
	Meta: p => inlinePlain(p.text),
	Rule: () => "",
	Files: () => undefined,
};

export function renderJandi(spec: MessageSpec): string {
	return specChildren(spec)
		.map(e => (JANDI[e.type] ? JANDI[e.type]!(e.props) : plainChoice(elementPlain(e))))
		.filter((s): s is string => s !== undefined)
		.join("\n\n");
}
