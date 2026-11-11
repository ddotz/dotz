// The deadline tick of the owner's ledger (hub/ledger.ts), no model call: every few minutes the open items are looked at once, and what is due is told in ONE
// message. The day before a due date it is told once from 18:00; its due morning is told by the doctor's morning pass (hub/doctor.ts); an item whose morning
// was missed (the gateway was down) is told once as late on the first tick after the morning time. Nothing is sent from 22:00 until the morning time.
// A mark is saved only after the send reports delivered, so a failed send tries again at the next tick and a restart never tells twice.
import { msg } from "./i18n.ts";
import { type Ledger, type LedgerItem, localDate } from "./ledger.ts";
import { MIN_EVERY_MINUTES } from "./schedule.ts";
import { trackTimer } from "./shutdown.ts";

const BEFORE_FROM = 18 * 60;
const QUIET_FROM = 22 * 60;
// The morning pass sends at the morning time itself; a tick right behind it must not tell the same items again before its marks are saved.
const MORNING_GRACE_MIN = 10;

export type Send = (text: string, project?: string) => Promise<{ delivered: boolean; reason?: string } | void> | { delivered: boolean; reason?: string } | void;
export type TickDeps = { store: Ledger; now: () => number; /** The morning time, "HH:MM". */ morning: () => string; send: Send; log: (line: string) => void };

const minutesOf = (ms: number): number => {
	const d = new Date(ms);
	return d.getHours() * 60 + d.getMinutes();
};
const morningMs = (now: number, hhmm: string): number => {
	const [h = 0, m = 0] = hhmm.split(":").map(Number);
	return new Date(now).setHours(h, m, 0, 0);
};

/**
 * What the tick at `now` tells: `before` = open items due tomorrow, from 18:00, not told before; `late` = open items due today or earlier whose morning pass
 * was missed (they existed at the morning time, and the grace after it is over) and were not told that morning. Both empty in the quiet hours.
 */
export function dueNotices(items: LedgerItem[], now: number, opts: { morning: string }): { before: LedgerItem[]; late: LedgerItem[] } {
	const t = minutesOf(now), at = morningMs(now, opts.morning);
	if (t >= QUIET_FROM || now < at) return { before: [], late: [] };
	const today = localDate(now), tomorrow = localDate(now, 1), open = items.filter(x => x.state === "open" && x.due);
	return {
		before: t >= BEFORE_FROM ? open.filter(x => x.due === tomorrow && !x.told?.before) : [],
		late: now >= at + MORNING_GRACE_MIN * 60_000 ? open.filter(x => x.due! <= today && !x.told?.morning && Date.parse(x.created) <= at) : [],
	};
}

const lines = (items: LedgerItem[]): string[] => items.map(x => msg().ledger.item(x.what, x.next));
/** The project the message goes to: the one all items belong to, else none (the main conversation). */
const projectOf = (items: LedgerItem[]): string | undefined => {
	const projects = new Set(items.map(x => x.source.project));
	return projects.size === 1 ? [...projects][0] : undefined;
};

/**
 * The ledger's part of the doctor's morning message: open items due today or earlier that the morning did not tell yet, and the approvals still waiting.
 * The commit marks the items; the caller runs it only after the message was delivered. Undefined when there is nothing to say.
 */
export function morningExtra(store: Ledger, waiting: () => number, now: number): { text: string; commit: () => void } | undefined {
	const today = localDate(now), open = store.list().filter(x => x.state === "open" && x.due && !x.told?.morning);
	const dueToday = open.filter(x => x.due === today), overdue = open.filter(x => x.due! < today), n = waiting();
	if (!dueToday.length && !overdue.length && !n) return undefined;
	return { text: msg().ledger.morning(lines(dueToday), lines(overdue), n), commit: () => store.mark([...dueToday, ...overdue].map(x => x.id), ["before", "morning"]) };
}

/** One tick: tells what is due in one message and marks it once the send reports delivered. */
export async function runTick(d: TickDeps): Promise<void> {
	const { before, late } = dueNotices(d.store.list(), d.now(), { morning: d.morning() });
	if (!before.length && !late.length) return;
	const t = msg().ledger, today = localDate(d.now());
	// A missed morning is told with the morning's own words: due today and past due are said apart.
	const missed = late.length ? t.morning(lines(late.filter(x => x.due === today)), lines(late.filter(x => x.due! < today)), 0) : "";
	const text = [before.length ? [t.tomorrow(before.length), ...lines(before)].join("\n") : "", missed].filter(Boolean).join("\n\n");
	const sent = await d.send(text, projectOf([...before, ...late]));
	if (sent && !sent.delivered) return d.log(`ledger: not delivered, tries again at the next tick (${sent.reason ?? "no reason given"})`);
	d.store.mark(before.map(x => x.id), ["before"]);
	d.store.mark(late.map(x => x.id), ["before", "morning"]);
	d.log(`ledger: told ${before.length} for tomorrow, ${late.length} late`);
}

/** Runs a tick now and then every MIN_EVERY_MINUTES minutes. */
export function startLedger(d: TickDeps): void {
	let running = false;
	const run = async () => {
		if (running) return;
		running = true;
		try {
			await runTick(d);
		} catch (e) {
			d.log(`ledger tick failed: ${e}`);
		} finally {
			running = false;
		}
	};
	const arm = () => trackTimer("ledger tick", setTimeout(() => void run().finally(arm), MIN_EVERY_MINUTES * 60_000));
	void run();
	arm();
}
