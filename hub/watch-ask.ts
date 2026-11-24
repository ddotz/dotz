import { fitSubject } from "./card-text.ts";
import { cardBlock, INERT } from "./choices.ts";
import { SLOT_SKIPPED_EXIT } from "./release-exit.ts";
import type { DecisionOpt } from "./notices-types.ts";
import type { NotifyInfo } from "./watch-heal.ts";
import { type WatchStatusLike, watchConnection } from "./watch-status.ts";
import { clockKo, loginLost, watchIssueLine, watchReasonKo } from "./watchtext.ts";

/** The label of the button that runs the existing relogin / re-check path; its card answers it without a model turn (hub/routes.ts deliverAnswer). */
export const RECONNECT = "다시 연결";
/** The action the reconnect option carries (DecisionOpt.action). */
export const RECONNECT_ACTION = "watch-reconnect";
const RECONNECT_QUESTION = "다시 연결할까요?";
const CHECK_QUESTION = "원인을 확인할까요?";
const RESUME = "다시 켜 달라고 하면 바로 다시 돌아요.";
const CHECK = "원인 확인";
const CHECK_RESULT = "마지막 출력을 보고 원인과 고칠 방법을 알려드려요.";
const STILL_RUNS = " 모니터링은 그대로 돌아요.";
const STOP_CHECKING = { name: "모니터링 끄기", result: `이 모니터링을 꺼요. ${RESUME}` };
const RECONNECT_OPT = { name: RECONNECT, result: "지금 다시 로그인해서 확인하고 결과를 알려드려요." };
const STOP_WATCHING = { name: "이 모니터링 멈추기", result: `고칠 때까지 이 모니터링을 멈춰요. ${RESUME}` };
const ISSUE_MAX = 1500;
const TAIL = "(?:원인을 확인할까요, 이 모니터링을 꺼 둘까요|다시 연결할까요, 이 모니터링을 멈출까요)";
const NAMED_TAIL = "(?:원인을 확인할까요, (.+?) 모니터링을 꺼 둘까요|다시 연결할까요, (.+?) 모니터링을 멈출까요)";
const SUBJECT = new RegExp(`^(?:(.+?): .*\\. ${TAIL}|${NAMED_TAIL})\\?$|^(.+) · (?:${[RECONNECT_QUESTION, CHECK_QUESTION].map(q => q.replace("?", "\\?")).join("|")})$`);

/** What a watch issue's card shows under its title: how many runs failed and since when (for a skipped release slot: when it was skipped). */
export type WatchFacts = { fails?: number; failSince?: number };

/** The id of a watch's issue card (`card_ids` of its post, Decision.card_id): the key of the doctor's finding about the same watch. */
export const watchCardId = (name: string): string => `watches:${name}`;

/** The card of a watch issue: `<label> · <question>` within 40 characters, the reason, the failure count and since when as its evidence (a label cut to
 *  fit the title is shown whole as the first line). A skipped release slot says which slot was skipped instead of since when it fails; only a watch that
 *  still runs says so on 원인 확인. A watch that lost its login gets 다시 연결 / 원인 확인 / 이 모니터링 멈추기; any other gets 원인 확인 / 모니터링 끄기. */
export function watchChoice(name: string, reason = "", login = false, facts: WatchFacts = {}): string {
	const question = login ? RECONNECT_QUESTION : CHECK_QUESTION;
	const subject = fitSubject(name, question);
	const skipped = reason.endsWith(`(exit ${SLOT_SKIPPED_EXIT})`) && facts.failSince !== undefined;
	const said = reason ? watchReasonKo(reason).split(". ")[0]! : "";
	const when = facts.failSince ? clockKo(new Date(facts.failSince).toISOString()) : "";
	const evidence = [
		subject === name ? "" : `모니터링: ${name}`,
		skipped ? `${when} 릴리스 시간대를 건너뛰었어요` : said,
		facts.fails && facts.fails > 1 && !said.includes("번 연속") ? `${facts.fails}번 연속 실패했어요` : "",
		when && !skipped ? `${when}부터 실패하고 있어요` : "",
	];
	const check = { name: CHECK, result: /^failed \d+ times in a row/.test(reason) ? `${CHECK_RESULT}${STILL_RUNS}` : CHECK_RESULT };
	return cardBlock({ subject, question, evidence, options: login ? [RECONNECT_OPT, check, STOP_WATCHING] : [check, STOP_CHECKING] });
}

/** The alert text of a watch issue: what happened, then the card. A watch that lost its login (hub/watch-status.ts) gets the reconnect choice. */
export function watchIssueText(w: WatchStatusLike, label: string, reason: string, info: NotifyInfo | undefined, output: string): string {
	const line = watchIssueLine(label, reason, info, output);
	const down = watchConnection(w);
	return `${line.slice(0, ISSUE_MAX)}\n${watchChoice(label, reason, loginLost(line) || (down.state === "disconnected" && down.reason === "login"), { fails: w.state.fails, failSince: w.state.failSince })}`;
}

/** The watch label a watch-issue question is about, or undefined for any other question. A label cut to fit the title ends with "…". */
export function watchSubject(title: string): string | undefined {
	const m = SUBJECT.exec(title.replaceAll(INERT, ""));
	return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : undefined;
}

/** Two titles of one watch's issue question: its reason (a count of failures) may differ, the watch is the same. */
export const sameWatchSubject = (a: string, b: string): boolean => {
	const subject = watchSubject(a);
	return subject !== undefined && subject === watchSubject(b);
};

/** The options of a watch-issue question, with the reconnect button marked so its answer runs the re-check itself. */
export const watchOptions = (title: string, options: DecisionOpt[]): DecisionOpt[] =>
	watchSubject(title) === undefined ? options : options.map(o => (o.label === RECONNECT ? { ...o, action: RECONNECT_ACTION } : o));
