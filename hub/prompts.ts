// The orchestrator's prompt queue. Every delivered prompt remembers where its answer goes; prompts are matched back by
// their text as omp starts them (FIFO, so identical texts still pair in order). Unanswered prompts are kept on disk
// (someone's `last_handled`: a message counts as handled when it is answered, not when it arrives), so a restart mid-turn
// replays them on boot.
//
// An owner message that arrives while the orchestrator is mid-turn is steered into that turn instead of waiting
// behind it (owner 2026-10-17: "순차적으로 처리하던데 ... 바로 답변이 안오는데"): the orchestrator answers it with dotz_send
// and carries on. If the turn ends before it was answered, it is delivered again as a normal prompt. A message that
// was answered with a reply_to (dotz_send or the turn's auto answer) is never delivered again, not at turn end and not
// by the restart replay.
//
// The answer goes out only when it is ready (owner 2026-10-20: "답변은 준비되고 해야해. 먼저하면 안됨"): a dotz_send to the
// channel the running turn answers, sent before that turn's final answer, is held (holdEarly) and posted together with
// the final answer, ahead of it. Only a full answer to a message steered in mid-turn goes out at once; progress is the one
// edited progress message (update_key), never a new text.
//
// An answer is never dropped for want of a pairing (owner 2026-10-20: three finished answers to web messages never arrived).
// OmO consumes a queued message inside the running agent run and starts runs of its own (a finished task worker wakes the
// session, also right after a gateway restart), so a user frame that matches no delivered prompt, or a run that started
// without one, is normal there: an unmatched user frame leaves the unanswered prompt in place, a prompt that finished is
// released when the orchestrator goes idle (a later run is a new one), and an answer with no prompt goes to the owner's
// newest message of the last 30 minutes (one still unanswered first), unless it repeats what was already sent there. With no
// such message it still reaches the owner: the conversation of his newest message of any age, else the main chat.
//
// A turn that hands code work to a background task worker ends with exactly `[later]` (MODE Routing; owner 2026-10-21:
// a long inline turn kept every next message waiting a median 238 s): its prompt stays open (deferred) with nothing sent,
// and the answer of the run the worker's result wakes (no prompt of ours) goes to the oldest open deferred prompt first.
//
// A worker is linked to its request when it is spawned (WorkLink, kept on disk next to pending.json): every worker a turn spawned
// gets its own receipt line, and the answer of the run its result woke goes to exactly that request, whatever order workers finish
// in. The guess in orphanTarget is only for an answer no link explains (2026-11-04: three requests open, the answers crossed).

export type Prompt = { key: string; text: string; at: number; target?: string; replyTo?: string; sent: { target: string; text: string }[]; done?: boolean; steered?: boolean; held?: string[]; last?: string; unmatched?: boolean; deferred?: boolean; cancelled?: boolean };
/** An owner message the gateway delivered (or, from the inbox log, delivered before this process started). */
export type OwnerMessage = { target: string; replyTo?: string; at: number; prompt?: Prompt };
export type Pending = { text: string; at?: number; target?: string; replyTo?: string; deferred?: boolean };
/** A worker and the request it was spawned for. `receipted`: its line was posted; `delivered`: an answer from its result went out. */
export type WorkLink = { id: string; target: string; replyTo?: string; at: number; description?: string; receipted?: boolean; delivered?: boolean; cancelled?: boolean };
/** A request waiting on background work, for the gateway's silent-wait check (hub/waitcheck.ts). */
export type OpenRequest = { target: string; replyTo?: string; at: number; workers: { id: string; description?: string }[] };
/** One of this session's background workers, as hub/bgwork.ts lists it (running oldest first, then recently finished newest first). */
export type WorkRow = { id: string; description?: string; status: "running" | "stalled" | "done" | "failed"; target?: string; replyTo?: string; startedAt: number; endedAt?: number };
export type Reply = { target: string; replyTo?: string; owner?: boolean };

export type PromptDeps = {
	/** Starts a normal orchestrator turn with this prompt. */
	deliver: (text: string, owner?: boolean) => void;
	/** Steers a note into the running turn; false when no turn was running to take it. */
	steer: (text: string) => boolean | void;
	/** Is the orchestrator mid-turn (so a new message is steered)? */
	working: () => boolean;
	/** The steered note for a new message. */
	note: (target: string, replyTo: string | undefined, text: string) => string;
	/** Is this prompt text a gateway note steered into a turn (not a new request)? */
	isNote: (text: string) => boolean;
	/** Posts a turn's final answer to the channel that asked. */
	post: (target: string, text: string, replyTo?: string) => Promise<{ delivered: boolean }>;
	/** A gateway note in a conversation that answers nothing (the deferral acknowledgement must not settle the open prompt). */
	announce?: (target: string, text: string, worker?: string) => void;
	/** The background worker now running for a conversation (the oldest one), when it is already listed. */
	workFor?: (target: string) => { id: string; description: string } | undefined;
	/** The gateway note (one line) that points a new owner message at the worker already running for its conversation. */
	joinNote?: (worker: { id: string; description: string }) => string;
	/** Does this text already carry that note (a restart replay stored it with the prompt)? */
	hasJoinNote?: (text: string) => boolean;
	/** This session's background workers; read only at delivery and at turn end (bgwork.ts caches the store). */
	work?: () => WorkRow[];
	/** The note that keeps another conversation's running worker answer out of this prompt's conversation. */
	foreignNote?: (worker: WorkRow, target: string) => string;
	/** Does this text already carry that note (a restart replay stored it with the prompt)? */
	hasForeignNote?: (text: string) => boolean;
	/** The note that asks a conversation again because its worker's result was read in a turn for another conversation. */
	readElsewhereNote?: (worker: WorkRow, readIn: string) => string;
	/** The note naming the send-approval cards that wait in this conversation (hub/approval-queue.ts pendingCardsNote), if any. */
	cardsNote?: (target: string) => string | undefined;
	/** Does this text already carry that note (a restart replay stored it with the prompt)? */
	hasCardsNote?: (text: string) => boolean;
	clearProgress: (target: string) => void;
	/** Writes the open prompts to disk. */
	persist: (open: Pending[]) => void;
	/** The worker links read from disk at start, and how they are written back (only when one changes). */
	links?: WorkLink[];
	persistLinks?: (links: WorkLink[]) => void;
	/** A finished worker's real report when OmO's delivered result is only its trailing housekeeping line (bgwork.ts reportOf). */
	report?: (id: string) => string | undefined;
	log: (message: string) => void;
	/** reply_to ids of messages answered before this process started (the outbox tail). */
	answered?: Iterable<string>;
	/** An answer to this message is on its way (sendlog.ts) and counts as answered. */
	pending?: (replyTo: string) => boolean;
	/** Owner messages from before this process started (the inbox tail), for an answer that has no prompt. */
	recent?: () => OwnerMessage[];
	/** Did the orchestrator answer in `target` after `at`? Settles stored prompts that carry no message id (written before web messages had one). */
	answeredSince?: (target: string, at: number) => boolean;
	/** Does a final answer to `target` also cover the messages steered into its turn (the web has no per-message answers)? */
	covers?: (target: string) => boolean;
};

// Near-identical answers: the first NEAR_CHARS letters and digits (lowercased, no spaces or punctuation) match, at least NEAR_MIN long.
const NEAR_CHARS = 40;
const NEAR_MIN = 20;
const head = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, NEAR_CHARS);
// "chat" and "web" are both the owner's main conversation on the web page (hub/events.ts eventTarget).
const isMain = (t: string) => t === "chat" || t === "web";
const sameConv = (a: string, b: string) => a === b || (isMain(a) && isMain(b));
const MAX_PROMPTS = 200;
const MAX_ANSWERED = 5000;
const REPLAY_MAX_AGE_MS = 12 * 3600_000;
// How old an owner message may be to receive an answer that has no prompt of its own.
const ORPHAN_MAX_AGE_MS = 30 * 60_000;
const MAX_RECENT = 20;
// The marker a turn ends with when a background worker will produce its answer, and how long such a prompt stays open.
const LATER = "[later]";
const DEFER_MAX_AGE_MS = 3 * 3600_000;
// A restart waits for a deferred prompt this young (its worker dies with the orchestrator process); older ones do not block.
const DEFER_BLOCKS_RESTART_MS = 60 * 60_000;
// Turns kept for tying a background worker to the turn that spawned it, and the clock rounding allowed after a turn's end.
const MAX_TURNS = 200;
const TURN_SLACK_MS = 1000;

const CANCEL_NOTE_MS = 10 * 60_000;
// Links are kept a day (a request stays open at most DEFER_MAX_AGE_MS, a restart replay reads them up to REPLAY_MAX_AGE_MS).
const LINK_MAX_AGE_MS = 24 * 3600_000;
const MAX_LINKS = 300;
const REPORT_NOTE_CHARS = 3000;

export function createPrompts(deps: PromptDeps) {
	const prompts: Prompt[] = [];
	let current: Prompt | undefined;
	// Insertion order doubles as age: the oldest id goes first when the set is full.
	const answered = new Set<string>(deps.answered ?? []);
	// Owner messages and dotz_send texts of the last half hour: who an answer without a prompt goes to, and what it may not repeat.
	const owners: OwnerMessage[] = (deps.recent?.() ?? []).slice(-MAX_RECENT);
	const recentSent: { target: string; text: string; at: number }[] = [];
	// Prompts whose turn ended with LATER, oldest first, until a later run answers them.
	const deferred: Prompt[] = [];
	// Deferral receipts already announced, one per (conversation, worker id); the key with an empty id is the plain note sent while no
	// worker was listed. The plain one is dropped when a non-deferred answer goes out there, a worker receipt stays while its worker runs.
	const receipted = new Set<string>();
	const receiptKey = (target: string, id = "") => `${target}\u0000${id}`;
	// Workers whose result was read in another conversation's turn and whose request was asked again (once per worker).
	const askedBack = new Set<string>();
	// Worker id -> the request it was spawned for (bgwork.ts reads it too), and the workers whose results the session was just woken with, oldest first.
	const links = new Map((deps.links ?? []).map(l => [l.id, l]));
	const woke: { id: string; at: number }[] = [];
	const saveLinks = () => {
		for (const [id, l] of links) if (Date.now() - l.at > LINK_MAX_AGE_MS || links.size > MAX_LINKS) links.delete(id);
		deps.persistLinks?.([...links.values()]);
	};
	function link(id: string, to: { target: string; replyTo?: string }, description?: string): WorkLink {
		const known = links.get(id);
		if (known) return known;
		const l: WorkLink = { id, target: to.target, ...(to.replyTo ? { replyTo: to.replyTo } : {}), at: Date.now(), ...(description ? { description } : {}) };
		links.set(id, l);
		saveLinks();
		return l;
	}
	const linksOf = (p: { target?: string; replyTo?: string }) => [...links.values()].filter(l => l.target === p.target && l.replyTo === p.replyTo);
	// Every turn that ran (omp started it from a delivered prompt), oldest first: a worker belongs to the turn it was spawned in.
	const turns: { prompt: Prompt; start: number; end?: number }[] = [];
	const closeTurn = () => {
		const t = turns.at(-1);
		if (t && t.end === undefined) t.end = Date.now();
	};
	const openDeferred = () => deferred.filter(p => !p.done && !isAnswered(p.replyTo) && Date.now() - p.at <= DEFER_MAX_AGE_MS);

	/** A worker still running in another conversation whose request is still waiting: its answer may arrive while this turn runs. */
	function otherConversation(target: string): WorkRow | undefined {
		const waiting = new Set(openDeferred().map(p => p.target));
		return (deps.work?.() ?? []).find(w => (w.status === "running" || w.status === "stalled") && w.target !== undefined && waiting.has(w.target) && !sameConv(w.target, target));
	}

	const pending = ({ text, at, target, replyTo, deferred }: Prompt): Pending => ({ text, at, target, replyTo, ...(deferred ? { deferred } : {}) });
	const save = () => {
		const open = [...openDeferred().filter(p => p !== current), ...(current && !current.done ? [current] : []), ...prompts.filter(p => !p.cancelled)].filter(p => !isAnswered(p.replyTo)).map(pending);
		deps.persist(open);
	};
	const isAnswered = (replyTo?: string) => replyTo !== undefined && (answered.has(replyTo) || deps.pending?.(replyTo) === true);

	/** Records that the owner message `replyTo` got an answer. */
	function markAnswered(replyTo: string | undefined | null): void {
		if (!replyTo) return;
		answered.delete(replyTo);
		answered.add(replyTo);
		if (answered.size > MAX_ANSWERED) answered.delete(answered.values().next().value!);
		// pending.json drops it now, not at the next unrelated change: a restart right after the answer must not replay it.
		save();
	}

	/**
	 * Delivers one prompt; true when it was steered into the running turn. Only a message of the conversation that turn answers is
	 * steered in: another conversation's message waits as its own prompt, so one turn never mixes two conversations and its answer
	 * cannot land in the wrong one (2026-10-28 21:44 KST: a mail thread's question was steered into a KTX run and the KTX answer
	 * was posted in the mail thread).
	 */
	function deliver(text: string, reply?: Reply): boolean {
		const steered = Boolean(reply) && deps.working() && Boolean(current && !current.done && current.target && sameConv(current.target, reply!.target));
		// A new owner turn for a conversation whose background worker is still running starts with a note naming that worker, so the
		// orchestrator passes a follow-up to it (task_send) instead of spawning a second worker for the same job (owner 2026-10-30:
		// four follow-ups to one posting job). The Prompt keeps the text as delivered: onPrompt pairs by it and a replay re-sends it.
		const worker = !steered && reply?.owner ? deps.workFor?.(reply.target) : undefined;
		if (worker && deps.joinNote && !deps.hasJoinNote?.(text)) text = `${deps.joinNote(worker)}\n\n${text}`;
		// A worker of another conversation may report during this turn (OmO injects its completion into the running run): its answer
		// belongs to its own conversation, not to this prompt's (2026-10-31 06:36 UTC, A's answer was posted into B).
		const elsewhere = reply?.owner && deps.foreignNote && !deps.hasForeignNote?.(text) ? otherConversation(reply.target) : undefined;
		if (elsewhere?.target) text = `${text}\n\n${deps.foreignNote!(elsewhere, elsewhere.target)}`;
		const cards = reply?.owner && !deps.hasCardsNote?.(text) ? deps.cardsNote?.(reply.target) : undefined;
		if (cards) text = `${cards}\n\n${text}`;
		const prompt: Prompt = { key: text.slice(0, 300), text, at: Date.now(), target: reply?.target, replyTo: reply?.replyTo, sent: [], steered };
		prompts.push(prompt);
		if (prompts.length > MAX_PROMPTS) prompts.splice(0, prompts.length - MAX_PROMPTS);
		if (reply?.owner) {
			owners.push({ target: reply.target, replyTo: reply.replyTo, at: prompt.at, prompt });
			if (owners.length > MAX_RECENT) owners.splice(0, owners.length - MAX_RECENT);
		}
		save();
		if (!steered) {
			// A turn still owes an answer, yet the orchestrator does not look busy: logged to find why (10-20 17:19).
			if (reply && deps.working()) deps.log(`message for ${reply.target} waits as its own prompt: the running turn answers ${current && !current.done ? (current.target ?? "-") : "no request of ours"}`);
			deps.deliver(text, Boolean(reply?.owner));
			return false;
		}
		if (deps.steer(deps.note(reply!.target, reply!.replyTo, text)) !== false) return true;
		// The turn ended between the check and the steer: the message goes in as a normal prompt instead of waiting.
		prompts.at(-1)!.steered = false;
		deps.deliver(text, Boolean(reply?.owner));
		return false;
	}

	/**
	 * A dotz_send settles the steered prompt it answers: the one whose message id it replies to, or, when it names no
	 * message, the first steered prompt of that channel.
	 */
	function settleSteered(target: string, replyTo?: string): void {
		const i = prompts.findIndex(p => p.steered && p.target === target && (replyTo ? p.replyTo === replyTo : true));
		if (i < 0) return;
		prompts.splice(i, 1);
		save();
	}

	/** Records a dotz_send: the turn's current prompt has now sent this part, and a steered prompt it answers is settled. */
	function sent(target: string, text: string, replyTo?: string): void {
		current?.sent.push({ target, text: text.trim() });
		recentSent.push({ target, text: text.trim(), at: Date.now() });
		if (recentSent.length > MAX_RECENT) recentSent.shift();
		// A run with no prompt of ours (a worker's result woke it) answering with dotz_send settles the deferred prompt it
		// answers: the one with this reply_to, else the oldest one in that channel.
		const ref = replyTo ?? (current ? undefined : resultFor(target));
		if (!current || replyTo) {
			const d = openDeferred().find(p => p.target === target && (ref ? p.replyTo === ref : true));
			if (d) {
				d.done = true;
				save();
			}
			closeResults(ref ?? d?.replyTo);
		}
		markAnswered(ref);
		settleSteered(target, replyTo);
	}

	/**
	 * A dotz_send without update_key to the channel the current turn answers: true when it is held for the final answer.
	 * A reply to a message steered into this turn (by reply_to, or the channel's steered message when none is named) is
	 * that message's own answer and is not held.
	 */
	function holdEarly(target: string, text: string, replyTo?: string): boolean {
		const p = current;
		if (!p || p.done || p.target !== target || !text.trim()) return false;
		if (prompts.some(q => q.steered && q.target === target && (replyTo ? q.replyTo === replyTo : true))) return false;
		(p.held ??= []).push(text.trim());
		deps.log(`held an early send to ${target} until the turn's answer (${text.trim().length} chars)`);
		return true;
	}

	// What was steered into a cancelled request may still wait in the runtime's queue, and the runtime starts a turn with it after the
	// abort (2026-10-28 live check: the turn came back 1 s after 중단 and answered). onPrompt tells the caller to abort that turn too.
	let cancelledNotes: { text: string; at: number }[] = [];

	/**
	 * The owner's 중단 (the web stop button, /abort): the running turn's request ends here, unanswered on purpose. Its prompt, the
	 * messages steered into it and the requests of that conversation still waiting on background workers are closed, so the idle hook
	 * does not deliver them again, a restart does not replay them, and a late answer for them is dropped. Returns the conversation.
	 */
	function cancel(): string | undefined {
		const p = current;
		if (!p || p.done) return undefined;
		const target = p.target;
		Object.assign(p, { done: true, cancelled: true, last: undefined, held: undefined });
		for (const q of prompts.filter(q => q.steered && q.target === target)) {
			q.cancelled = true;
			prompts.splice(prompts.indexOf(q), 1);
			cancelledNotes.push({ text: q.text, at: Date.now() });
		}
		// Messages of that conversation sent while it worked wait in the runtime's queue as next prompts: each is stopped when it starts.
		for (const q of prompts.filter(q => !q.steered && q.target === target)) Object.assign(q, { cancelled: true, done: true });
		for (const d of openDeferred().filter(d => d.target === target)) Object.assign(d, { done: true, cancelled: true });
		for (const l of links.values()) if (l.target === target) l.cancelled = true;
		saveLinks();
		for (const o of owners.filter(o => o.target === target && o.prompt && !o.prompt.done)) Object.assign(o.prompt!, { done: true, cancelled: true });
		deps.log(`turn for ${target ?? "-"} cancelled by the owner`);
		save();
		return target;
	}

	/** The current turn's answer goes to `to` instead of `from` (work that moved into a lane's thread is answered there). */
	function retarget(from: string, to: string): void {
		if (current && !current.done && current.target === from) current.target = to;
	}

	/** The orchestrator is idle: steered prompts nobody answered go in again as normal prompts. */
	function redeliverSteered(): void {
		const open = prompts.filter(p => p.steered);
		let dropped = false;
		for (const p of open) {
			if (isAnswered(p.replyTo)) {
				prompts.splice(prompts.indexOf(p), 1);
				dropped = true;
				continue;
			}
			p.steered = false;
			deps.deliver(p.text, true);
		}
		if (dropped) save();
	}

	/** omp started a prompt: pair it with the delivered one it came from. Returns true when the turn that just started carries only messages of a request the owner cancelled: the caller aborts it. */
	function onPrompt(text: string): boolean {
		cancelledNotes = cancelledNotes.filter(n => Date.now() - n.at <= CANCEL_NOTE_MS);
		if (deps.isNote(text) && cancelledNotes.some(n => text.includes(n.text)) && (!current || current.done)) {
			cancelledNotes = cancelledNotes.filter(n => !text.includes(n.text));
			deps.log("a turn started with a message of a cancelled request; it is stopped");
			return true;
		}
		// Notes steered into a running turn are not new requests: the turn keeps answering the prompt it started with.
		if (deps.isNote(text)) return false;
		// The harness's own mid-turn injections (OmO: `<system-reminder>` when a detached cell finishes, `<omo-senpi-task>`)
		// are not prompts either; clearing `current` on them dropped the turn's final answer (owner 2026-10-20: "작업 끝나도
		// 보고 안하는거", the 17:18 web turn).
		if (text.trimStart().startsWith("<")) return false;
		for (const q of prompts.filter(q => q.cancelled && Date.now() - q.at > CANCEL_NOTE_MS)) prompts.splice(prompts.indexOf(q), 1);
		const i = prompts.findIndex(p => !p.steered && text.includes(p.key));
		if (i >= 0 && prompts[i]!.cancelled) {
			prompts.splice(i, 1);
			deps.log("a turn started with a message the owner cancelled; it is stopped");
			return true;
		}
		// omp runs prompts in the order they were delivered, so a prompt older than the one that just started was taken into a
		// turn already. A lane report (no target, no message id) has no answer that could settle it: it was consumed by that turn,
		// and kept it would be replayed after the next restart (2026-10-23, a morning [done] came back at 08:48).
		if (i > 0) {
			const used = prompts.slice(0, i).filter(p => !p.steered && !p.target && !p.replyTo);
			for (const p of used) prompts.splice(prompts.indexOf(p), 1);
			if (used.length) deps.log(`${used.length} earlier prompt(s) without a message were consumed by a turn and are not kept for a replay`);
		}
		if (i < 0 && current && !current.done) {
			// A user frame the gateway did not deliver (raw text admitted into the run, a runtime's own message): the turn is
			// still answering the prompt it started with, so its answer must not lose its prompt (2026-10-20 10:43Z, 10:52Z).
			if (!current.unmatched) deps.log(`a user prompt matched nothing delivered; the running turn keeps its prompt for ${current.target ?? "-"}: ${text.trim().slice(0, 80)}`);
			current.unmatched = true;
			return false;
		}
		closeTurn();
		current = i >= 0 ? prompts.splice(i, 1)[0] : undefined;
		if (current) {
			turns.push({ prompt: current, start: Date.now() });
			if (turns.length > MAX_TURNS) turns.shift();
		}
		// A prompt redelivered at idle waits in the runtime's queue and cannot be taken back; if a dotz_send answered its message
		// meanwhile (2026-10-22 00:32, web 3e7dd934), it still starts as a turn, but that turn's own answer would only repeat the first.
		if (current && isAnswered(current.replyTo)) {
			current.done = true;
			deps.log(`the prompt for ${current.target ?? "-"} was already answered by a dotz_send; this turn's answer is dropped`);
		}
		save();
		return false;
	}

	/** Any assistant text of the running turn: the safety net's answer when the turn ends without a stop. */
	function onText(text: string): void {
		if (current && !current.done && text.trim()) current.last = text;
	}

	/**
	 * The orchestrator went idle: a prompt the turn never answered (no stop with text: aborted, cut off, a lost pairing)
	 * gets the turn's last text, so an answer is never dropped without a trace (owner 2026-10-20: "작업 끝나도 보고 안하는거").
	 */
	function settleTurn(failed = false): void {
		const p = current;
		if (!p) return;
		// A turn stopped by a provider error before it wrote anything is not answered: its request stays open like a deferred one, so the
		// run that resumes after the pause answers it in its own conversation and a restart replays it (2026-10-28 13:25Z on the Mac mini:
		// the owner's message was closed as a turn that wrote no text while the account was rate-limited, and never answered).
		if (failed && !p.done && p.target && !p.deferred && !p.last && !p.cancelled) {
			p.deferred = true;
			deferred.push(p);
			deps.log(`turn for ${p.target} stopped on an error before answering; its request stays open for the retry`);
			closeTurn();
			current = undefined;
			save();
			return;
		}
		// The run is over: a run that starts next without a prompt of ours (OmO wakes the session when a task worker finishes,
		// also right after a restart) is a new one and must not be taken for a continuation of this prompt (2026-10-20 12:51Z).
		if (!p.done && p.target && !p.deferred) {
			deps.log(`turn ended without an answer to ${p.target}; ${p.last ? "sending its last text" : "it wrote no text"}`);
			if (p.last) onAnswer(p.last);
			else p.done = true;
		}
		closeTurn();
		current = undefined;
		askBack(p.target);
		save();
	}

	/**
	 * A turn for one conversation ended while a worker of another finished during it: OmO read that result here, but the request it
	 * answers still waits in its own conversation. Ask that one again with its own text, once per worker, and leave it open.
	 */
	function askBack(target: string | undefined): void {
		const work = deps.work?.();
		const note = deps.readElsewhereNote;
		if (!target || !note || !work?.length) return;
		const turn = turns.at(-1);
		const from = turn?.start ?? 0;
		const to = Date.now();
		for (const w of work) {
			if (w.status === "running" || w.status === "stalled" || w.endedAt === undefined || w.endedAt < from || w.endedAt > to) continue;
			if (!w.target || sameConv(w.target, target) || askedBack.has(w.id)) continue;
			const open = openDeferred().filter(p => p.target === w.target);
			const d = open.find(p => w.replyTo !== undefined && p.replyTo === w.replyTo) ?? open.at(-1);
			if (!d) continue;
			askedBack.add(w.id);
			if (askedBack.size > MAX_ANSWERED) askedBack.delete(askedBack.values().next().value!);
			deps.log(`the result of ${w.id} for ${w.target} was read in a turn for ${target}; ${w.target} is asked again`);
			deliver(`${note(w, target)}\n\n${d.text}`, { target: w.target, replyTo: d.replyTo });
		}
	}

	/**
	 * The owner message the turn running at `at` (ms) was answering: a new turn replaces it, a message steered into the turn
	 * or answered with a dotz_send reply_to does not move it. Undefined when no turn of ours was running then (a run a
	 * worker's result woke, or one before this process started).
	 */
	function turnAt(at: number): { target: string; replyTo?: string } | undefined {
		const t = turns.findLast(x => x.start <= at);
		if (!t || (t.end !== undefined && at > t.end + TURN_SLACK_MS) || !t.prompt.target) return undefined;
		return { target: t.prompt.target, ...(t.prompt.replyTo ? { replyTo: t.prompt.replyTo } : {}) };
	}

	/**
	 * Who an answer without a prompt goes to: a request waiting on a background worker first; else the owner's newest message of the
	 * last 30 minutes, one still unanswered first. When a turn ran in this process in the last 30 minutes, only that turn's conversation
	 * qualifies (the run is its continuation), and a message still waiting as its own prompt never does: its turn answers it
	 * (2026-10-28 21:44 KST, a KTX answer went to a mail thread's newer question).
	 */
	function orphanTarget(): OwnerMessage | undefined {
		const open = openDeferred();
		// The request whose worker finished last takes the answer, not the oldest one open (2026-10-31 06:36 UTC: B's finished worker's
		// result went to A's older request).
		const finished = (deps.work?.() ?? [])
			.filter(w => (w.status === "done" || w.status === "failed") && w.endedAt !== undefined && w.target)
			.sort((a, b) => b.endedAt! - a.endedAt!);
		for (const w of finished) {
			const d = open.find(p => w.target && p.target === w.target && (w.replyTo === undefined || p.replyTo === w.replyTo)) ?? open.find(p => p.target === w.target);
			if (d?.target) return { target: d.target, replyTo: d.replyTo, at: d.at, prompt: d };
		}
		const d = open[0];
		if (d?.target) return { target: d.target, replyTo: d.replyTo, at: d.at, prompt: d };
		const last = turns.at(-1);
		const conv = last?.prompt.target && Date.now() - (last.end ?? Date.now()) <= ORPHAN_MAX_AGE_MS ? last.prompt.target : undefined;
		const queuedNow = new Set(prompts.filter(p => !p.steered));
		const fresh = owners.filter(o => Date.now() - o.at <= ORPHAN_MAX_AGE_MS && !(o.prompt && queuedNow.has(o.prompt)) && (!conv || sameConv(o.target, conv))).sort((a, b) => a.at - b.at);
		return fresh.findLast(o => !(o.prompt?.done || isAnswered(o.replyTo))) ?? fresh.at(-1);
	}

	/** Where a real answer goes when orphanTarget finds no one: never dropped, and it settles nothing, so it answers no message by id (hub.log 2026-11-04T04:20:25Z, 823 chars lost). */
	function lastResortTarget(): OwnerMessage {
		const last = owners.toSorted((a, b) => a.at - b.at).at(-1);
		return { target: last?.target ?? "web", at: last?.at ?? Date.now() };
	}

	/** OmO said these workers finished, so a run is reading their results. A delivered result that is only a housekeeping line is followed by the real report. */
	function workersDone(ids: string[]): void {
		for (const id of ids) {
			woke.push({ id, at: Date.now() });
			const report = deps.report?.(id);
			// A leading `<` keeps this out of the prompt pairing (onPrompt), as OmO's own injected notes.
			if (report) deps.steer(`<dotz-worker-report task="${id}">\n${report.slice(0, REPORT_NOTE_CHARS)}\n</dotz-worker-report>`);
		}
	}

	/** Workers the runtime just spawned: the running turn's request is theirs; a run no prompt started serves the request of the worker that woke it. */
	function workersSpawned(workers: { id: string; description?: string }[]): void {
		if (current?.target) {
			for (const w of workers) link(w.id, { target: current.target, replyTo: current.replyTo }, w.description);
			return;
		}
		const woken = woke.map(w => links.get(w.id)).find(l => l !== undefined);
		const to = woken ?? openDeferred().at(-1);
		if (!to?.target) return;
		for (const w of workers) receipt(link(w.id, { target: to.target, replyTo: to.replyTo }, w.description));
	}

	const receiptedWorker = (l: WorkLink) => l.receipted === true || receipted.has(receiptKey(l.target, l.id));
	/** The one visible line of a worker (a gateway note: it settles no prompt). */
	function receipt(l: WorkLink): void {
		if (receiptedWorker(l)) return;
		const took = (l.description ?? deps.work?.().find(w => w.id === l.id)?.description)?.trim();
		receipted.add(receiptKey(l.target, l.id));
		if (receipted.size > MAX_ANSWERED) receipted.delete(receipted.values().next().value!);
		l.receipted = true;
		saveLinks();
		deps.log(`the answer to ${l.target} is deferred to worker ${l.id}`);
		deps.announce?.(l.target, took ? `백그라운드 작업으로 맡겼어요: ${took}` : "백그라운드 작업으로 맡겼어요", l.id);
	}

	/** The workers this turn spawned, by the runtime's own spawn event or by the task store's start time, without a line yet. */
	function newWorkers(p: Prompt): WorkLink[] {
		const turn = turns.at(-1);
		const from = (turn?.prompt === p ? turn.start : p.at) - TURN_SLACK_MS;
		for (const w of deps.work?.() ?? [])
			if ((w.status === "running" || w.status === "stalled") && w.startedAt >= from && (!w.target || sameConv(w.target, p.target!))) link(w.id, { target: p.target!, replyTo: p.replyTo }, w.description);
		return linksOf(p).filter(l => l.at >= from && !receiptedWorker(l));
	}

	const requestOpen = (l: WorkLink) => openDeferred().some(d => d.target === l.target && d.replyTo === l.replyTo);
	/** Whose result the next answer without a prompt carries: the worker that woke the run, else the oldest finished worker whose request still waits. */
	function nextResult(): WorkLink | undefined {
		const work = deps.work?.() ?? [];
		while (woke.length) {
			const w = woke.shift()!;
			const l = links.get(w.id);
			if (l && !l.delivered && Date.now() - w.at <= ORPHAN_MAX_AGE_MS) return l;
		}
		return work
			.filter(w => (w.status === "done" || w.status === "failed") && w.endedAt !== undefined)
			.sort((a, b) => a.endedAt! - b.endedAt!)
			.map(w => links.get(w.id))
			.find(l => l && !l.delivered && requestOpen(l));
	}
	/** The request a dotz_send to `target` from a run without a prompt answers: the one of the worker that woke the run. */
	function resultFor(target: string): string | undefined {
		for (const w of woke) {
			const l = links.get(w.id);
			if (l && !l.delivered && sameConv(l.target, target)) return l.replyTo;
		}
		return undefined;
	}
	/** The request was answered: the results that woke the session for it are spent. */
	function closeResults(replyTo: string | undefined): void {
		if (!replyTo) return;
		for (const w of woke.filter(w => links.get(w.id)?.replyTo === replyTo)) {
			woke.splice(woke.indexOf(w), 1);
			links.get(w.id)!.delivered = true;
			saveLinks();
		}
	}

	/** An answer that came without a prompt: to the request of the worker whose result it carries, else the 30-minute rule above, else lastResortTarget, never a repeat of what was already sent there. */
	function onOrphanAnswer(text: string): void {
		const t = text.trim();
		// Keepalive "ok" and "-" have no prompt by design.
		if (t.length <= 3) return;
		// Woken before the worker's result was in: the deferred prompt keeps waiting.
		if (t === LATER) return void deps.log(`a run without a prompt said ${LATER}; ${openDeferred().length} deferred prompt(s) keep waiting`);
		const result = nextResult();
		if (result) {
			result.delivered = true;
			saveLinks();
			deps.log(`the result of ${result.id} goes to its request ${result.replyTo ?? "(no id)"} in ${result.target}`);
		}
		const to = result ? { target: result.target, replyTo: result.replyTo, at: result.at, prompt: deferred.find(d => d.target === result.target && d.replyTo === result.replyTo) } : (orphanTarget() ?? lastResortTarget());
		if (to.prompt?.cancelled || result?.cancelled) return void deps.log(`an answer for a request the owner cancelled was dropped (${t.length} chars)`);
		if (recentSent.some(s => s.target === to.target && Date.now() - s.at <= ORPHAN_MAX_AGE_MS && s.text.includes(t))) return;
		deps.log(`an answer had no prompt; sent to the owner's newest message in ${to.target} (${t.length} chars): ${t.slice(0, 80)}`);
		recentSent.push({ target: to.target, text: t, at: Date.now() });
		// The message this answers is settled wherever it is still listed (the owner's list, a deferred wait, a steered note), so its
		// working / waiting state ends with the answer and a restart does not replay it.
		if (to.prompt) to.prompt.done = true;
		for (const d of deferred) if (d.target === to.target && d.replyTo !== undefined && d.replyTo === to.replyTo) d.done = true;
		if (to.replyTo) settleSteered(to.target, to.replyTo);
		save();
		void deps
			.post(to.target, t, to.replyTo)
			.then(r => {
				if (!r.delivered) return;
				markAnswered(to.replyTo);
				deps.clearProgress(to.target);
			})
			.catch(e => deps.log(`reply to ${to.target} failed: ${e}`));
	}

	/** The turn's final answer to `target` also answers what was steered into the turn there: those are not delivered again. */
	function coverSteered(target: string): void {
		for (const q of prompts.filter(x => x.steered && x.target === target)) {
			prompts.splice(prompts.indexOf(q), 1);
			markAnswered(q.replyTo);
		}
	}

	/** An assistant stop: the turn's final answer goes to the channel that asked, once. */
	function onAnswer(text: string): void {
		const p = current;
		// A turn omp continues (steered notes) stops again; the prompt it started with was answered at the first stop.
		if (!p) return onOrphanAnswer(text);
		if (p.done) return;
		const t = text.trim();
		if (t === LATER && p.target && !p.deferred) {
			// The answer itself waits for the worker, but the conversation must not look silent (owner 2026-10-27: "메일 내 대화에서
			// 다른 일 시키니까 일 안하네"): one short note names who took it. It is a gateway note, so it settles no prompt.
			// A turn the gateway woke for a request already waiting: that one entry keeps waiting.
			const twin = p.replyTo ? openDeferred().some(d => d.replyTo === p.replyTo) : false;
			if (twin) p.done = true;
			else {
				p.deferred = true;
				deferred.push(p);
			}
			// Every worker this turn spawned gets its own line, whoever else runs in the conversation (2026-11-04: st_01a1a45d and
			// st_01a1a465 were taken for the older st_01a1a45c, the first one the conversation listed, and got none).
			const fresh = newWorkers(p);
			for (const l of fresh) receipt(l);
			if (fresh.length || twin) return void save();
			const w = deps.workFor?.(p.target);
			const took = w?.description.trim();
			const note = took ? `백그라운드 작업으로 맡겼어요: ${took}` : "백그라운드 작업으로 맡겼어요";
			// One receipt per worker (owner 2026-10-30: the same "유튜브 답글 게시" note came 4x in 2 minutes): a later deferral in the
			// conversation while that worker still runs is silent.
			const rk = receiptKey(p.target, w?.id);
			if (receipted.has(rk)) deps.log(`the answer to ${p.target} is deferred again to ${w ? `worker ${w.id}` : "a background worker"}; receipt already sent`);
			else {
				receipted.add(rk);
				if (receipted.size > MAX_ANSWERED) receipted.delete(receipted.values().next().value!);
				deps.log(`the answer to ${p.target} is deferred to a background worker`);
				deps.announce?.(p.target, note, w?.id);
			}
			save();
			return;
		}
		if (t === LATER) return;
		p.done = true;
		if (p.target && t !== "-") receipted.delete(receiptKey(p.target));
		if (t !== "-") closeResults(p.replyTo);
		if (p.target && t !== "-" && deps.covers?.(p.target)) coverSteered(p.target);
		save();
		if (!p.target) return;
		const target = p.target;
		// Parts sent early with dotz_send do not replace the answer; skip it only when it repeats something already sent.
		const sentHere = p.sent.some(s => s.target === target);
		const held = p.held ?? [];
		// Also a repeat: the same first NEAR_CHARS normalized characters as something this turn already posted to that conversation
		// (a schedule text said "tell web" while its final answer goes to "chat", both the main web conversation).
		const key = head(t);
		const prior = [...p.sent.filter(s => sameConv(s.target, target)).map(s => s.text), ...held];
		const repeat = t === "-" || prior.some(h => h.includes(t) || (key.length >= NEAR_MIN && head(h) === key));
		if (repeat && !held.length) {
			if (sentHere) deps.clearProgress(target);
			return;
		}
		const body = [...held, ...(repeat ? [] : [t])].join("\n\n");
		p.sent.push({ target, text: body });
		void deps
			.post(target, body, p.replyTo)
			.then(r => {
				if (!r.delivered) return;
				markAnswered(p.replyTo);
				deps.clearProgress(target);
			})
			.catch(e => deps.log(`reply to ${target} failed: ${e}`));
	}

	/** Delivers prompts that were never answered (the gateway stopped mid-turn) again; returns how many were replayed. */
	function replay(unanswered: Pending[], wrap: (text: string) => string): number {
		// A stored prompt without a message id (web messages had none) counts as answered when an answer to its target came after it.
		const fresh = unanswered.filter(p => {
			if (!p.text || Date.now() - (p.at ?? 0) >= REPLAY_MAX_AGE_MS) return false;
			const done = isAnswered(p.replyTo) || Boolean(!p.replyTo && p.target && p.at && deps.answeredSince?.(p.target, p.at));
			if (done) deps.log(`not replaying ${p.target ?? "-"} ${p.replyTo ?? "(no id)"} after the restart: already answered`);
			return !done;
		});
		// A request waiting on a worker keeps waiting: its link says whose result answers it, and running the request again would repeat
		// that work. If that result never comes, the silent-wait check names the request (hub/waitcheck.ts).
		const failed = new Set((deps.work?.() ?? []).filter(w => w.status === "failed").map(w => w.id));
		const waits = (p: Pending) => p.deferred === true && linksOf(p).some(l => !l.delivered && !l.cancelled && !failed.has(l.id));
		const kept = fresh.filter(waits);
		const again = fresh.filter(p => !waits(p));
		for (const p of kept) deferred.push({ key: p.text.slice(0, 300), text: p.text, at: p.at ?? Date.now(), target: p.target, replyTo: p.replyTo, sent: [], deferred: true });
		if (kept.length) {
			deps.log(`${kept.length} request(s) keep waiting on their workers after the restart`);
			save();
		}
		if (again.length) deps.log(`replaying ${again.length} unanswered prompt(s) from before the restart`);
		for (const p of again) deliver(wrap(p.text), p.target ? { target: p.target, replyTo: p.replyTo } : undefined);
		return again.length;
	}

	/** After an orchestrator restart: every prompt still open (queued, in the lost turn, deferred) is delivered again once, oldest first. */
	function reopen(wrap: (text: string) => string): { replayed: number; texts: string[] } {
		const open = [...openDeferred(), ...(current && !current.done ? [current] : []), ...prompts]
			.filter((p, i, all) => all.indexOf(p) === i)
			.filter(p => {
				const done = isAnswered(p.replyTo);
				if (done) deps.log(`not replaying ${p.target ?? "-"} ${p.replyTo} after the restart: already answered`);
				return !done;
			})
			.sort((a, b) => a.at - b.at)
			.map(pending);
		prompts.length = 0;
		deferred.length = 0;
		closeTurn();
		current = undefined;
		return { replayed: replay(open, wrap), texts: open.map(p => p.text) };
	}

	/** Deferred prompts young enough that a restart should wait for their worker. */
	const waitingOnWorkers = () => openDeferred().filter(p => Date.now() - p.at <= DEFER_BLOCKS_RESTART_MS).length;

	/** The deferred prompts still waiting for their worker's answer (bgwork.ts ties a worker to one of them). */
	const deferredOpen = () => openDeferred().flatMap(p => (p.target ? [{ target: p.target, replyTo: p.replyTo, at: p.at }] : []));

	/** Requests waiting on background work, with the workers linked to them. */
	const openRequests = (): OpenRequest[] => openDeferred().flatMap(p => (p.target ? [{ target: p.target, ...(p.replyTo ? { replyTo: p.replyTo } : {}), at: p.at, workers: linksOf(p).map(({ id, description }) => ({ id, ...(description ? { description } : {}) })) }] : []));

	/** Messages of this conversation with a turn of their own still to come: an answer to another message there does not settle them. */
	const waitingIds = (target: string): string[] => [...openDeferred(), ...prompts.filter(p => !p.steered)].flatMap(p => (p.replyTo && p.target && sameConv(p.target, target) ? [p.replyTo] : []));

	return { deliver, settleSteered, sent, holdEarly, cancel, retarget, markAnswered, isAnswered, redeliverSteered, onPrompt, onText, settleTurn, onAnswer, replay, reopen, waitingOnWorkers, deferredOpen, turnAt, queued: () => prompts.slice(), current: () => current, linkOf: (id: string) => links.get(id), link, workersSpawned, workersDone, resultFor, openRequests, waitingIds };
}
