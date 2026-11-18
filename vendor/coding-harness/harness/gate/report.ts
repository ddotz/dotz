import { say } from "../notice.ts";
import type { Finding } from "./types.ts";

/** A writing system the gate tells languages apart by. */
export type Script = "hangul" | "kana" | "han" | "cyrillic" | "latin";

/** The language the gate names for each script in its refusals. */
export const LANGUAGE_NAMES: Record<Script, string> = { hangul: "Korean", kana: "Japanese", han: "Chinese", cyrillic: "Russian", latin: "English" };

/** The Korean names of the languages in {@link LANGUAGE_NAMES}, for notices the user reads in Korean. */
export const LANGUAGE_NAMES_KO: Record<Script, string> = { hangul: "한국어", kana: "일본어", han: "중국어", cyrillic: "러시아어", latin: "영어" };

const NON_LATIN_SHARE = 0.2;
const MIN_LATIN_PROMPT_LETTERS = 20;
const FENCED = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|$)|$)/g;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const PATH = /(?:~|\.{1,2})?[\w.~-]*\/[\w./~-]*/g;
const WORD = /\p{L}+/gu;
const SCRIPTS: readonly (readonly [Script, RegExp])[] = [
	["hangul", /\p{Script=Hangul}/u],
	["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
	["cyrillic", /\p{Script=Cyrillic}/u],
	["han", /\p{Script=Han}/u],
	["latin", /\p{Script=Latin}/u],
];
const NAMED: readonly (readonly [Script, RegExp])[] = [
	["hangul", /^(?:korean|한국어)$/i],
	["kana", /^(?:japanese|일본어)$/i],
	["han", /^(?:chinese|중국어)$/i],
	["cyrillic", /^(?:russian|러시아어)$/i],
	["latin", /^(?:english|영어)$/i],
];
const ASKS_FOR_TEXT = /\b(?:report|reports|reply|replies|answer|answers|respond|response|summary|summarize|summarise|explain|final)\b/i;
const NAMES_LANGUAGE = /\bin (korean|japanese|chinese|russian|english)\b(?=\s*(?:[.,;:!?)]|$|please\b))|\b(korean|japanese|chinese|russian|english),? please\b/i;
const ASKED_IN_KOREAN = /(한국어|일본어|중국어|러시아어|영어)로\s*(?:보고|답|대답|응답|정리|요약|알려)/;

const PROTOCOL_ANSWERS: ReadonlySet<string> = new Set(["ok", "-", "[later]"]);

const proseOf = (text: string): string => text.replace(FENCED, " ").replace(INLINE_CODE, " ").replace(URL, " ").replace(PATH, " ");
const scriptOfChar = (char: string): Script | undefined => SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0];

/**
 * The script a reply is written in, ignoring fenced code, inline code, URLs and path-like tokens: words (letter runs) are counted
 * by the script of their first letter (hangul with the jamo, kana, cyrillic, han, latin), and the first non-latin script that has
 * at least 20% of the words wins, otherwise latin. Words, not letters, so English identifiers in Korean prose do not outweigh it.
 * Undefined when the text has no words of those scripts.
 */
export function scriptOf(text: string): Script | undefined {
	const counts = new Map<Script, number>();
	let total = 0;
	for (const [word] of proseOf(text).matchAll(WORD)) {
		const script = scriptOfChar(word);
		if (script === undefined) continue;
		counts.set(script, (counts.get(script) ?? 0) + 1);
		total += 1;
	}
	if (total === 0) return undefined;
	for (const [script] of SCRIPTS) if (script !== "latin" && (counts.get(script) ?? 0) >= total * NON_LATIN_SHARE) return script;
	return "latin";
}

/** The language a prompt explicitly asks the report or reply in ("Write the summary in Korean.", "영어로 보고해"), from its prose. */
export function askedScriptOf(text: string): Script | undefined {
	const prose = proseOf(text);
	const korean = ASKED_IN_KOREAN.exec(prose)?.[1];
	const english = prose
		.split(/[.!?\n]+/)
		.filter(sentence => ASKS_FOR_TEXT.test(sentence))
		.map(sentence => NAMES_LANGUAGE.exec(sentence))
		.find(match => match !== null);
	const name = english?.[1] ?? english?.[2] ?? korean;
	return name === undefined ? undefined : NAMED.find(([, pattern]) => pattern.test(name))?.[0];
}

/**
 * The script a user prompt shows the user writes in: a language the prompt asks the report or reply in decides it ("Final report
 * in Korean" in an English brief); otherwise any letter of a non-latin script outside code, URLs and paths decides it (a Korean
 * question over pasted English logs, a lone jamo); latin only with at least 20 latin letters, so a short "ok" leaves the
 * language as it was (undefined).
 */
export function promptScriptOf(text: string): Script | undefined {
	const asked = askedScriptOf(text);
	if (asked !== undefined) return asked;
	const prose = proseOf(text);
	let latin = 0;
	for (const char of prose) {
		const script = scriptOfChar(char);
		if (script === "latin") latin += 1;
		else if (script !== undefined) return script;
	}
	return latin >= MIN_LATIN_PROMPT_LETTERS ? "latin" : undefined;
}

/** Whether `reply` is exactly `ok`, `-` or `[later]` after trimming: the answers of the dotz protocol, which the reply stages never refuse. */
export function isProtocolAnswer(reply: string): boolean {
	return PROTOCOL_ANSWERS.has(reply.trim());
}

/**
 * What the `report` stage finds in a run's last reply, as at most one finding, only when `blocked` says nothing else refuses
 * this stop (a stop refused anyway keeps the one report refusal of the run for later, a wait for a running check included).
 * Class `language` when `reply` is written in another script than `user`, the script of the user's prompts, with a text naming
 * both languages. Class `after-refusal` when `waited` names the checks the last refusal only waited for and how they ended
 * (`"tests" passed`): the last message answered that wait, not the user, so the final report is asked for, in the user's
 * language when it is known, and both texts tell the agent what the check came to. A refusal for work asks for nothing here:
 * its text already says that the reply after the fix is the final report. Empty for a missing or blank reply and for a protocol answer.
 */
export function reportFindings(input: { reply: string | undefined; user: Script | undefined; blocked: boolean; waited?: string }): Finding[] {
	const { reply, user } = input;
	if (input.blocked || reply === undefined || reply.trim() === "" || isProtocolAnswer(reply)) return [];
	const waited = input.waited === undefined ? "" : ` The check this run waited for is in: ${input.waited}.`;
	const wrote = scriptOf(reply);
	if (user !== undefined && wrote !== undefined && wrote !== user) {
		const name = LANGUAGE_NAMES[user];
		return [
			{
				stage: "report",
				class: "language",
				message: `done-gate: the last reply is written in ${LANGUAGE_NAMES[wrote]}, but the user writes in ${name}. Write the final report again in ${name}; code, paths and commands stay as they are.${waited}`,
			},
		];
	}
	if (input.waited === undefined) return [];
	const name = user === undefined ? "the user's language" : LANGUAGE_NAMES[user];
	return [
		{
			stage: "report",
			class: "after-refusal",
			message: `done-gate: earlier stops of this run were refused, so your last message answers the gate, not the user. Write the final report now in ${name}: the outcome, the changed paths or commits, the verification you ran, and what the user must do. It replaces the earlier report as the last message.${waited}`,
		},
	];
}

/** What the user is told when a stop lets through a reply the `report` stage would refuse because the run already refused one: the class of the finding. */
export function reportWarning(findings: readonly Finding[]): string {
	const first = findings.at(0);
	const kind = first?.class ?? "unknown";
	return say({
		en: `done-gate: the last reply is not a final report for the user (report:${kind}); this run already refused a reply for it, so the stop is allowed.`,
		ko: `done-gate: 마지막 답변이 사용자에게 보여 줄 최종 보고가 아닙니다(report:${kind}). 이번 실행에서 이미 한 번 되돌렸으므로 종료를 허용합니다.`,
	});
}
