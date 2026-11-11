// A message that asks the owner to pick from a list becomes a real decision (owner 2026-11-04: "교훈이 아니라 코드에 강제해야지"): the gateway
// rewrites a trailing option list into the contract's choice block (MODE.md "Message layout") at the send boundary, for every author
// (outbound.out, lanereport.report, the lane mid-turn texts in lanewire.ts). The rest of the message stays as written. No model call: this
// runs on every outgoing message, and a text without a question signal leaves at the first regex.
// False positives are the risk, so it needs both a trailing list of 2-4 clean options and a question line right above it that offers a
// choice. A yes / no question counts only under a "결정 필요" heading, in an [ask], or when an option carries a recommendation.
import { askedDraft } from "./ask-options.ts";
import { D_CLOSE, DECISION_HEAD, D_OPT, DETAIL_DESC, DETAIL_MARK, parseDecisions, stripRecommendMark } from "./choices.ts";
import { parseDraftApproval, parseQuotedDraft } from "./draft-approval.ts";
import { isForLine, orchestratorOnlyAsk } from "./forline.ts";
import { parseTone, splitTone } from "./tone.ts";

const FENCE = /^\s*```/;
const SIGNAL = /[?？]|까요|주세요|결정\s*(?:이\s*)?필요|decision needed/i;
const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:결정\s*(?:이\s*)?필요(?:해요|합니다)?|decision needed)\s*(?:\*\*)?\s*[:：]?\s*(.*?)\s*(?:\*\*)?\s*$/i;
// The line ends in a question (a parenthesis or ":" may follow it) or in a request to choose.
const ASKS = /(?:[?？]|까요|나요)\s*(?:\([^()]*\))?\s*:?\s*$|(?:골라|정해|선택해|알려)\s*주세요[.:]?\s*$/;
// A question about the past or a reason answers itself in the list ("왜 이렇게 됐을까요?", "무엇이 바뀌었나요?").
const RHETORICAL = /왜|\bwhy\b|\bdid\b/i;
const PAST_ENDING = /([가-힣])(?:나요|을까요|습니까)/g;
const FINAL_SS = 20;
const asksPast = (q: string) => [...q.matchAll(PAST_ENDING)].some(m => (m[1]!.charCodeAt(0) - 0xac00) % 28 === FINAL_SS);
const OFFERS = /어느|어떤\s*(?:쪽|걸|것|안|방식|방법)|뭘로|뭐로|무엇으로|뭘\s*할까요|선택|골라|정해|[할갈]지|아니면|둘\s*중|\b(?:which|choose|pick|prefer|or)\b|how should/i;
const HOW = /어떻게/;
const HOW_PROCEED = /어떻게\s*(?:(?:진행|처리|반영|결정|마무리|정리)\s*)?(?:할|하면|하시겠|하실|하죠|해요)/;
// Lines that may follow the list: attachments and role lines, then, after a blank line, a short "label: value" (대조표: `/tmp/...`).
const META = /^\s*(?:-#\s*)?(?:[-*]\s+)?(?:\[file\]\s|근거:|출처:|Evidence:|Source:|For\s+\S+:|\S+\s몫:)/i;
const LABELED = /^\s*[^\s:：|]{1,12}\s?[:：]\s/;
const CLOSING = /^[^|]{0,60}(?:골라|알려|말씀|답해)\s*주(?:세요|시면|면)/;
const NUMBERED = /^\s*(?:\*\*)?\s*(\d)[.)]\s*(.+)$/;
const BULLET = /^\s*[-*•]\s+(.+)$/;
const REC = /←\s*(?:추천|recommended)|\(\s*(?:추천|권장|recommended)\s*\)/i;
// A finished sentence or an instruction is a report line or a step, never a button.
const NOT_LABEL = /(?:세요|십시오|습니다|했어요|됐어요|있어요|었어요|았어요)\s*[.!]?$|[.。]$/;
const MAX_LABEL = 40;
const LOOK_BACK = 14;

type Option = { label: string; desc: string; rec: boolean; detail: boolean };
type Found = { from: number; end: number; lead: string; question: string; options: Option[] };

const plain = (s: string) => s.replace(/\*\*/g, "").replace(/^\s*(?:#{1,6}\s+|\d+[.)]\s+|[-*]\s+)/, "").trim();
const sentences = (s: string) => s.split(/(?<=[.!?？。])\s+/).filter(Boolean);
const flat = (s: string) => s.replace(/\s+/g, "");

function optionOf(body: string, headed = false): Option | undefined {
	let s = body.replace(/\*\*/g, "").trim();
	const rec = REC.test(s);
	s = s.replace(REC, "").trim();
	let detail = DETAIL_MARK.test(s);
	s = s.replace(DETAIL_MARK, "").trim();
	let desc = "";
	const split = /^(.+?)\s*(?:[:：]\s+|\s[-–—]\s)(.+)$/.exec(s);
	const asked = /^(.+?)\s*\(([^()]+)\)$/.exec(s);
	if (split) [s, desc] = [split[1]!, split[2]!];
	else if (asked && DETAIL_DESC.test(asked[2]!)) [s, desc] = [asked[1]!, asked[2]!];
	if (DETAIL_DESC.test(desc)) detail = true;
	// Under a "결정:" line the head vouches for the list: a long or sentence-like name is still an option, cut to a button's size with the rest as its description.
	if (headed && s && [...s].length > MAX_LABEL) {
		const [, first, more] = /^(.+?)[.。]\s+(.+)$/.exec(s) ?? [];
		if (first && [...first].length <= MAX_LABEL) [s, desc] = [first, desc || more!];
		else [s, desc] = [[...s].slice(0, MAX_LABEL).join("").replace(/\s+\S*$/, ""), desc || s];
	}
	return !s || (!headed && ([...s].length > MAX_LABEL || NOT_LABEL.test(s))) ? undefined : { label: s, desc, rec, detail };
}

const isTail = (line: string) => META.test(line) || D_CLOSE.test(line) || CLOSING.test(line) || LABELED.test(line);

// The options from line `from` to the message's end (or `limit`): nothing but options, one description line each, and closing lines.
// In an [ask] (`marked`) a numbered list under the question is its options however long they run (split-panes 2026-11-09): a long name is cut
// to a button's size with the whole line as its description, as under a "결정:" line.
function readOptions(lines: string[], fenced: boolean[], from: number, limit: number, marked: boolean): { options: Option[]; end: number } | undefined {
	const options: Option[] = [];
	let style = "";
	let i = from;
	for (; i < limit; i++) {
		const line = lines[i]!;
		if (fenced[i]) return undefined;
		if (!line.trim()) continue;
		if (META.test(line)) break;
		const n = NUMBERED.exec(line), b = BULLET.exec(line);
		const body = n && style !== "bullet" && Number(n[1]) === options.length + 1 ? n[2] : !n && b && style !== "number" ? b[1] : undefined;
		if (body !== undefined) {
			const o = optionOf(body, marked && !!n);
			if (!o) return undefined;
			options.push(o);
			style = n ? "number" : "bullet";
			continue;
		}
		const prev = options.at(-1);
		if (!prev) return undefined;
		if (D_CLOSE.test(line)) break;
		if (lines[i - 1]!.trim() && !prev.desc && !/^\s*[>|]/.test(line)) {
			prev.desc = line.trim();
			if (DETAIL_DESC.test(prev.desc)) prev.detail = true;
			continue;
		}
		if (isTail(line)) break;
		return undefined;
	}
	const end = i;
	for (; i < limit; i++) if (fenced[i] || (lines[i]!.trim() && !isTail(lines[i]!))) return undefined;
	return options.length >= 2 && options.length <= 4 ? { options, end } : undefined;
}

function findBlock(lines: string[], fenced: boolean[], limit: number, marked: boolean): Found | undefined {
	for (let q = limit - 1; q >= 0 && q >= limit - LOOK_BACK; q--) {
		const line = lines[q]!;
		if (fenced[q] || !line.trim() || /^\s*[>|]/.test(line)) continue;
		const head = HEADING.exec(line);
		if (!head && BULLET.test(line)) continue;
		// A question on the "For <bot>:" line is the orchestrator's to answer: its list is no owner card (forline.ts orchestratorOnlyAsk).
		if (isForLine(line)) return undefined;
		const text = head ? (head[1] ?? "") : plain(line);
		if (!head && !ASKS.test(text)) continue;
		const got = readOptions(lines, fenced, q + 1, limit, marked);
		if (!got) continue;
		const parts = sentences(text);
		const at = parts.findLastIndex(s => /[?？]|까요|나요|주세요/.test(s));
		const question = at < 0 ? text : parts.slice(at).join(" ");
		const prior = lines.slice(0, q).findLastIndex(l => l.trim());
		const bareHead = prior >= 0 && HEADING.exec(lines[prior]!)?.[1] === "";
		const underHead = bareHead || (/^\s*(?:\*\*)?\d[.)]/.test(line) && lines.slice(0, q).some(l => HEADING.test(l)));
		if (RHETORICAL.test(question) || asksPast(question)) return undefined;
		const offered = HOW.test(question) ? HOW_PROCEED.test(question) : OFFERS.test(question);
		if (!offered && !marked && !head && !underHead && !got.options.some(o => o.rec)) return undefined;
		return { from: bareHead ? prior : q, end: got.end, lead: at > 0 ? parts.slice(0, at).join(" ") : "", question, options: got.options };
	}
	return undefined;
}

function blockLines(f: Found): string[] {
	const ko = /[가-힣]/.test(f.question + f.options.map(o => o.label).join(""));
	const question = f.question.replace(/\*\*/g, "").trim() || (ko ? "어떻게 할까요?" : "How should I proceed?");
	const options = f.options.flatMap((o, i) => [`**${i + 1}) ${o.label}${o.detail ? " …" : ""}**`, ...(o.desc ? [o.desc] : [])]);
	return [...(f.lead ? [f.lead, ""] : []), `${ko ? "결정" : "Decision"}: ${question}`, ...options];
}

// "1) 보내기 / 2) 고치기 / 3) 보내지 않기" on one line of an [ask]: no parser reads a row, and the [ask] vouches that it is the choice.
const OPTION_ROW = /^\s*1[.)]\s*\S.*\s[/|·]\s*2[.)]\s*\S/;
function rowToHead(text: string): string {
	if (!/\[ask\]/i.test(text) || !/[/|·]\s*2[.)]/.test(text)) return text;
	const { tone, head, rest } = splitTone(text);
	const lines = rest.split("\n");
	const fenced = fenceMap(lines);
	const at = lines.findIndex((l, i) => !fenced[i] && OPTION_ROW.test(l));
	if (tone !== "ask" || at < 0 || lines.some((l, i) => !fenced[i] && DECISION_HEAD.test(l))) return text;
	const items = lines[at]!.split(/\s[/|·]\s*(?=\d[.)])/).map(x => x.replace(/^\s*\d[.)]\s*/, "").trim());
	if (items.length > 4 || items.some(x => !x)) return text;
	lines.splice(at, 1, "결정: 어떻게 할까요?", ...items.map((x, i) => `**${i + 1}) ${x}**`));
	return `${head}${lines.join("\n")}`;
}

/** The text with every option list as the contract's choice block and a status marker the surfaces read; unchanged when it asks nothing but for an old recommendation mark. Idempotent. */
// A session may show the card a command printed in a code block (hub/mail-cli.ts ask): the one fence of the message, around a whole send-approval card, comes off, or the
// card has no buttons and no ref (issue #69). A fenced text with anything else in it stays code.
function unfencedCard(text: string): string {
	if (!text.includes("```")) return text;
	const parts = text.split(/^\s*```.*$/m);
	if (parts.length !== 3 || !parseDraftApproval(parts[1]!.trim())?.ref) return text;
	return parts.map(p => p.trim()).filter(Boolean).join("\n");
}
export const normalizeAsk = (text: string): string => stripRecommendMark(toChoiceBlock(canonHeaded(rowToHead(unfencedCard(text)))));
/** Only the blocks a "결정:" line opened: for text the gateway wrote itself, where a question over a list is no guess about a model's meaning. */
export const normalizeHeaded = (text: string): string => stripRecommendMark(canonHeaded(text, false));

// A "결정:" line however the model dressed it ("**결정:** x", "### 결정: x", "**1) 결정: x**", "결정 필요: x"); a line inside a quote never matches.
const HEAD_DRESS = /^\s*(?:#{1,6}\s+)?(?:\*\*)?\s*(?:\d[.)]\s+)?(결정|decision)(?:\s*(?:이\s*)?(?:필요(?:해요|합니다)?|needed))?(\s*#?\d{1,2})?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*?)\s*(?:\*\*)?\s*$/i;
const BARE_HEADING = /^\s*(?:#{1,6}\s+|\*\*)\s*(?:결정\s*(?:이\s*)?필요(?:해요|합니다)?|decision needed)\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*(.*)$/i;
const CIRCLED = "①②③④⑤⑥⑦⑧⑨";
const HEADED_OPTION = new RegExp(`^\\s*(?:\\*\\*)?\\s*(?:(\\d{1,2})(?:\\)|\\.(?!\\d))|([${CIRCLED}]))\\s*(.+)$`);
const CANON_OPTION = /^\s*(?:\*\*)?\s*\d{1,2}\)\s*[^*\s][^*]*(?:\*\*)?\s*$/;
const QUOTED = /^\s*[>|]/;
const ASKS_ANYTHING = /[?？]|까요|나요|주세요/;
const MAX_HEADED = 9;
// A recommendation at the end of a list is the message going on, not one more option.
const RECOMMEND_LINE = /^\s*[-*•]\s+(?:\*\*)?추천\s*[:：]/;
const LETTERED = /^\(?[a-d]\)\s+/i;
const NESTED_QUESTION = /^\s*(?:\*\*)?\d[.)]\s+(.+?)\s*(?:\*\*)?\s*$/;
const NESTED_OPTION = /^\s+(?:\d[.)]|[-*•])\s/;
// "**결정 필요**" over "1. 질문?" and its indented options: the numbered line is the head, and the message may go on after the list.
function nestedHead(lines: string[], i: number): string[] | null {
	const q = NESTED_QUESTION.exec(lines[i]!)?.[1];
	if (!q || !ASKS_ANYTHING.test(q) || !NESTED_OPTION.test(lines[i + 1] ?? "")) return null;
	// Two numbered questions are two blocks (toChoiceBlock); this is the one question of a message that goes on after its list.
	if (lines.some((l, n) => n !== i && ASKS_ANYTHING.test(NESTED_QUESTION.exec(l)?.[1] ?? "") && !NESTED_OPTION.test(l))) return null;
	return lines.slice(0, i).some(l => HEADING.exec(l)?.[1] === "") ? ["", "결정", "", q] : null;
}
type Headed = { option: Option; raw: string; sameLine: boolean };

// The options under a "결정:" line in any list style: numbers in a row, or bullets at one indent; a line under an option, or a deeper bullet, is its description.
function readHeaded(lines: string[], fenced: boolean[], from: number): { list: Headed[]; numbered: boolean; end: number } | undefined {
	const list: Headed[] = [];
	let numbered = false, indent = -1, end = from;
	for (let i = from; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.trim()) continue;
		if (fenced[i] || QUOTED.test(line) || HEAD_DRESS.test(line) || D_CLOSE.test(line) || META.test(line) || RECOMMEND_LINE.test(line)) break;
		const n = HEADED_OPTION.exec(line), b = n ? null : BULLET.exec(line);
		const at = line.length - line.trimStart().length;
		const num = n ? (n[1] ? Number(n[1]) : CIRCLED.indexOf(n[2]!) + 1) : 0;
		const isNext = list.length ? (numbered ? num === list.length + 1 : !!b && at <= indent) : !!n ? num === 1 : !!b;
		if (isNext) {
			const body = n ? n[3]! : b![1]!.replace(LETTERED, "");
			const option = optionOf(body, true);
			if (!option) return undefined;
			if (!list.length) [numbered, indent] = [!!n, at];
			list.push({ option, raw: line, sameLine: !!option.desc });
			end = i + 1;
			continue;
		}
		const prev = list.at(-1);
		// A line right under an option describes it; after a blank line it is the message going on.
		if (!prev || !lines[i - 1]!.trim() || prev.option.desc) break;
		prev.option.desc = line.trim().replace(/^[-*•]\s+/, "");
		end = i + 1;
	}
	return list.length >= 2 && list.length <= MAX_HEADED ? { list, numbered, end } : undefined;
}

// Lines already in the contract's shape stay byte for byte: a card's identity and a draft's text must not move.
const headedLines = (list: Headed[]): string[] =>
	list.flatMap(({ option: o, raw, sameLine }, i) => {
		const keep = !sameLine && CANON_OPTION.test(raw) && D_OPT.exec(raw)?.[1] === String(i + 1);
		return [keep ? raw : `**${i + 1}) ${o.label}${o.detail ? " …" : ""}**`, ...(o.desc ? [o.desc] : [])];
	});

// Every "결정:" block in the contract's shape, wherever it stands and whatever list the model wrote, so the one parser reads it. Fences and quotes stay as written.
function canonHeaded(text: string, mark = true): string {
	if (!/결정|decision/i.test(text)) return text;
	const { tone, head, rest } = splitTone(text);
	const lines = rest.split("\n");
	const fenced = fenceMap(lines);
	const out: string[] = [];
	let blocks = 0;
	for (let i = 0; i < lines.length; i++) {
		const m: string[] | null = fenced[i] ? null : (HEAD_DRESS.exec(lines[i]!) ?? nestedHead(lines, i));
		if (!m || !m[3]) {
			out.push(lines[i]!);
			continue;
		}
		const got = readHeaded(lines, fenced, i + 1);
		// Bullets under a statement are a report of what was decided, not a question.
		if (!got || (!got.numbered && tone !== "ask" && !ASKS_ANYTHING.test(m[3]))) {
			out.push(lines[i]!);
			continue;
		}
		blocks++;
		const label = `${m[1]!.replace(/^d/, "D")}${m[2] ?? ""}: ${m[3]}`;
		const next = lines.slice(got.end).find(l => l.trim());
		out.push(DECISION_HEAD.exec(lines[i]!)?.[1] === m[3] ? lines[i]! : label, ...headedLines(got.list));
		if (next !== undefined && lines[got.end]!.trim()) out.push("");
		i = got.end - 1;
	}
	if (!blocks) return text;
	const clean = dropBareHeading(out, fenceMap(out)).join("\n");
	return !mark || tone === "ask" || tone === "fail" || tone === "done" ? `${head}${clean}` : `[ask] ${clean.trimStart()}`;
}

// "**결정 필요**" above "결정:" blocks says what the card says: the heading goes, a note on its line stays.
function dropBareHeading(lines: string[], fenced: boolean[]): string[] {
	const out: string[] = [];
	lines.forEach((line, i) => {
		const m = fenced[i] || HEAD_DRESS.test(line) ? null : BARE_HEADING.exec(line);
		const next = lines.slice(i + 1).find(l => l.trim());
		if (!m || !next || !DECISION_HEAD.test(next)) return void out.push(line);
		if (m[1]!.trim()) out.push(m[1]!.trim());
	});
	return out;
}

const fenceMap = (lines: string[]): boolean[] => {
	let open = false;
	return lines.map(line => {
		const isFence = FENCE.test(line);
		if (isFence) open = !open;
		return open || isFence;
	});
};

// A session's [ask] the owner cannot answer from the card (owner 2026-11-05: "뭐에 대한 질문인지 저기에서 바로 답변이 어려워"): no choice block, not a
// budget question or a quoted draft (both have their own buttons), not a chore for the orchestrator. It never becomes an answer-needed item:
// a turn-end report goes back to the session once (lanereport.ts), everything else goes on as a plain note (plainBareAsk).
export function bareAsk(text: string): boolean {
	const p = parseTone(text);
	return p.tone === "ask" && !parseDecisions(p.text).blocks.length && !/\/budget-ok/.test(text) && !askedDraft(p.text) && !orchestratorOnlyAsk(p.text);
}
export const plainBareAsk = (text: string): string => (bareAsk(text) ? parseTone(text).text : text);

function toChoiceBlock(text: string): string {
	if (!SIGNAL.test(text) || /\[(?:done|완료)\]/i.test(text)) return text;
	const { tone, rest: bare } = splitTone(text);
	if (tone === "done") return text;
	const lines = bare.split("\n");
	const fenced = fenceMap(lines);
	if (lines.some((l, i) => !fenced[i] && DECISION_HEAD.test(l))) return text;
	const found: Found[] = [];
	for (let limit = lines.length; ; ) {
		const f = findBlock(lines, fenced, limit, tone === "ask");
		if (!f) break;
		found.unshift(f);
		// "2. <question>" under a heading: the decisions before it are blocks of the same message.
		if (!/^\s*(?:\*\*)?[2-9][.)]/.test(lines[f.from]!)) break;
		limit = f.from;
	}
	if (!found.length || parseQuotedDraft(bare)) return text;
	let out = lines;
	for (const f of found.slice().reverse()) out = [...out.slice(0, f.from), ...(f.from && out[f.from - 1]!.trim() ? [""] : []), ...blockLines(f), ...(f.end < out.length && out[f.end]!.trim() ? [""] : []), ...out.slice(f.end)];
	return `${tone === "fail" ? "[fail]" : "[ask]"} ${out.join("\n").trim()}`;
}

/** At most `max` characters that still hold the choice block: a long lane report ends in its question, and Discord buttons need every option. */
export function clipKeepingAsk(text: string, max: number): string {
	if (text.length <= max) return text;
	const lines = text.split("\n");
	const at = lines.findIndex(l => DECISION_HEAD.test(l));
	if (at < 0) return text.slice(0, max);
	const block = lines.slice(at).join("\n");
	if (block.length + 2 >= max) return text.slice(0, max);
	return `${text.slice(0, max - block.length - 2)}…\n${block}`;
}
