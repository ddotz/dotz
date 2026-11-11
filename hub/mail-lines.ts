// A mail's 할 일 and 직접 답할 것 lines: fields of their own on the record (hub/mail.ts), never a part of its summary. A poster that sends them as fields is
// taken as is. A poster that writes them into the summary as labelled lines ("할 일: ...", "질문: a / b") has them moved out on arrival, and a stored record
// is read the same way, so an old record needs no migration. Only those labels count: nothing is guessed from the wording of a summary.
export type MailLines = { todo?: string[]; questions?: string[] };
// Who wrote the mail a draft answers and what it wants: lines of their own above the quoted draft, so a draft is added to the mail's card and never stands in
// for it, on the web (hub/draft-approval.ts DraftApproval.brief) and on a messenger (the same lines as text). Read when the draft is done (hub/mail.ts mailDraftBrief).
export type DraftBrief = MailLines & { from?: string; summary?: string };

const LINE_MAX = 500;
const LINES_MAX = 10;
const TODO = /^(?:다음\s*)?할\s?일$/;
const QUESTION = /^(?:질문|직접 답할 것)$/;
const LABELLED = /^\s*(?:[-*•·]\s+)?(?:\*\*)?\s*([^*:：\n]{1,12}?)\s*(?:\*\*)?\s*[:：]\s*(.+?)\s*$/;
const NOTHING = /^없(?:음|습니다)/;

const tidy = (s: string): string => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
export const mailLineList = (lines: readonly string[]): string[] => lines.map(tidy).filter(Boolean).slice(0, LINES_MAX);

export function splitMailLines(summary: string | undefined): MailLines & { summary?: string } {
	const todo: string[] = [], questions: string[] = [], rest: string[] = [];
	for (const line of (summary ?? "").split("\n")) {
		const m = LABELLED.exec(line);
		const label = m?.[1]!, value = tidy(m?.[2] ?? "");
		if (m && TODO.test(label)) todo.push(value);
		else if (m && QUESTION.test(label)) questions.push(...(NOTHING.test(value) ? [] : value.split(/\s+\/\s+/)));
		else rest.push(line);
	}
	const left = rest.join("\n").trim();
	return { ...(left ? { summary: left } : {}), ...(todo.length ? { todo: mailLineList(todo) } : {}), ...(questions.length ? { questions: mailLineList(questions) } : {}) };
}

// `todo` / `questions` of a post: a string or a list of strings; a poster's own field wins over the labelled lines of its summary.
function lineField(v: unknown, name: string, bad: (message: string) => Error): string[] | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const list = Array.isArray(v) ? v : [v];
	if (list.some(l => typeof l !== "string")) throw bad(`${name} must be a string or a list of strings`);
	const lines = mailLineList(list as string[]);
	return lines.length ? lines : undefined;
}
export function parseMailLines(b: Record<string, unknown>, summary: string | undefined, bad: (message: string) => Error): MailLines & { summary: string | undefined } {
	const s = splitMailLines(summary);
	const todo = lineField(b.todo, "todo", bad) ?? s.todo, questions = lineField(b.questions, "questions", bad) ?? s.questions;
	return { summary: s.summary, ...(todo ? { todo } : {}), ...(questions ? { questions } : {}) };
}
// What a repeat post adds to a record that lacks them.
export const fillMailLines = (known: MailLines, m: MailLines): MailLines => ({ ...(m.todo && !known.todo ? { todo: m.todo } : {}), ...(m.questions && !known.questions ? { questions: m.questions } : {}) });

// The fields of a record, old or new: its own fields win over labelled lines of its summary, and the summary shown (one `shown` keeps) never carries those lines.
export function mailLinesOf(m: MailLines & { summary?: string }, shown: (summary: string | undefined) => unknown = () => true): MailLines & { summary?: string } {
	const s = splitMailLines(m.summary);
	const todo = m.todo?.length ? m.todo : s.todo, questions = m.questions?.length ? m.questions : s.questions;
	return { ...(s.summary && shown(s.summary) ? { summary: s.summary } : {}), ...(todo ? { todo } : {}), ...(questions ? { questions } : {}) };
}

// The same lines as a text form: the mail's first message on a messenger and the draft card above the quoted draft (hub/draft-approval.ts briefLines).
export const TODO_LABEL = "할 일";
export const QUESTIONS_LABEL = "직접 답할 것";
// What the reply rule reads (hub/mail-state.ts replyExpected), in the words a poster's summary has: its 할 일 decides, 없음 included.
export const mailCueText = (m: MailLines & { summary?: string }): string => [m.summary ?? "", ...(m.todo ?? []).map(t => `${TODO_LABEL}: ${t}`), ...(m.questions?.length ? [`질문: ${m.questions.join(" / ")}`] : [])].filter(Boolean).join("\n");
export const mailLineText = (m: MailLines): string[] => [...(m.todo ?? []).map(t => `${TODO_LABEL}: ${t}`), ...(m.questions?.length ? [`${QUESTIONS_LABEL}: ${m.questions.join(" / ")}`] : [])];
