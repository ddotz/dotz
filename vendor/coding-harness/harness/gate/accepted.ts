import { join } from "node:path";
import type { RepoResult } from "./decision.ts";
import type { AcceptedComment } from "./escape.ts";

const MAX_LISTED = 10;

/** The accepted why comments of every repo of a stop, a file outside the working directory written with its repo path. */
export function acceptedOf(results: readonly RepoResult[], cwd: string): AcceptedComment[] {
	return results.flatMap(result => result.accepted.map(item => (result.repo === cwd ? item : { ...item, file: join(result.repo, item.file) })));
}

/** What the user is told about accepted why comments: at most ten as `file:line  text`, then how many more there are. */
export function acceptedNotice(accepted: readonly AcceptedComment[]): string {
	const rows = accepted.slice(0, MAX_LISTED).map(item => `  ${item.file}:${item.line}  ${item.text}`);
	const rest = accepted.length - MAX_LISTED;
	return [
		`done-gate: ${accepted.length} comment${accepted.length === 1 ? " was" : "s were"} accepted as constraints from outside the code (why(...)) and should be checked:`,
		...rows,
		...(rest > 0 ? [`  and ${rest} more`] : []),
	].join("\n");
}

const inRepo = (result: RepoResult, cwd: string, file: string): string => (result.repo === cwd ? file : join(result.repo, file));

/** What the stop could not judge, as one warning for the user: the rule occurrences in files the session did not change (at most ten) and the changed files the anti-escape stage could not read; undefined when there is none. */
export function unjudgedNotice(results: readonly RepoResult[], cwd: string): string | undefined {
	const occurrences = results.flatMap(result => result.preexisting.map(item => `  ${inRepo(result, cwd, item.file)}  ${item.rule} x${item.count}`));
	const unread = results.flatMap(result => result.unscanned.map(file => inRepo(result, cwd, file)));
	if (occurrences.length === 0 && unread.length === 0) return undefined;
	return [
		"done-gate: the stop is allowed, but this was not judged:",
		...(occurrences.length ? ["rule occurrences the session did not change (file, rule, count):", ...occurrences.slice(0, MAX_LISTED), ...(occurrences.length > MAX_LISTED ? [`  and ${occurrences.length - MAX_LISTED} more`] : [])] : []),
		...(unread.length ? ["changed files the anti-escape stage could not read (not UTF-8 or over 10 MiB), so their new lines are unchecked:", ...unread.slice(0, MAX_LISTED).map(file => `  ${file}`), ...(unread.length > MAX_LISTED ? [`  and ${unread.length - MAX_LISTED} more`] : [])] : []),
	].join("\n");
}
