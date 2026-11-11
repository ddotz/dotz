// The message spec: one guarded JSON form of a chat answer, the pattern of json-render (a fixed catalog, a flat { root, elements } tree, limits) without its stack.
// docs/message-spec.md is the guide. This file has no imports: hub/gen-message-spec-web.ts runs the same code in the page.
// Text stays the wire and the record: a spec is built from it (message-spec-derive.ts) or turned into it (specPlain), so search, recall, memory, notifications and old clients read text.
export type SpecElement = { type: string; props: Record<string, unknown>; children?: string[] };
export type MessageSpec = { v: 1; root: string; elements: Record<string, SpecElement> };
export type SpecResult = { ok: true; spec: MessageSpec } | { ok: false; issues: string[] };

export const SPEC_LIMITS = { bytes: 64 * 1024, elements: 200, depth: 2, string: 20_000, rows: 200, cells: 12 };

type Check = (v: unknown) => boolean;
const str: Check = v => typeof v === "string" && v.length <= SPEC_LIMITS.string;
const nonEmpty: Check = v => str(v) && !!(v as string).trim();
const bool: Check = v => typeof v === "boolean";
const obj = (need: Record<string, Check>, may: Record<string, Check> = {}): Check => v => {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	return Object.keys(need).every(k => need[k]!(o[k])) && Object.keys(o).every(k => (need[k] ?? may[k])?.(o[k]) === true);
};
const list = (one: Check): Check => v => Array.isArray(v) && v.length > 0 && v.length <= SPEC_LIMITS.rows && v.every(one);

// Only a web link leaves the app. A markdown link or autolink with another scheme fails the whole spec; the answer then goes out as text.
const WEB_URL = /^https?:\/\/[^\s<>\p{Cc}]+$/iu;
const BAD_LINK = /\]\(\s*<?(?!https?:\/\/)[a-z][a-z0-9+.-]*:|<(?!https?:\/\/)[a-z][a-z0-9+.-]{2,}:[^\s>]*>/i;
export const webUrl = (href: unknown): boolean => typeof href === "string" && WEB_URL.test(href) && URL.canParse(href);

const lines = (prefix: string, rows: string[]) => rows.map(r => `${prefix}${r}`).join("\n");
const headed = (head: unknown, body: string) => (head ? `**${head}**\n${body}` : body);
type Row = { key: string; value?: string; from?: string; to?: string; count?: string };
const factValue = (r: Row) => r.value ?? `${r.from} → ${r.to}`;

/** Every component there is. props: exact keys, an unknown key fails. plain: the component as the text shapes of MODE.md "Message layout", which message-spec-derive.ts reads back. A surface without a renderer for a type uses plain. */
export const CATALOG: Record<string, { props: Check; plain: (p: any) => string }> = {
	Message: { props: obj({}), plain: () => "" },
	// The status mark in front of the answer (hub/events.ts reads it off the text): the page draws its status tag, never the mark as words.
	Status: { props: obj({ tone: v => typeof v === "string" && ["done", "run", "wait", "ask", "fail"].includes(v) }), plain: p => `[${p.tone}]` },
	Text: { props: obj({ text: nonEmpty }), plain: p => p.text },
	Heading: { props: obj({ text: nonEmpty }), plain: p => `## ${p.text}` },
	Bullets: {
		props: obj({ ordered: bool, items: list(obj({ text: str }, { sub: bool })) }, { head: nonEmpty }),
		plain: p => headed(p.head, p.items.map((x: { text: string; sub?: boolean }, i: number) => `${x.sub ? "  " : ""}${p.ordered ? `${i + 1}.` : "-"} ${x.text}`).join("\n")),
	},
	Steps: { props: obj({ items: list(nonEmpty) }, { head: nonEmpty }), plain: p => headed(p.head, p.items.map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")) },
	Schedule: {
		props: obj({ rows: list(obj({ time: v => typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v), text: nonEmpty })) }, { head: nonEmpty }),
		plain: p => headed(p.head, lines("- ", p.rows.map((r: { time: string; text: string }) => `${r.time} ${r.text}`))),
	},
	// A number, a label or a change: `value`, or `from` and `to` (drawn old value struck, new value strong).
	Facts: {
		props: obj({ rows: list(obj({ key: nonEmpty }, { value: str, from: str, to: str })) }, { head: nonEmpty }),
		plain: p => headed(p.head, lines("- ", p.rows.map((r: Row) => `${r.key}: ${factValue(r)}`))),
	},
	// One part of a bundle report; neighbouring Sections share a card where the surface has cards.
	Section: {
		props: obj({ title: nonEmpty, rows: list(obj({ key: nonEmpty }, { value: str, from: str, to: str, count: str })) }),
		plain: p => headed(p.title, lines("- ", p.rows.map((r: Row) => `**${r.key}${r.count ? ` (${r.count})` : ""}:** ${factValue(r)}`))),
	},
	Table: {
		props: obj({ rows: list(v => Array.isArray(v) && v.length <= SPEC_LIMITS.cells && v.every(str)) }, { head: list(str) }),
		plain: p => {
			const row = (r: string[]) => `| ${r.join(" | ")} |`;
			return [...(p.head ? [row(p.head), row(p.head.map(() => "---"))] : []), ...p.rows.map(row)].join("\n");
		},
	},
	// The 목록 block (hub/listblock.ts): title, subtitle, meta on the right, count badge.
	Rows: {
		props: obj({ rows: list(obj({ title: nonEmpty }, { sub: str, meta: str, badge: str })) }, { title: nonEmpty }),
		plain: p => {
			const row = (r: { title: string; sub?: string; meta?: string; badge?: string }) => {
				const cells = [r.title, r.sub ?? "", r.meta ?? "", r.badge ?? ""];
				while (cells.length > 1 && !cells.at(-1)) cells.pop();
				return cells.join(" | ");
			};
			return ["```목록", ...(p.title ? [`# ${p.title}`] : []), ...p.rows.map(row), "```"].join("\n");
		},
	},
	// A ```chart fence: a ztd-charts JSON spec (hub/chart.ts checks and draws it; a surface without pictures shows the fence).
	Chart: { props: obj({ spec: nonEmpty }, { title: nonEmpty }), plain: p => `\`\`\`chart\n${p.spec}\n\`\`\`` },
	Sources: {
		props: obj({ items: list(obj({ href: webUrl }, { title: nonEmpty })) }, { head: nonEmpty }),
		plain: p => [...(p.head ? [`${p.head}:`] : []), ...p.items.map((x: { title?: string; href: string }) => (x.title ? `- ${x.title}: ${x.href}` : x.href))].join("\n"),
	},
	Quote: { props: obj({ lines: list(str) }), plain: p => lines("> ", p.lines) },
	Meta: { props: obj({ text: nonEmpty }), plain: p => `-# ${p.text}` },
	Evidence: { props: obj({ items: list(nonEmpty) }), plain: p => `근거: ${p.items.join(" · ")}` },
	Code: { props: obj({ code: str }, { lang: str }), plain: p => `\`\`\`${p.lang ?? ""}\n${p.code}\n\`\`\`` },
	Rule: { props: obj({}), plain: () => "---" },
	// Display of a decision block. The buttons, the answer path and every gate stay where they are (hub/askbuttons.ts, hub/draft-approval.ts): an option only ever answers.
	Choice: {
		props: obj({ question: nonEmpty, options: list(obj({ n: v => Number.isInteger(v), label: nonEmpty }, { desc: str })) }),
		plain: p => [`결정: ${p.question}`, ...p.options.flatMap((o: { n: number; label: string; desc?: string }) => [`**${o.n}) ${o.label}**`, ...(o.desc ? [o.desc] : [])])].join("\n"),
	},
	Files: { props: obj({ items: list(obj({ path: nonEmpty })) }), plain: p => lines("[file] ", p.items.map((x: { path: string }) => x.path)) },
};

function strings(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
	return out;
}

/** The one gate: an object is a spec only when every element is in the catalog, its props are exact, the tree is sound and within SPEC_LIMITS. Anything else is an issue list, never a throw. */
export function validateSpec(x: unknown): SpecResult {
	const issues: string[] = [];
	const s = x as MessageSpec | null;
	if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 1 || typeof s.root !== "string" || !s.elements || typeof s.elements !== "object") return { ok: false, issues: ["not a spec"] };
	if (Object.keys(s).length !== 3) issues.push("extra top-level key");
	const ids = Object.keys(s.elements);
	if (ids.length > SPEC_LIMITS.elements) issues.push("too many elements");
	if (JSON.stringify(s).length > SPEC_LIMITS.bytes) issues.push("too large");
	if (s.elements[s.root]?.type !== "Message") issues.push("root must be a Message");
	if (issues.length) return { ok: false, issues };
	for (const id of ids) {
		const e = s.elements[id]!, c = Object.hasOwn(CATALOG, e?.type) ? CATALOG[e.type] : undefined;
		if (!c) { issues.push(`${id}: unknown type`); continue; }
		if (Object.keys(e).some(k => k !== "type" && k !== "props" && k !== "children")) issues.push(`${id}: extra key`);
		if (!c.props(e.props)) issues.push(`${id}: bad props for ${e.type}`);
		if (e.children !== undefined && (!Array.isArray(e.children) || e.type !== "Message")) issues.push(`${id}: only the Message holds children`);
		if (strings(e.props).some(t => BAD_LINK.test(t))) issues.push(`${id}: link scheme`);
	}
	const kids = s.elements[s.root]?.children ?? [];
	if (!Array.isArray(kids) || new Set(kids).size !== kids.length) issues.push("children repeat");
	else {
		for (const k of kids) if (!Object.hasOwn(s.elements, k) || k === s.root) issues.push(`${k}: bad child`);
		if (kids.length !== ids.length - 1) issues.push("element outside the tree");
	}
	return issues.length ? { ok: false, issues } : { ok: true, spec: s };
}

/** The children of the root in order; the renderers walk this. */
export const specChildren = (s: MessageSpec): SpecElement[] => (s.elements[s.root]!.children ?? []).map(id => s.elements[id]!);

/** One element as text: the plain form a surface without its own renderer shows. */
export const elementPlain = (e: SpecElement): string => CATALOG[e.type]!.plain(e.props);

/** The whole message as text: what is stored, searched and sent to any surface that lacks a component. */
export const specPlain = (s: MessageSpec): string =>
	specChildren(s).map((e, i, all) => (i === 0 ? "" : all[i - 1]!.type === "Status" ? " " : "\n\n") + elementPlain(e)).join("");

/** A spec of these elements (message-spec-derive.ts builds with this). */
export function specOfElements(els: SpecElement[]): MessageSpec {
	const elements: Record<string, SpecElement> = { m: { type: "Message", props: {}, children: els.map((_, i) => `e${i}`) } };
	els.forEach((e, i) => { elements[`e${i}`] = e; });
	return { v: 1, root: "m", elements };
}
