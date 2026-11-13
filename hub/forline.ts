import { parseDecisions } from "./choices.ts";
import { NAME } from "./config.ts";

// A report's "For <bot>:" / "<bot> 몫:" line is a chore for the orchestrator (empty, "없음", "-", or a real hand-off). The
// orchestrator reads the raw report; the owner's chat view and Discord never show the line (2026-10-23, "땃쥐 몫: 없음").
const NAME_RE = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 땃쥐 is the other gateway's name: reports stored there still carry it. `-# ` is how a system note is stored (hub/outbound.ts).
const FOR_LINE = new RegExp(`^\\s*(?:-#?\\s+)?(?:\\*\\*)?(?:For (?:${NAME_RE}|땃쥐):|(?:${NAME_RE}|땃쥐) 몫:)`, "i");
const FENCE = /^\s*```/;
export const isForLine = (line: string): boolean => FOR_LINE.test(line);

export function dropForLine(text: string): string {
	let fence = false;
	const kept: string[] = [];
	let dropped = false;
	for (const line of text.split("\n")) {
		if (FENCE.test(line)) fence = !fence;
		else if (!fence && FOR_LINE.test(line)) {
			dropped = true;
			continue;
		}
		kept.push(line);
	}
	if (!dropped) return text;
	const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
	return out || text;
}

// The "For <bot>:" lines dropForLine removes (outside code fences), joined; "" when there are none.
export function forLines(text: string): string {
	let fence = false;
	return text
		.split("\n")
		.filter(line => (FENCE.test(line) ? ((fence = !fence), false) : !fence && FOR_LINE.test(line)))
		.join("\n");
}

// A session's [ask] whose only request is its "For <bot>:" line (a real hand-off, no choice block, no question mark elsewhere, not a
// budget question) is a question for the orchestrator, not the owner: it makes no decision, badge or push (2026-10-23).
const NO_REQUEST = /^[\s\-–—.]*(?:없음|없어요|없습니다|none|n\/a)?[\s.]*$/i;
// A [wait] that names the main session as what it waits on (2026-11-06..13: 13 such reports stayed on disk and their lanes sat up to 173 min).
// A build, CI or a worker is not main; "메인 브랜치", "메인 페이지" and "메인에 머지" (or "merge to main") are the branch or a screen, so 메인, main
// and the bot's own name count only as the one who acts, is asked or is waited on ("메인에 맡겼어요", "메인에서 띄우면", "waiting for main to").
// The English "main" inside Korean text ("main에 머지", "main 최신", "`main`") is always the branch there: the session is 메인 in Korean.
const WHO = `(?:${NAME_RE}|땃쥐)`;
const ACTOR = "(?:에게|한테|께|님|[이가](?![가-힣])|[을를]\\s*기다|의(?![가-힣])|\\s*몫)";
const KO_ASKED = "에(?!\\s*(?:머지|병합|올[려리렸린릴]|반영|push|푸시|merge))\\s*[^\\n.]{0,30}?(?:맡[기겼길깁겨]|부탁|요청|넘[기겼길겨])";
const KO_DOES = "에서\\s+(?!(?:브랜치|분기|따|딴|땄|리베이스|rebase|pull|풀|checkout|체크아웃|머지|병합))";
const EN_BRANCH = "(?<!\\b(?:merge[ds]?|merging|push(?:e[ds])?|pushing|land(?:ed|s|ing)?|rebased?|rebasing|based?|checkout|checked out)\\b[^\\n.]{0,40}?\\s(?:to|into|onto|on|off|from)\\s+)(?<!\\b(?:the|a|its|our|their|my|your|this|that|into|onto|on|off|against|in|latest|current|local|remote|upstream|origin|fast-forward(?:ed)?|ff|updated?|pull(?:ed)?|sync(?:ed)?|reset)\\s+)";
const EN_NOT_MAIN = "(?![\\w./(`-])(?!\\s*[가-힣])(?!\\s+(?:branch|repo(?:sitory)?|page|screen|function|thread|file|module|menu|window|view|loop|method|entry|head|build)|\\s*\\(|\\s+[0-9a-f]{7,40}\\b)";
const EN_WHO = `(?:(?:for|from|ask(?:ed|ing)?|tell|told|ping(?:ed)?|until)\\s+${WHO}(?![\\w./-])|(?<![\\w./-])${WHO}\\s+(?:to|should|needs?|must|will|has|answers?|decides?|confirms?)\\b)`;
const MAIN_NAMED = new RegExp(
	`(?<![\\w./-])${WHO}${ACTOR}|${EN_WHO}|메인(?:에게|한테|께|이(?![가-힣])|을\\s*기다|의\\s*(?:답|확인|결정|몫)|${KO_ASKED}|${KO_DOES})|오케스트레이터|orchestrator|main session|${EN_BRANCH}(?<![\\w./\\x60-])main${EN_NOT_MAIN}`,
	"i",
);
export const mentionsMain = (text: string): boolean => MAIN_NAMED.test(dropForLine(text));
/** The text hands main something to do: a real for-line, or (with none written) words that name main. A for-line saying "없음" is no request. */
export function waitsOnMain(text: string): boolean {
	const lines = forLines(text);
	if (lines) return lines.split("\n").some(l => !NO_REQUEST.test(l.replace(FOR_LINE, "")));
	return mentionsMain(text);
}

export function orchestratorOnlyAsk(text: string): boolean {
	if (/\/budget-ok/.test(text) || parseDecisions(text).blocks.length) return false;
	const line = text.split("\n").find(l => FOR_LINE.test(l));
	if (!line || NO_REQUEST.test(line.replace(FOR_LINE, ""))) return false;
	return !/[?？]/.test(text.split("\n").filter(l => l !== line).join("\n"));
}
