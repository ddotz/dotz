// The orchestrator's prompt queue. Every delivered prompt remembers where its answer goes; prompts are matched back by
// their text as omp starts them (FIFO, so identical texts still pair in order). Unanswered prompts are kept on disk
// (오모냥's `last_handled`: a message counts as handled when it is answered, not when it arrives), so a restart mid-turn
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
// newest message of the last 30 minutes (one still unanswered first), unless it repeats what was already sent there.
//
// A turn that hands code work to a background task worker ends with exactly `[later]` (MODE Routing; owner 2026-10-21:
// a long inline turn kept every next message waiting a median 238 s): its prompt stays open (deferred) with nothing sent,
// and the answer of the run the worker's result wakes (no prompt of ours) goes to the oldest open deferred prompt first.

export type Prompt = { key: string; text: string; at: number; target?: string; replyTo?: string; sent: { target: string; text: string }[]; done?: boolean; steered?: boolean; held?: string[]; last?: string; unmatched?: boolean; deferred?: boolean; cancelled?: boolean };
/** An owner message the gateway delivered (or, from the inbox log, delivered before this process started). */
export type OwnerMessage = { target: string; replyTo?: string; at: number; prompt?: Prompt };
export type Pending = { text: string; at?: number; target?: string; replyTo?: string };
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
	announce?: (target: string, text: string) => void;
	/** The description of the background worker now serving a message that was just deferred, when it is already listed. */
	workFor?: (target: string) => string | undefined;
	clearProgress: (target: string) => void;
	/** Writes the open prompts to disk. */
	persist: (open: Pending[]) => void;
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
	// Every turn that ran (omp started it from a delivered prompt), oldest first: a worker belongs to the turn it was spawned in.
	const turns: { prompt: Prompt; start: number; end?: number }[] = [];
	const closeTurn = () => {
		const t = turns.at(-1);
		if (t && t.end === undefined) t.end = Date.now();
	};
	const openDeferred = () => deferred.filter(p => !p.done && !isAnswered(p.replyTo) && Date.now() - p.at <= DEFER_MAX_AGE_MS);

	const save = () => {
		const open = [...openDeferred().filter(p => p !== current), ...(current && !current.done ? [current] : []), ...prompts.filter(p => !p.cancelled)].filter(p => !isAnswered(p.replyTo)).map(({ text, at, target, replyTo }) => ({ text, at, target, replyTo }));
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

	function deliver(text: string, reply?: Reply): void {
		const steered = Boolean(reply) && deps.working();
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
			if (reply && current && !current.done) deps.log(`message for ${reply.target} delivered as a new prompt while the turn for ${current.target ?? "-"} is unanswered`);
			return deps.deliver(text, Boolean(reply?.owner));
		}
		if (deps.steer(deps.note(reply!.target, reply!.replyTo, text)) !== false) return;
		// The turn ended between the check and the steer: the message goes in as a normal prompt instead of waiting.
		prompts.at(-1)!.steered = false;
		deps.deliver(text, Boolean(reply?.owner));
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
		if (!current || replyTo) {
			const d = openDeferred().find(p => p.target === target && (replyTo ? p.replyTo === replyTo : true));
			if (d) {
				d.done = true;
				save();
			}
		}
		markAnswered(replyTo);
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
	function settleTurn(): void {
		const p = current;
		if (!p) return;
		// The run is over: a run that starts next without a prompt of ours (OmO wakes the session when a task worker finishes,
		// also right after a restart) is a new one and must not be taken for a continuation of this prompt (2026-10-20 12:51Z).
		if (!p.done && p.target && !p.deferred) {
			deps.log(`turn ended without an answer to ${p.target}; ${p.last ? "sending its last text" : "it wrote no text"}`);
			if (p.last) onAnswer(p.last);
			else p.done = true;
		}
		closeTurn();
		current = undefined;
		save();
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

	/** Who an answer without a prompt goes to: the owner's newest message of the last 30 minutes, one still unanswered first. */
	function orphanTarget(): OwnerMessage | undefined {
		const d = openDeferred()[0];
		if (d?.target) return { target: d.target, replyTo: d.replyTo, at: d.at, prompt: d };
		const fresh = owners.filter(o => Date.now() - o.at <= ORPHAN_MAX_AGE_MS).sort((a, b) => a.at - b.at);
		return fresh.findLast(o => !(o.prompt?.done || isAnswered(o.replyTo))) ?? fresh.at(-1);
	}

	/** An answer that came without a prompt: the 30-minute rule above, never a repeat of what was already sent there. */
	function onOrphanAnswer(text: string): void {
		const t = text.trim();
		// Keepalive "ok" and "-" have no prompt by design.
		if (t.length <= 3) return;
		// Woken before the worker's result was in: the deferred prompt keeps waiting.
		if (t === LATER) return void deps.log(`a run without a prompt said ${LATER}; ${openDeferred().length} deferred prompt(s) keep waiting`);
		const to = orphanTarget();
		if (!to) return void deps.log(`an answer had no prompt to go to (${t.length} chars): ${t.slice(0, 80)}`);
		if (to.prompt?.cancelled) return void deps.log(`an answer for a request the owner cancelled was dropped (${t.length} chars)`);
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
			p.deferred = true;
			deferred.push(p);
			const took = deps.workFor?.(p.target)?.trim();
			const note = took ? `백그라운드 작업으로 맡겼어요: ${took}` : "백그라운드 작업으로 맡겼어요";
			deps.log(`the answer to ${p.target} is deferred to a background worker`);
			deps.announce?.(p.target, note);
			save();
			return;
		}
		if (t === LATER) return;
		p.done = true;
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
		if (fresh.length) deps.log(`replaying ${fresh.length} unanswered prompt(s) from before the restart`);
		for (const p of fresh) deliver(wrap(p.text), p.target ? { target: p.target, replyTo: p.replyTo } : undefined);
		return fresh.length;
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
			.map(({ text, at, target, replyTo }) => ({ text, at, target, replyTo }));
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

	return { deliver, settleSteered, sent, holdEarly, cancel, retarget, markAnswered, isAnswered, redeliverSteered, onPrompt, onText, settleTurn, onAnswer, replay, reopen, waitingOnWorkers, deferredOpen, turnAt, queued: () => prompts.slice(), current: () => current };
}
