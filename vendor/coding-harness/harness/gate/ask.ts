import { say } from "../notice.ts";
import { CODE_LINE, CODE_SPAN, INLINE_CODE, outsideFences, shortened } from "./plaintext.ts";
import { isProtocolAnswer } from "./report.ts";
import type { Finding } from "./types.ts";

const MAX_LISTED = 5;
const TAIL = String.raw`[\s.!?？:：)\]}"'”’…]*$`;
const KO_REQUEST = /(?:정해|골라|선택해|결정해|알려)\s*(?:주세요|주시면|주십시오)/;
const KO_QUESTION = new RegExp(String.raw`(?:할까요|될까요|갈까요|볼까요|드릴까요|하시겠어요|하시겠습니까|하실래요|원하시나요|괜찮을까요)${TAIL}`);
const QUESTION_MARK = /[?？]\s*(?:\([^()]*\))?\s*[)\]"'”’]*\s*[:：]?\s*$/;
const EN_ASK = /\b(?:should I|shall I|do you want|would you like|want me to|let me know (?:if|whether|which)|which (?:one|option) do you)\b/i;
const EXPLAINS = /^(?:왜|why\b|how come\b)/i;
const LIST_MARK = /^\s*(?:[-*•]\s+|\d+[.)]\s+)/;
const SENTENCE_BREAK = /(?<=[.!?？。])\s+/;
const INTRO = "Your last reply asks the user to decide or answer something in its text. Every question or decision for the user goes through the `ask` tool as a form, never in the reply. Lines that ask:";
const OUTRO = "Call the `ask` tool now: one form that holds every open question, each with its options and the recommended option preselected. Then write the final report again without the question; the user's answer arrives as the tool result.";

function asks(raw: string): boolean {
	const line = raw.replace(INLINE_CODE, CODE_SPAN).trim();
	if (line === "" || line.startsWith(">")) return false;
	const sentence = line.split(SENTENCE_BREAK).at(-1)?.replace(LIST_MARK, "").trim() ?? "";
	if (EXPLAINS.test(sentence)) return false;
	return KO_REQUEST.test(line) || KO_QUESTION.test(line) || QUESTION_MARK.test(line) || EN_ASK.test(line);
}

/**
 * What a reply asks of the user in its text: one `ask:question` finding per line, in line order, outside fenced code blocks and not
 * indented 4 spaces or a tab, that asks the user to decide or answer: a Korean request to choose or tell (`정해`, `골라`, `선택해`,
 * `결정해` or `알려` followed by `주세요`, `주시면` or `주십시오`), a Korean question ending (`할까요`, `될까요`, `갈까요`, `볼까요`,
 * `드릴까요`, `하시겠어요`, `하시겠습니까`, `하실래요`, `원하시나요`, `괜찮을까요`) at the line end, a line ending in `?` or `？` (a closing
 * parenthesis, quote or colon may follow), or English `should I`, `shall I`, `do you want`, `would you like`, `want me to`,
 * `let me know if|whether|which`, `which one|option do you`. Inline code is ignored. A line whose last sentence starts with `왜`,
 * `why` or `how come` explains rather than asks, and quote lines (`>`) are not asks. The finding's `line` is the 1-based line of the
 * reply and its `text` the line cut to 100 characters. Empty for an undefined reply or a protocol answer (`ok`, `-`, `[later]`).
 */
export function askFindings(reply: string | undefined): Finding[] {
	if (reply === undefined || isProtocolAnswer(reply)) return [];
	return outsideFences(reply).flatMap((line, at): Finding[] => {
		if (line === undefined || CODE_LINE.test(line) || !asks(line)) return [];
		const text = shortened(line);
		return [{ stage: "ask", class: "question", message: `reply line ${at + 1}: ${text}`, line: at + 1, text }];
	});
}

/** The refusal text for `findings` of the `ask` stage: that questions and decisions for the user go through the `ask` tool as one form with a preselected recommendation, up to 5 of the asking lines with their line numbers and how many more there are, and to ask first and then write the final report without the question. */
export function askRefusal(findings: readonly Finding[]): string {
	const rows = findings.slice(0, MAX_LISTED).map(finding => finding.message);
	if (findings.length > MAX_LISTED) rows.push(`... and ${findings.length - MAX_LISTED} more`);
	return [INTRO, ...rows, OUTRO].join("\n");
}

/** What the user is told, in the machine's notice language, when a stop lets through a reply that still asks in its text because the run already refused one: the first asking line and how many others there are. */
export function askWarning(findings: readonly Finding[]): string {
	const others = findings.length - 1;
	const first = findings.at(0)?.message ?? "";
	return say({
		en: `done-gate: the last reply still asks the user something in its text instead of the \`ask\` tool, starting at ${first}${others > 0 ? ` (${others} more line${others === 1 ? "" : "s"})` : ""}; this run already refused a reply for it, so the stop is allowed.`,
		ko: `done-gate: 마지막 답변이 \`ask\` 도구 대신 본문에서 사용자에게 질문하고 있습니다(${first}${others > 0 ? ` 외 ${others}줄` : ""}). 이번 실행에서 이미 한 번 되돌렸으므로 종료를 허용합니다.`,
	});
}
