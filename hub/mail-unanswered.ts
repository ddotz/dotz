// 답 없는 메일 다시 묻기: a sent mail that asks for an answer and got none after the days set on its mail app (app setting unanswered_days, off by
// default) gets one follow-up draft from the reply-draft engine, on the usual send-approval card. Nothing is sent here; the owner's 1) 보내기 does that.
//
// Watch style: the check is plain script on the gateway's sweep timer, reads the stored mails and costs no model call until a mail is due. With the
// setting off everywhere it writes nothing. The state file holds, per mail app, when the watch began (older mail is never tracked) and, per mail, how
// far it got. A mail gets one try only: a reply, a dropped card or the card itself ends it, and a later mail of the same conversation is not tracked.
// Everything outside (the stores, zele, the draft engine) is injected, as in hub/mail-reconcile.ts.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeAtomic } from "./config.ts";
import type { MailRecord } from "./mail.ts";
import { addressKey, isOwnAddress, ownAddressesFor, recipientKeys, sentExpectsReply, subjectKey } from "./mail-state.ts";
import { parseThread, type ThreadMessage } from "./zele.ts";

const DAY_MS = 86_400_000;
// An ended mail whose record is gone is forgotten after this long; one still stored never is, or it would be tracked again.
const KEEP_MS = 90 * DAY_MS;
const DUE_PER_RUN = 5, TRIES = 3;

export type UnansweredSettings = { instances: readonly string[]; of: (key: string) => { instance: string; days: number } };
export type UnansweredMail = Pick<MailRecord, "key" | "source" | "id" | "subject" | "from" | "at"> & Partial<Pick<MailRecord, "account" | "dir" | "to" | "cc" | "html" | "preview" | "list" | "thread" | "summary">>;
export type UnansweredDraft = { account?: string; key: string; instruction: string; headline: string; target: string; thread?: string; source: string; id: string; subject: string; from: string; to?: string; summary?: string; body?: string };
export type UnansweredDeps = {
	/** Undefined while no mail app has the setting on (hub/app-settings.ts unansweredSettings). */
	settings: () => UnansweredSettings | undefined;
	mails: () => readonly UnansweredMail[];
	/** The kept text of a stored mail (hub/mail.ts storedBodyText). */
	body: (key: string) => string | undefined;
	accounts: () => Promise<string[]>;
	/** `zele mail read`, read-only: an answer dotz was never told about still ends the watch. */
	read: (threadId: string, account: string) => Promise<string>;
	own: (accounts: readonly string[]) => ReadonlySet<string>;
	/** The newest reply draft of the mail that still waits (pending or held), if any. */
	openDraft: (key: string) => string | undefined;
	/** Closes that one draft as answered: an answer that arrives may have a reply draft of its own under the same mail key. */
	closeDraft: (id: string) => void;
	/** Takes the 답장 초안 chip off the sent mail's row. */
	clearChip: (key: string) => void;
	requestDraft: (m: UnansweredDraft) => Promise<string>;
	target: (key: string) => string;
	log: (line: string) => void;
	now?: () => number;
};

type Watched = { instance: string; at: string; subject: string; to: string[]; state: "waiting" | "card" | "done" | "none"; tries?: number; draft?: string; looked?: number };
type State = { since: Record<string, string>; watched: Record<string, Watched> };

function loadState(file: string): State {
	try {
		const v = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
		return { since: v.since ?? {}, watched: v.watched ?? {} };
	} catch {
		// No file yet, or a damaged one: the watch begins again from now, so nothing older is ever carded.
		return { since: {}, watched: {} };
	}
}

// dotz's own record of what it sent (`sent-<draft>`, `compose-<ref>`) has no id the mailbox can reply to; that mail is watched under the id its sent folder reports.
const hasMailboxId = (m: UnansweredMail) => !/^(?:sent|compose)-/.test(m.id);
const open = (w: Watched) => w.state === "waiting" || w.state === "card";
// At most DUE_PER_RUN threads per round; the one read longest ago goes first, so a thread that cannot be read never holds the others back.
const nextUp = <T extends { w: Watched }>(list: T[]): T[] => list.sort((a, b) => (a.w.looked ?? 0) - (b.w.looked ?? 0) || a.w.at.localeCompare(b.w.at)).slice(0, DUE_PER_RUN);

function answered(key: string, w: Watched, mails: readonly UnansweredMail[], rec: UnansweredMail): boolean {
	if (rec.dir !== "out") return true;
	return mails.some(r => r.key !== key && r.dir !== "out" && r.at > w.at && subjectKey(r.subject) === w.subject && w.to.includes(addressKey(r.from)));
}

async function readThread(r: UnansweredMail, d: UnansweredDeps): Promise<{ messages: ThreadMessage[]; own: ReadonlySet<string> } | undefined> {
	try {
		const accounts = await d.accounts();
		const account = r.account?.trim() || (accounts.length === 1 ? accounts[0] : undefined);
		const own = d.own(accounts);
		if (!account || !own.size) return undefined;
		return { messages: parseThread(await d.read(r.id, account)), own };
	} catch (error) {
		d.log(`mail unanswered: thread of ${r.key} not read: ${(error as Error).message}`);
		return undefined;
	}
}

async function track(s: State, on: UnansweredSettings, d: UnansweredDeps, mails: readonly UnansweredMail[], now: number): Promise<void> {
	let reads = 0;
	for (const r of mails) {
		if (r.dir !== "out" || s.watched[r.key] || !hasMailboxId(r)) continue;
		const { instance, days } = on.of(r.key);
		const since = s.since[instance];
		if (!days || !since || r.at < since) continue;
		const own = ownAddressesFor(r.source);
		const to = recipientKeys(r.to).filter(a => !own.has(a) && a !== addressKey(r.account));
		const subject = subjectKey(r.subject);
		const entry = { instance, at: r.at, subject, to };
		const taken = Object.values(s.watched).some(w => w.state !== "none" && w.subject === subject && w.to.some(a => to.includes(a)));
		if (!to.length || taken) {
			s.watched[r.key] = { ...entry, state: "none" };
			continue;
		}
		// A sent-folder poll reports only a snippet, so the mailbox is read once for the body. A mail nobody can read for it is judged on what is known, and settled after a day.
		let body = d.body(r.key);
		let settled = body !== undefined;
		if (!settled && r.source === "zele" && reads < DUE_PER_RUN) {
			reads++;
			const thread = await readThread(r, d);
			if (thread) {
				body = thread.messages.findLast(m => isOwnAddress(m.from, thread.own))?.body;
				settled = true;
			}
		}
		const text = [body, r.summary, r.preview].filter(Boolean).join("\n");
		if (sentExpectsReply({ subject: r.subject, text, ...(r.list ? { list: r.list } : {}) })) s.watched[r.key] = { ...entry, state: "waiting" };
		else if (settled || now - Date.parse(r.at) > DAY_MS) s.watched[r.key] = { ...entry, state: "none" };
	}
}

// What the real thread says: true = its newest message is someone else's, false = it is his, undefined = not known this round (the mail waits).
async function threadAnswered(r: UnansweredMail, d: UnansweredDeps): Promise<boolean | undefined> {
	if (r.source !== "zele") return false;
	const thread = await readThread(r, d);
	const last = thread?.messages.at(-1);
	return last ? !isOwnAddress(last.from, thread!.own) : undefined;
}

const askFor = (r: UnansweredMail, w: Watched, days: number, d: UnansweredDeps): UnansweredDraft => ({
	...(r.account ? { account: r.account } : {}),
	key: r.key,
	instruction: `The text above is NOT a mail received: it is the mail the user sent ${w.to[0]} ${days} days ago, still unanswered. Write one short, polite follow-up to ${w.to[0]} in the same language: restate what was asked in a sentence or two, never blame or press, and add no new fact. Keep the subject.`,
	headline: `${days}일째 답이 없어 다시 묻는 초안을 만들었어요`,
	target: d.target(r.key),
	...(r.thread ? { thread: r.thread } : {}),
	source: r.source,
	id: r.id,
	subject: r.subject,
	from: w.to[0]!,
	...(r.from ? { to: r.from } : {}),
	...(r.summary ? { summary: r.summary } : {}),
	...(d.body(r.key) ?? r.preview ? { body: d.body(r.key) ?? r.preview } : {}),
});

async function round(d: UnansweredDeps, file: string, now: number): Promise<void> {
	const on = d.settings();
	if (!on) {
		if (existsSync(file)) rmSync(file, { force: true });
		return;
	}
	const s = loadState(file);
	const before = JSON.stringify(s);
	const save = () => writeAtomic(file, `${JSON.stringify(s, null, 2)}\n`);
	for (const inst of Object.keys(s.since)) if (!on.instances.includes(inst)) delete s.since[inst];
	for (const inst of on.instances) s.since[inst] ??= new Date(now).toISOString();
	const mails = d.mails();
	const byKey = new Map(mails.map(r => [r.key, r]));
	for (const [key, w] of Object.entries(s.watched)) if (!s.since[w.instance] || (!open(w) && !byKey.has(key) && now - Date.parse(w.at) > KEEP_MS)) delete s.watched[key];

	await track(s, on, d, mails, now);
	const due: { r: UnansweredMail; w: Watched; days: number }[] = [];
	const cards: { r: UnansweredMail; w: Watched; card: string }[] = [];
	const close = (key: string, w: Watched, card: string) => {
		d.closeDraft(card);
		d.clearChip(key);
		w.state = "done";
	};
	for (const [key, w] of Object.entries(s.watched)) {
		if (!open(w)) continue;
		const r = byKey.get(key);
		if (!r) w.state = "done";
		else if (w.state === "card") {
			const card = w.draft && d.openDraft(key) === w.draft ? w.draft : undefined;
			if (!card) w.state = "done";
			else if (answered(key, w, mails, r)) close(key, w, card);
			else cards.push({ r, w, card });
		} else if (answered(key, w, mails, r)) w.state = "done";
		else {
			const days = on.of(key).days;
			if (days && now - Date.parse(w.at) >= days * DAY_MS) due.push({ r, w, days });
		}
	}
	for (const { r, w, card } of nextUp(cards)) {
		w.looked = now;
		if (await threadAnswered(r, d)) close(r.key, w, card);
	}
	if (JSON.stringify(s) !== before) save();

	for (const { r, w, days } of nextUp(due)) {
		const replied = await threadAnswered(r, d);
		if (replied === undefined) {
			w.looked = now;
			save();
			continue;
		}
		// Written before the draft is asked for: a gateway that dies in between never makes a second one.
		w.state = replied ? "done" : "card";
		save();
		if (replied) continue;
		const result = await d.requestDraft(askFor(r, w, days, d)).catch(e => (d.log(`mail unanswered: draft of ${r.key} failed: ${(e as Error).message}`), "failed"));
		if (result === "offered") {
			const draft = d.openDraft(r.key);
			if (draft) w.draft = draft;
			save();
			continue;
		}
		const tries = (w.tries ?? 0) + 1;
		w.tries = tries;
		w.state = result === "failed" && tries < TRIES ? "waiting" : "done";
		save();
	}
}

/** One round per `everyMs` on the sweep timer; a round that waits on a draft never holds the sweep up, and never runs twice at once. */
export function createUnansweredWatch(deps: UnansweredDeps, opts: { file: string; everyMs: number }) {
	const now = deps.now ?? Date.now;
	let last = Number.NEGATIVE_INFINITY;
	let busy: Promise<void> | undefined;
	return {
		tick(): Promise<void> | undefined {
			const at = now();
			if (busy || at - last < opts.everyMs) return busy;
			last = at;
			return (busy = round(deps, opts.file, at).finally(() => void (busy = undefined)));
		},
	};
}
