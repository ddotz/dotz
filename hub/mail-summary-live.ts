// The hub's own mail summaries, wired to the real parts (hub/mail-summary.ts holds the logic): the model is hub/outlang.ts callModel at Sonnet 5.5 high
// (owner rule, never Haiku), the records are hub/mail.ts, and a finished summary reaches the open screens as a mail_unreplied broadcast (they reload the list).
import { log } from "./config.ts";
import { broadcast, historyEvents } from "./events.ts";
import { mailByKey, mailRecords, mailTarget, setMailSummary, storedBodyText, type MailRecord } from "./mail.ts";
import { createMailSummarizer } from "./mail-summary.ts";
import { callModel } from "./outlang.ts";

export const SUMMARY_MODEL = "anthropic/claude-sonnet-5-5:high";
const ORIGINAL = /(?:^|\n)원문[ \t]*\n([\s\S]+)$/;

/** The 원문 an earlier post left in the inbox log: the mail's newest event that carries one. */
const loggedBody = (key: string): string | undefined => {
	for (const e of historyEvents(mailTarget(key), 20).reverse()) {
		const m = ORIGINAL.exec(String(e.text ?? ""));
		if (m?.[1]?.trim()) return m[1];
	}
	return undefined;
};
const bodyOf = (r: MailRecord): string | undefined => storedBodyText(r.key) ?? loggedBody(r.key);

export const mailSummarizer = createMailSummarizer({
	model: async (system, text) => (await callModel(system, text, { model: SUMMARY_MODEL, timeoutMs: 120_000 })).text,
	get: mailByKey,
	store: setMailSummary,
	changed: key => broadcast({ kind: "mail_unreplied", target: mailTarget(key) }),
	bodyOf,
	log,
});

/** At start: the newest 30 mails with a placeholder or empty summary and a body to read get one (gateway start-up, once). */
export function backfillMailSummaries(): void {
	const n = mailSummarizer.backfill(mailRecords(), 30);
	if (n) log(`mail: ${n} mails queued for a hub summary`);
}
