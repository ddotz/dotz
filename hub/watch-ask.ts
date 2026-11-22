import { issueBlock } from "./choices.ts";
import type { DecisionOpt } from "./notices-types.ts";
import type { NotifyInfo } from "./watch-heal.ts";
import { type WatchStatusLike, watchConnection } from "./watch-status.ts";
import { loginLost, watchIssueLine, watchReasonKo } from "./watchtext.ts";

/** The label of the button that runs the existing relogin / re-check path; its card answers it without a model turn (hub/routes.ts deliverAnswer). */
export const RECONNECT = "다시 연결";
/** The action the reconnect option carries (DecisionOpt.action). */
export const RECONNECT_ACTION = "watch-reconnect";
const CHECK = { name: "원인 확인", result: "출력을 보고 원인과 고칠 방법을 알려드려요." };
const STOP_CHECKING = { name: "모니터링 끄기", result: "고칠 때까지 이 모니터링을 멈춰 둬요." };
const RECONNECT_OPT = { name: RECONNECT, result: "지금 다시 로그인해서 확인해요." };
const STOP_WATCHING = { name: "이 모니터링 멈추기", result: "고칠 때까지 이 모니터링을 멈춰 둬요." };
const ISSUE_MAX = 1500;
const TAIL = "(?:원인을 확인할까요, 이 모니터링을 꺼 둘까요|다시 연결할까요, 이 모니터링을 멈출까요)";
const NAMED_TAIL = "(?:원인을 확인할까요, (.+?) 모니터링을 꺼 둘까요|다시 연결할까요, (.+?) 모니터링을 멈출까요)";
const SUBJECT = new RegExp(`^(?:(.+?): .*\\. ${TAIL}|${NAMED_TAIL})\\?$`);

/** The choice block of a watch issue: the question names what happened when the reason is given, so the 알림 row reads without opening it. A watch that lost its login gets 다시 연결 / 원인 확인 / 이 모니터링 멈추기. */
export function watchChoice(name: string, reason = "", login = false): string {
	const said = reason ? `${name}: ${watchReasonKo(reason).split(". ")[0]}. ` : "";
	if (login) return issueBlock(reason ? `${said}다시 연결할까요, 이 모니터링을 멈출까요?` : `다시 연결할까요, ${name} 모니터링을 멈출까요?`, [RECONNECT_OPT, CHECK, STOP_WATCHING]);
	return issueBlock(reason ? `${said}원인을 확인할까요, 이 모니터링을 꺼 둘까요?` : `원인을 확인할까요, ${name} 모니터링을 꺼 둘까요?`, [CHECK, STOP_CHECKING]);
}

/** The alert text of a watch issue: what happened, then the choice block. A watch that lost its login (hub/watch-status.ts) gets the reconnect choice. */
export function watchIssueText(w: WatchStatusLike, label: string, reason: string, info: NotifyInfo | undefined, output: string): string {
	const line = watchIssueLine(label, reason, info, output);
	const down = watchConnection(w);
	return `${line.slice(0, ISSUE_MAX)}\n${watchChoice(label, reason, loginLost(line) || (down.state === "disconnected" && down.reason === "login"))}`;
}

/** The watch label a watch-issue question is about, or undefined for any other question. */
export function watchSubject(title: string): string | undefined {
	const m = SUBJECT.exec(title);
	return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Two titles of one watch's issue question: its reason (a count of failures) may differ, the watch is the same. */
export const sameWatchSubject = (a: string, b: string): boolean => {
	const subject = watchSubject(a);
	return subject !== undefined && subject === watchSubject(b);
};

/** The options of a watch-issue question, with the reconnect button marked so its answer runs the re-check itself. */
export const watchOptions = (title: string, options: DecisionOpt[]): DecisionOpt[] =>
	watchSubject(title) === undefined ? options : options.map(o => (o.label === RECONNECT ? { ...o, action: RECONNECT_ACTION } : o));
