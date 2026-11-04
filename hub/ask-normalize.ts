// A message that asks the owner to pick from a list becomes a real decision (owner 2026-11-04: "교훈이 아니라 코드에 강제해야지"): the gateway
// rewrites a trailing option list into the contract's choice block (MODE.md "Message layout") at the send boundary, for every author
// (outbound.out, lanereport.report, the lane mid-turn texts in lanewire.ts). The rest of the message stays as written. No model call: this
// runs on every outgoing message, and a text without a question signal leaves at the first regex.
// False positives are the risk, so it needs both a trailing list of 2-4 clean options and a question line right above it that offers a
// choice. A yes / no question counts only under a "결정 필요" heading, in an [ask], or when an option carries a recommendation.
import { D_CLOSE, DECISION_HEAD, DETAIL_DESC, DETAIL_MARK, stripRecommendMark } from "./choices.ts";
import { parseQuotedDraft } from "./draft-approval.ts";
import { splitTone } from "./tone.ts";

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

function optionOf(body: string): Option | undefined {
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
	return !s || [...s].length > MAX_LABEL || NOT_LABEL.test(s) ? undefined : { label: s, desc, rec, detail };
}

const isTail = (line: string) => META.test(line) || D_CLOSE.test(line) || CLOSING.test(line) || LABELED.test(line);

// The options from line `from` to the message's end (or `limit`): nothing but options, one description line each, and closing lines.
function readOptions(lines: string[], fenced: boolean[], from: number, limit: number): { options: Option[]; end: number } | undefined {
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
			const o = optionOf(body);
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
		const text = head ? (head[1] ?? "") : plain(line);
		if (!head && !ASKS.test(text)) continue;
		const got = readOptions(lines, fenced, q + 1, limit);
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

/** The text with its trailing option list as the contract's choice block and a status marker the surfaces read; unchanged when it asks nothing but for an old recommendation mark. Idempotent. */
export const normalizeAsk = (text: string): string => stripRecommendMark(toChoiceBlock(text));

function toChoiceBlock(text: string): string {
	if (!SIGNAL.test(text) || /\[(?:done|완료)\]/i.test(text)) return text;
	const { tone, rest: bare } = splitTone(text);
	if (tone === "done") return text;
	const lines = bare.split("\n");
	const fenced: boolean[] = [];
	let open = false;
	for (const line of lines) {
		if (FENCE.test(line)) open = !open;
		fenced.push(open || FENCE.test(line));
	}
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
