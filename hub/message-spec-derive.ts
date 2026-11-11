// Text -> spec; no spec means the plain text path. This is the one place the written shapes of an answer are read (MODE.md "Message layout"): the page drew them
// from its own copy of this grammar before (web/js/02-basic-markdown.js, 02-answer-shapes.js); now hub/gen-message-spec-web.ts runs this code in the page too, and
// web/js/02-answer-shapes.js only draws the result. No imports but message-spec.ts, because the same file is transpiled for the page.
import { specOfElements, specPlain, validateSpec } from "./message-spec.ts";
import type { MessageSpec, SpecElement } from "./message-spec.ts";

type Props = Record<string, unknown>;
const mk = (type: string, props: Props): SpecElement => ({ type, props });

// ---- the shapes of one line ----
// `**이름:** 값`, or a plain `이름: 값` item when the name is a few words and the value no sentence (MODE.md "Numbers", "Changed values").
const ANS_LABEL = /^\*\*([^*\n]{1,24}?):?\*\*:?\s+(\S.*)$/;
const ANS_PLAIN = /^((?:`[^`\n]+`|[^*:：`.,?!()\n])+?)\s*[:：]\s+(\S.*)$/;
const ANS_NAME_MAX = 24, ANS_PLAIN_MAX = 60;
const ANS_SENTENCE_END = /[.!?요다죠]\s*$/;
// "5,308ms → 36ms": a digit on both sides is a change, and each side is a short value (<= 24 chars, no brackets, quotes or sentence punctuation outside numbers); words or a sentence around an arrow are a path, a flow or prose ("설정 → 앱").
const ANS_CHANGE = /^([^→\n]*\d[^→\n]*?)\s*→\s*([^→\n]*\d[^→\n]*)$/;
const ANS_SIDE_MAX = 24, ANS_NOT_VALUE = /[()[\]{}"'“”‘’!?;:]|(?<!\d)[.,]|[.,](?!\d)/;
const isValueSide = (s: string): boolean => s.length <= ANS_SIDE_MAX && !ANS_NOT_VALUE.test(s);
const ANS_EVIDENCE = /^근거:\s*(\S.*)$/;
const ANS_HEAD = /^\*\*([^*\n]+)\*\*$/, ANS_COUNT = /^(.+?)\s*\((\d+회)\)$/;
const TIME_ROW = /^(\d{1,2}:\d{2})\s+(\S.*)$/;
const RULE_LINE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
// Evidence, source and "for the bot" lines are small and muted; bot is the install's bot name, known to the caller.
const metaLine = (bot: string): RegExp => {
	const name = bot.replace(/[.*+?^${}()|[\]\\]/g, c => `\\${c}`);
	return new RegExp(`^\\s*(?:-\\s+)?(?:근거:|출처:|Evidence:|Source:${name ? `|For ${name}:|${name} 몫:` : ""})`, "i");
};
const FILE_LINE = /^\s*\[file\]\s+`?(.+?)`?\s*$/;
const kvOf = (text: string): RegExpExecArray | null => {
	const m = ANS_LABEL.exec(text);
	if (m) return m;
	const p = ANS_PLAIN.exec(text);
	return p && p[1]!.replace(/`/g, "").length <= ANS_NAME_MAX && p[2]!.length <= ANS_PLAIN_MAX && !ANS_SENTENCE_END.test(p[2]!) ? p : null;
};
const changeOf = (value: string): Props => {
	const c = ANS_CHANGE.exec(value);
	return c && isValueSide(c[1]!) && isValueSide(c[2]!) ? { from: c[1], to: c[2] } : { value };
};

// Older messages still mark one option as recommended (hub/choices.ts stripRecommendMark): nothing shows on it.
const REC_MARK = /^([ \t]*>?[ \t]*(?:\*\*)?[ \t]*\d{1,2}(?:\)|\.[ \t]).*?)[ \t]*(?:(?:←|<-)[ \t]*(?:추천|recommended)|\([ \t]*(?:추천|권장|recommended)[ \t]*\))/gim;

// A run of "> " lines that contains an option line ("**1) ...") is a choice block: its quote prefixes are dropped. Other quotes stay.
function unquoteChoices(src: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < src.length;) {
		if (!/^\s*>/.test(src[i]!)) { out.push(src[i++]!); continue; }
		let j = i;
		while (j < src.length && /^\s*>/.test(src[j]!)) j++;
		const run = src.slice(i, j), choice = run.some(l => /^\s*>?\s*\*\*\d+\)/.test(l));
		out.push(...(choice ? run.map(l => l.replace(/^\s*>\s?/, "")) : run));
		i = j;
	}
	return out;
}

// ---- source lists ----
// A heading line (출처:, 참고:, 근거:, Sources:) over link lines (a bare URL, "이름: URL", "이름 - URL", [이름](URL)), or a last run of two or more bare URL lines.
// Everything comes from the URL string: no fetch, no favicon.
const SRC_HEAD = /^\s*(?:#{1,6}\s+)?(?:\*\*)?(출처|참고(?: 자료| 링크)?|근거|Sources?|References?)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const SRC_BULLET = /^\s*(?:[-*•]|\d+[.)])\s/;
const SRC_ITEM = /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(\S(?:(?!:\/\/).)*?)(?::|\s-)\s+<?(https?:\/\/[^\s<>]+)>?|<?(https?:\/\/[^\s<>]+)>?)\s*$/;
type Source = { href: string; title?: string };
function sourceItem(line: string): Source | null {
	const m = line.match(SRC_ITEM), href = m && (m[2] || m[4] || m[5]);
	if (!m || !href || !URL.canParse(href)) return null;
	const title = (m[1] || m[3] || "").replace(/\*\*|`/g, "");
	return title ? { href, title } : { href };
}
// start line -> the list that begins there; only the message's last text part (last) can hold a list without a heading.
function sourceRuns(src: string[], last: boolean): Map<number, { head: string; items: Source[]; end: number }> {
	const runs = new Map<number, { head: string; items: Source[]; end: number }>();
	if (!src.some(l => l.includes("://"))) return runs;
	let taken = 0;
	for (let i = 0; i < src.length; i++) {
		const h = src[i]!.match(SRC_HEAD);
		if (!h) continue;
		const items: Source[] = [];
		let end = i + 1, mixed = false;
		for (let j = end; j < src.length; j++) {
			if (!src[j]!.trim()) continue;
			const item = sourceItem(src[j]!);
			// A 근거: list keeps its shape unless every item in it is a link: the next line or bullet being something else leaves it as written.
			if (!item) { mixed = h[1] === "근거" && (j === end || SRC_BULLET.test(src[j]!)); break; }
			items.push(item); end = j + 1;
		}
		if (mixed) taken = src.length;   // nor does the last-run scan below take a piece of it
		else if (items.length) { runs.set(i, { head: h[1]!, items, end }); taken = end; i = end - 1; }
	}
	if (!last) return runs;
	let end = src.length;
	while (end && !src[end - 1]!.trim()) end--;
	const items: Source[] = [];
	let start = end;
	for (let item: Source | null; start > taken && (item = sourceItem(src[start - 1]!)) && !item.title; start--) items.unshift(item);
	if (items.length > 1) runs.set(start, { head: "", items, end });
	return runs;
}

// ---- a 결정: block, a draft approval ----
const DECISION_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)(?:\s*#?\d{1,2})?\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
const D_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*$/;
const DRAFT_REF = /\(\s*[A-Za-z0-9][A-Za-z0-9_.:-]{1,63}\)\s*$/;
// A draft approval (hub/draft-approval.ts) carries "(<ref>)" in its question, and the draft's own lines quoted above its options. Those messages stay exactly as they are.
function isDraft(text: string): boolean {
	let fence = false, head = false, quoted = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		if (fence) continue;
		const h = DECISION_HEAD.exec(line);
		if (h) {
			if (DRAFT_REF.test(h[1]!)) return true;
			head = true;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const bare = line.replace(/^\s*>\s?/, "");
			if (!D_OPT.test(bare) && !DECISION_HEAD.test(bare)) quoted = true;
		} else if (quoted && head && D_OPT.test(line)) return true;
	}
	return quoted && head && text.split("\n").some(l => D_OPT.test(l.replace(/^\s*>\s?/, "")));
}
// Only the written form of a decision block is a Choice (MODE.md): "결정: 질문", then `**n) 이름**` lines with at most one line under each, and nothing else in the paragraph.
// Anything looser stays a paragraph, as it was drawn.
function choiceOf(p: string[]): SpecElement | null {
	const h = /^결정: (\S.*)$/.exec(p[0]!), options: Props[] = [];
	if (!h) return null;
	const OPT = /^\*\*([1-9]\d{0,2})\) (\S[^*]*)\*\*$/;
	for (let i = 1; i < p.length; i++) {
		const o = OPT.exec(p[i]!);
		if (!o) return null;
		const next = p[i + 1];
		const desc = next !== undefined && !OPT.test(next) ? next : undefined;
		if (desc !== undefined) i++;
		options.push({ n: Number(o[1]), label: o[2], ...(desc !== undefined ? { desc } : {}) });
	}
	return options.length >= 2 ? mk("Choice", { question: h[1], options }) : null;
}

// ---- the blocks of one stretch of text ----
type Item = { el: SpecElement; alt?: SpecElement; n?: number };
type Pending = { t: "ul" | "ol"; items: { text: string; sub: boolean }[]; head: string };
// shape: an answer, drawn by its shapes; otherwise basic markdown (a list is a list, a table a table, a `근거:` line a small line).
function blocks(text: string, last: boolean, shape: boolean, meta: RegExp): SpecElement[] {
	const items: Item[] = [], src = unquoteChoices(text.split("\n")), sources = sourceRuns(src, last);
	let list: Pending | null = null, table: { rows: string[][]; head: boolean } | null = null;
	let para: string[] = [], quote: string[] = [], files: string[] = [];
	const add = (e: SpecElement, extra: Partial<Item> = {}) => void items.push({ el: e, ...extra });
	const flushQ = () => {
		if (quote.length) add(mk("Quote", { lines: quote }));
		quote = [];
	};
	const flushP = () => {
		flushQ();
		if (para.length) add((shape && choiceOf(para)) || mk("Text", { text: para.join("\n") }));
		para = [];
	};
	const flushF = () => {
		if (files.length) add(mk("Files", { items: files.map(path => ({ path })) }));
		files = [];
	};
	const flushL = () => {
		if (!list) return;
		const l = list;
		list = null;
		const head = l.head ? ANS_HEAD.exec(l.head)![1]! : "";
		const bullets = () => mk("Bullets", { ordered: l.t === "ol", items: l.items.map(i => (i.sub ? { text: i.text, sub: true } : { text: i.text })), ...(head ? { head } : {}) });
		if (!shape) return add(bullets());
		const kv = l.items.map(i => kvOf(i.text)), flat = !l.items.some(i => i.sub), allKv = kv.every(Boolean);
		const headed = head ? { head } : {};
		// A "**title**" line over a list of labels: one part of a bundle report. Neighbouring parts share a card; a lone part with a single item stays the list it was.
		if (head && allKv && flat) {
			const rows = kv.map(m => {
				const c = ANS_COUNT.exec(m![1]!);
				return { key: c ? c[1] : m![1], ...(c ? { count: c[2] } : {}), ...changeOf(m![2]!) };
			});
			return add(mk("Section", { title: head, rows }), { alt: bullets(), n: rows.length });
		}
		// Two or more flat items only: one line or a nested list is lighter as text.
		if (l.items.length >= 2 && flat) {
			if (l.t === "ol") return add(mk("Steps", { items: l.items.map(i => i.text), ...headed }));
			if (l.items.every(i => TIME_ROW.test(i.text))) {
				return add(mk("Schedule", { rows: l.items.map(i => { const t = TIME_ROW.exec(i.text)!; return { time: t[1], text: t[2] }; }), ...headed }));
			}
			if (allKv) return add(mk("Facts", { rows: kv.map(m => ({ key: m![1], ...changeOf(m![2]!) })), ...headed }));
		}
		add(bullets());
	};
	const flushT = () => {
		if (!table) return;
		const [head, ...rest] = table.head ? table.rows : [null, ...table.rows];
		add(mk("Table", { rows: rest, ...(head ? { head } : {}) }));
		table = null;
	};
	for (let i = 0; i < src.length; i++) {
		const line = src[i]!, run = sources.get(i);
		let m: RegExpMatchArray | null;
		const file = shape && FILE_LINE.exec(line);
		if (file) { flushT(); flushP(); flushL(); files.push(file[1]!); continue; }
		flushF();
		if (run) {
			flushT(); flushP(); flushL();
			add(mk("Sources", { ...(run.head ? { head: run.head } : {}), items: run.items }));
			i = run.end - 1;
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line)) {
			flushP(); flushL();
			if (!table) table = { rows: [], head: false };
			// "| a | b |" rows; the "|---|" separator row after the first one makes that row the header.
			if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) { if (table.rows.length === 1) table.head = true; }
			else table.rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
			continue;
		}
		flushT();
		// Discord's "-# " subtext line is a meta line too; the last "근거:" line is the evidence of an answer.
		if (meta.test(line) || /^\s*-#\s/.test(line)) {
			flushP(); flushL();
			const ev = shape && last ? ANS_EVIDENCE.exec(line.trim()) : null;
			if (ev && !src.slice(i + 1).some(l => l.trim())) add(mk("Evidence", { items: ev[1]!.split(/\s+·\s+/) }));
			else add(mk("Meta", { text: line.replace(/^\s*-#?\s+/, "") }));
			continue;
		}
		// An indented item (2+ spaces) is a sub-item of the list it sits in, whatever its own marker.
		if ((m = line.match(/^(\s*)(?:[-*•]|(\d+)[.)])\s+(.*)/))) {
			const head = shape && para.length === 1 && ANS_HEAD.test(para[0]!.trim()) ? para.pop()!.trim() : "";   // a title right above a list
			flushP();
			const t = m[2] ? "ol" : "ul", sub = m[1]!.length >= 2 && !!list;
			if (!sub && (!list || (list as Pending).t !== t)) { flushL(); list = { t, items: [], head }; }
			(list as Pending | null)!.items.push({ text: m[3]!, sub });
		}
		else if ((m = line.match(/^\s*>\s?(.*)/))) { flushL(); if (para.length) { const q = quote; quote = []; flushP(); quote = q; } quote.push(m[1]!); }
		else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushP(); flushL(); add(mk("Heading", { text: m[1]! })); }
		else if (RULE_LINE.test(line)) { flushP(); flushL(); add(mk("Rule", {})); }
		else if (!line.trim()) { flushP(); flushL(); }
		else { flushL(); para.push(line); }
	}
	flushP(); flushL(); flushT(); flushF();
	const out: SpecElement[] = [];
	for (let i = 0; i < items.length; i++) {
		if (!items[i]!.alt) { out.push(items[i]!.el); continue; }
		let j = i, n = 0;
		while (j < items.length && items[j]!.alt) n += items[j++]!.n!;
		for (; i < j; i++) out.push(n >= 2 ? items[i]!.el : items[i]!.alt!);
		i = j - 1;
	}
	return out;
}

// A fence tagged 목록 is a list shown as UI rows (hub/listblock.ts writes it): an optional "# " title line, then one row per line "title | subtitle | meta | badge" (the last three optional).
function rowsOf(code: string): SpecElement {
	const src = code.split("\n").map(l => l.trim()).filter(Boolean);
	const title = src[0] && src[0].startsWith("# ") ? src.shift()!.slice(2) : "";
	const rows = src.map(l => {
		const [t = "", sub = "", meta = "", badge = ""] = l.split(" | ").map(x => x.trim());
		return { title: t, ...(sub ? { sub } : {}), ...(meta ? { meta } : {}), ...(badge ? { badge } : {}) };
	});
	return mk("Rows", { ...(title ? { title } : {}), rows });
}

// A fence tagged chart holds a ztd-charts JSON spec, drawn by the gateway (hub/chart.ts). Text that is not a JSON object stays a json code block with a short note.
export const CHART_NOTE = "차트 형식이 맞지 않아 JSON으로 보여 드려요";
function chartOf(code: string): SpecElement[] {
	const spec = code.trim();
	let json: unknown;
	try { json = JSON.parse(spec); } catch { json = null; }
	if (!json || typeof json !== "object" || Array.isArray(json)) return [mk("Code", { code: spec, lang: "json" }), mk("Meta", { text: CHART_NOTE })];
	const title = (json as { card?: { title?: unknown } }).card?.title;
	return [mk("Chart", { spec, ...(typeof title === "string" && title.trim() ? { title } : {}) })];
}

// relayed: another computer's text (42-relay-chat.js) keeps `[file]` lines as text and draws every fence as a plain code block.
const FENCE_SPLIT = /(?:^|\n)[ \t]{0,3}```([^\n`]*)\n?([\s\S]*?)(?:```[ \t]*(?=\n|$)|$)/;
function parse(source: string, shape: boolean, relayed: boolean, bot: string): SpecElement[] | null {
	const text = source.replace(REC_MARK, "$1");
	if (shape && isDraft(text)) return null;
	const parts = text.split(FENCE_SPLIT), out: SpecElement[] = [], meta = metaLine(bot);
	for (let i = 0; i < parts.length; i += 3) {
		out.push(...blocks(parts[i]!, i === parts.length - 1, shape, meta));
		if (i + 2 >= parts.length) break;
		const lang = parts[i + 1]!, code = parts[i + 2]!;
		if (!relayed && lang.trim() === "목록") out.push(rowsOf(code));
		else if (!relayed && lang.trim() === "chart" && code.trim()) out.push(...chartOf(code));
		else out.push(mk("Code", { code: code.replace(/\n$/, ""), ...(!relayed && lang ? { lang } : {}) }));
	}
	return out;
}

// Words and basic markdown only: conversation, no spec.
const PLAIN_TYPES = new Set(["Text", "Heading", "Bullets", "Quote", "Meta", "Rule", "Code", "Files"]);

/** The spec of a message's body (tone marker already gone), or null when it is conversation: no shape, plain sentences. A draft approval, a message over SPEC_LIMITS and anything validateSpec refuses are null too; the text then goes the plain way.
 * tone: the status mark read off the front (hub/events.ts), the Status element in front of the shapes; a body with no shape stays text all the same. */
export function deriveSpec(text: string, bot = "", tone?: string): MessageSpec | null {
	try {
		if (typeof text !== "string" || !text.trim()) return null;
		const els = parse(text, true, false, bot);
		if (!els || els.every(e => PLAIN_TYPES.has(e.type) && e.props.text !== CHART_NOTE)) return null;
		const spec = specOfElements(tone ? [mk("Status", { tone }), ...els] : els);
		return validateSpec(spec).ok ? spec : null;
	} catch {
		return null;
	}
}

/** Basic markdown as a spec, for text that is not an answer (a document, a quote, a relayed line): the same blocks without answer shapes. Not validated: a page draws any text. */
export function deriveBasicSpec(text: string, relayed = false, bot = ""): MessageSpec {
	return specOfElements(parse(String(text ?? ""), false, relayed, bot) ?? []);
}

// ---- a model-written ```dotz-spec fence ----
const SPEC_FENCE = /(\n|^)([ \t]{0,3})```([^\n`]*)\n?([\s\S]*?)(?:```[ \t]*(?=\n|$)|$)/g;
function readable(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") { if (v.trim()) out.push(v); }
	else if (Array.isArray(v)) for (const x of v) readable(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) readable(x, out);
	return out;
}
function fenceBody(body: string): string | null {
	let json: unknown;
	try { json = JSON.parse(body); } catch { return null; }
	const ok = validateSpec(json);
	if (ok.ok) return specPlain(ok.spec);
	const els = (json as { elements?: Record<string, { props?: unknown; children?: unknown }> } | null)?.elements;
	const words = els && typeof els === "object" && !Array.isArray(els) ? Object.values(els).map(e => readable(e?.props).join("\n")).filter(Boolean) : readable(json);
	return words.length ? words.join("\n\n") : null;
}

/** A model-written ```dotz-spec fence replaced by its plain form when valid, by its readable strings when not. Text without a fence comes back unchanged. A fence that is not JSON stays as the code block it is. */
export function resolveSpecFence(text: string): string {
	if (typeof text !== "string" || !text.includes("dotz-spec")) return text;
	try {
		return text.replace(SPEC_FENCE, (all, lead: string, _indent: string, lang: string, body: string) => {
			if (lang.trim() !== "dotz-spec") return all;
			const plain = fenceBody(body);
			return plain === null ? all : lead + plain;
		});
	} catch {
		return text;
	}
}
