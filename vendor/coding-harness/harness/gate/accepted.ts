import { join } from "node:path";
import { say } from "../notice.ts";
import type { RepoResult } from "./decision.ts";
import type { AcceptedComment } from "./escape.ts";

const MAX_LISTED = 10;

/** The accepted why comments of every repo of a stop, a file outside the working directory written with its repo path. */
export function acceptedOf(results: readonly RepoResult[], cwd: string): AcceptedComment[] {
	return results.flatMap(result => result.accepted.map(item => (result.repo === cwd ? item : { ...item, file: join(result.repo, item.file) })));
}

/** What the user is told, in the machine's notice language, about accepted why comments: at most ten as `file:line  text`, then how many more there are. */
export function acceptedNotice(accepted: readonly AcceptedComment[]): string {
	const rows = accepted.slice(0, MAX_LISTED).map(item => `  ${item.file}:${item.line}  ${item.text}`);
	const rest = accepted.length - MAX_LISTED;
	return [
		say({
			en: `done-gate: ${accepted.length} comment${accepted.length === 1 ? " was" : "s were"} accepted as constraints from outside the code (why(...)) and should be checked:`,
			ko: `done-gate: 코드 밖의 제약으로 받아들인 주석(why(...)) ${accepted.length}개를 확인해야 합니다:`,
		}),
		...rows,
		...(rest > 0 ? [say({ en: `  and ${rest} more`, ko: `  외 ${rest}개` })] : []),
	].join("\n");
}

const inRepo = (result: RepoResult, cwd: string, file: string): string => (result.repo === cwd ? file : join(result.repo, file));

/** What the stop could not judge, as one warning for the user in the machine's notice language: the rule occurrences in files the session did not change (at most ten) and the changed files the anti-escape stage could not read; undefined when there is none. */
export function unjudgedNotice(results: readonly RepoResult[], cwd: string): string | undefined {
	const occurrences = results.flatMap(result => result.preexisting.map(item => `  ${inRepo(result, cwd, item.file)}  ${item.rule} x${item.count}`));
	const unread = results.flatMap(result => result.unscanned.map(file => inRepo(result, cwd, file)));
	if (occurrences.length === 0 && unread.length === 0) return undefined;
	const more = (count: number): string[] => (count > MAX_LISTED ? [say({ en: `  and ${count - MAX_LISTED} more`, ko: `  외 ${count - MAX_LISTED}개` })] : []);
	return [
		say({ en: "done-gate: the stop is allowed, but this was not judged:", ko: "done-gate: 종료는 허용되지만 아래 항목은 판정하지 못했습니다:" }),
		...(occurrences.length ? [say({ en: "rule occurrences the session did not change (file, rule, count):", ko: "세션이 바꾸지 않은 규칙 위반(파일, 규칙, 개수):" }), ...occurrences.slice(0, MAX_LISTED), ...more(occurrences.length)] : []),
		...(unread.length
			? [say({ en: "changed files the anti-escape stage could not read (not UTF-8 or over 10 MiB), so their new lines are unchecked:", ko: "우회 방지 단계가 읽지 못한 변경 파일(UTF-8이 아니거나 10 MiB 초과)이라 새로 쓴 줄을 검사하지 못했습니다:" }), ...unread.slice(0, MAX_LISTED).map(file => `  ${file}`), ...more(unread.length)]
			: []),
	].join("\n");
}
