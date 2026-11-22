import { say } from "../notice.ts";
import { CODE_LINE, CODE_SPAN, INLINE_CODE, outsideFences, shortened } from "./plaintext.ts";
import { isProtocolAnswer } from "./report.ts";
import type { Finding } from "./types.ts";

const MAX_LISTED = 5;
const LEFTOVER = /남은\s*것|남은\s*일|남은\s*문제|아직\s*남|후속\s*작업|다음에\s*할|나중에\s*(?:할|하겠|처리|고치|고칠|손볼|다루)|\bremaining\b|\bfollow[- ]?ups?\b|\bleft for later\b|\bnot yet done\b/i;
const MARKER = /\bTODO\b/;
const NOTHING_LEFT = /(?:남은\s*(?:것|일|문제)[은는이가]?\s*(?:없|하나도\s*없)|없습니다|없음|\bnothing\b|\bnone\b|\bno\s+(?:remaining|follow[- ]?ups?)\b)/i;
const DONE_VERB = /고쳤|해결했|해결됨|처리했|마쳤|끝냈|반영했|\b(?:fixed|resolved|addressed|closed)\b|(?<!\bnot yet )\bdone\b/i;
const BLOCKER = /권한이?\s*없|차단(?:됨|되어|돼|된)|막혀|막힘|승인(?:이|을)?\s*(?:필요|받아야|대기|기다)|오너(?:의)?\s*(?:결정|승인)|\bneeds? the owner\b|\bblocked by\b|\bcan(?:no|')t reach\b|\bcannot reach\b/i;
const LIST_MARK = /^\s*(?:[-*•]\s+|\d+[.)]\s+)/;
const HEADER_END = /[:：]\s*$/;
const INTRO = "Your last reply lists known defects or open items that you left unfixed (\"remaining\", \"follow-up\", \"남은 것\"). A defect found in what you changed is fixed in the same run, not listed. Lines:";
const OUTRO = "Fix each listed item now in this run, then write the final report again. Keep an item only when something outside your reach blocks it (a permission, an owner decision, a system you cannot reach), and then name that blocker in the item's own line.";

/**
 * The known, unfixed items a reply lists: one `leftover:unfixed` finding per line, in line order, outside fenced code blocks and not
 * indented 4 spaces or a tab. A line introduces leftovers with a Korean phrase (`남은 것`, `남은 일`, `남은 문제`, `아직 남`, `후속 작업`,
 * `다음에 할`, `나중에 할` and the like) or an English word (`remaining`, `follow-up`, `left for later`, `not yet done`, or the marker word in capitals); every bullet or
 * numbered line right after it (blank lines between are skipped) is a finding, and so is a bullet that contains such a phrase itself,
 * which also introduces the bullets after it when it ends in a colon. A line that says nothing is left (`남은 것 없음`, `없습니다`, `nothing`,
 * `none`) or that the items were done (`고쳤`, `해결했`, `fixed`, `resolved`, `done` but not `not yet done`) introduces nothing. Inline code is ignored. A line that names a blocker the agent
 * cannot remove (`권한 없음`, `차단됨`, `막힘`, `승인 필요`, `오너 결정`, `needs the owner`, `blocked by`, `cannot reach`) is no finding, and exempts
 * only itself. Quote lines (`>`) are not looked into. The finding's `line` is the 1-based line of the reply and its `text` the line
 * cut to 100 characters. Empty for an undefined reply or a protocol answer (`ok`, `-`, `[later]`).
 */
export function leftoverFindings(reply: string | undefined): Finding[] {
	if (reply === undefined || isProtocolAnswer(reply)) return [];
	const raws = outsideFences(reply);
	const lines = raws.map(raw => (raw === undefined || CODE_LINE.test(raw) || raw.trim().startsWith(">") ? undefined : raw.replace(INLINE_CODE, CODE_SPAN)));
	const listed = new Set<number>();
	lines.forEach((line, at) => {
		if (line === undefined || !(LEFTOVER.test(line) || MARKER.test(line)) || NOTHING_LEFT.test(line) || DONE_VERB.test(line)) return;
		const bullet = LIST_MARK.test(line);
		if (bullet) listed.add(at);
		if (bullet && !HEADER_END.test(line)) return;
		for (let next = at + 1; next < lines.length; next++) {
			const following = lines[next];
			if (following !== undefined && following.trim() === "") continue;
			if (following === undefined || !LIST_MARK.test(following)) break;
			listed.add(next);
		}
	});
	return [...listed]
		.sort((a, b) => a - b)
		.flatMap((at): Finding[] => {
			const masked = lines[at] ?? "";
			if (BLOCKER.test(masked)) return [];
			const text = shortened(raws[at] ?? "");
			return [{ stage: "leftover", class: "unfixed", message: `reply line ${at + 1}: ${text}`, line: at + 1, text }];
		});
}

/** The refusal text for `findings` of the `leftover` stage: that a defect found in what the run changed is fixed in the same run, up to 5 of the listed lines with their line numbers and how many more there are, and to fix each item now and write the final report again, keeping an item only with the blocker named in its line. */
export function leftoverRefusal(findings: readonly Finding[]): string {
	const rows = findings.slice(0, MAX_LISTED).map(finding => finding.message);
	if (findings.length > MAX_LISTED) rows.push(`... and ${findings.length - MAX_LISTED} more`);
	return [INTRO, ...rows, OUTRO].join("\n");
}

/** What the user is told, in the machine's notice language, when a stop lets through a reply that still lists unfixed items because the run already refused one: the first listed line and how many others there are. */
export function leftoverWarning(findings: readonly Finding[]): string {
	const others = findings.length - 1;
	const first = findings.at(0)?.message ?? "";
	return say({
		en: `done-gate: the last reply still lists unfixed items, starting at ${first}${others > 0 ? ` (${others} more line${others === 1 ? "" : "s"})` : ""}; this run already refused a reply for it, so the stop is allowed.`,
		ko: `done-gate: 마지막 답변에 아직 고치지 않은 항목이 남아 있습니다(${first}${others > 0 ? ` 외 ${others}줄` : ""}). 이번 실행에서 이미 한 번 되돌렸으므로 종료를 허용합니다.`,
	});
}
