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

export type Prompt = { key: string; text: string; at: number; target?: string; replyTo?: string; sent: { target: string; text: string }[]; done?: boolean; steered?: boolean; held?: string[]; last?: string; unmatched?: boolean };
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
};

const MAX_PROMPTS = 200;
const MAX_ANSWERED = 5000;
const REPLAY_MAX_AGE_MS = 12 * 3600_000;
// How old an owner message may be to receive an answer that has no prompt of its own.
const ORPHAN_MAX_AGE_MS = 30 * 60_000;
const MAX_RECENT = 20;

export function createPrompts(deps: PromptDeps) {
	const prompts: Prompt[] = [];
	let current: Prompt | undefined;
	// Insertion order doubles as age: the oldest id goes first when the set is full.
	const answered = new Set<string>(deps.answered ?? []);
	// Owner messages and dotz_send texts of the last half hour: who an answer without a prompt goes to, and what it may not repeat.
	const owners: OwnerMessage[] = (deps.recent?.() ?? []).slice(-MAX_RECENT);
	const recentSent: { target: string; text: string; at: number }[] = [];

	const save = () => {
		const open = [...(current && !current.done ? [current] : []), ...prompts].map(({ text, at, target, replyTo }) => ({ text, at, target, replyTo }));
		deps.persist(open);
	};
	const isAnswered = (replyTo?: string) => replyTo !== undefined && (answered.has(replyTo) || deps.pending?.(replyTo) === true);

	/** Records that the owner message `replyTo` got an answer. */
	function markAnswered(replyTo: string | undefined | null): void {
		if (!replyTo) return;
		answered.delete(replyTo);
		answered.add(replyTo);
		if (answered.size > MAX_ANSWERED) answered.delete(answered.values().next().value!);
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

	/** omp started a prompt: pair it with the delivered one it came from. */
	function onPrompt(text: string): void {
		// Notes steered into a running turn are not new requests: the turn keeps answering the prompt it started with.
		if (deps.isNote(text)) return;
		// The harness's own mid-turn injections (OmO: `<system-reminder>` when a detached cell finishes, `<omo-senpi-task>`)
		// are not prompts either; clearing `current` on them dropped the turn's final answer (owner 2026-10-20: "작업 끝나도
		// 보고 안하는거", the 17:18 web turn).
		if (text.trimStart().startsWith("<")) return;
		const i = prompts.findIndex(p => !p.steered && text.includes(p.key));
		if (i < 0 && current && !current.done) {
			// A user frame the gateway did not deliver (raw text admitted into the run, a runtime's own message): the turn is
			// still answering the prompt it started with, so its answer must not lose its prompt (2026-10-20 10:43Z, 10:52Z).
			if (!current.unmatched) deps.log(`a user prompt matched nothing delivered; the running turn keeps its prompt for ${current.target ?? "-"}: ${text.trim().slice(0, 80)}`);
			current.unmatched = true;
			return;
		}
		current = i >= 0 ? prompts.splice(i, 1)[0] : undefined;
		save();
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
		if (!p.done && p.target) {
			deps.log(`turn ended without an answer to ${p.target}; ${p.last ? "sending its last text" : "it wrote no text"}`);
			if (p.last) onAnswer(p.last);
			else p.done = true;
		}
		current = undefined;
		save();
	}

	/** Who an answer without a prompt goes to: the owner's newest message of the last 30 minutes, one still unanswered first. */
	function orphanTarget(): OwnerMessage | undefined {
		const fresh = owners.filter(o => Date.now() - o.at <= ORPHAN_MAX_AGE_MS).sort((a, b) => a.at - b.at);
		return fresh.findLast(o => !(o.prompt?.done || isAnswered(o.replyTo))) ?? fresh.at(-1);
	}

	/** An answer that came without a prompt: the 30-minute rule above, never a repeat of what was already sent there. */
	function onOrphanAnswer(text: string): void {
		const t = text.trim();
		// Keepalive "ok" and "-" have no prompt by design.
		if (t.length <= 3) return;
		const to = orphanTarget();
		if (!to) return void deps.log(`an answer had no prompt to go to (${t.length} chars): ${t.slice(0, 80)}`);
		if (recentSent.some(s => s.target === to.target && Date.now() - s.at <= ORPHAN_MAX_AGE_MS && s.text.includes(t))) return;
		deps.log(`an answer had no prompt; sent to the owner's newest message in ${to.target} (${t.length} chars): ${t.slice(0, 80)}`);
		recentSent.push({ target: to.target, text: t, at: Date.now() });
		if (to.prompt) to.prompt.done = true;
		void deps
			.post(to.target, t, to.replyTo)
			.then(r => (r.delivered ? deps.clearProgress(to.target) : undefined))
			.catch(e => deps.log(`reply to ${to.target} failed: ${e}`));
	}

	/** An assistant stop: the turn's final answer goes to the channel that asked, once. */
	function onAnswer(text: string): void {
		const p = current;
		// A turn omp continues (steered notes) stops again; the prompt it started with was answered at the first stop.
		if (!p) return onOrphanAnswer(text);
		if (p.done) return;
		p.done = true;
		save();
		const t = text.trim();
		if (!p.target) return;
		const target = p.target;
		// Parts sent early with dotz_send do not replace the answer; skip it only when it repeats something already sent.
		const sentHere = p.sent.some(s => s.target === target);
		const held = p.held ?? [];
		const repeat = t === "-" || p.sent.some(s => s.target === target && s.text.includes(t)) || held.some(h => h.includes(t));
		if (repeat && !held.length) {
			if (sentHere) deps.clearProgress(target);
			return;
		}
		const body = [...held, ...(repeat ? [] : [t])].join("\n\n");
		p.sent.push({ target, text: body });
		void deps
			.post(target, body, p.replyTo)
			.then(r => (r.delivered ? deps.clearProgress(target) : undefined))
			.catch(e => deps.log(`reply to ${target} failed: ${e}`));
	}

	/** Delivers prompts that were never answered (the gateway stopped mid-turn) again; returns how many were replayed. */
	function replay(unanswered: Pending[], wrap: (text: string) => string): number {
		const fresh = unanswered.filter(p => p.text && Date.now() - (p.at ?? 0) < REPLAY_MAX_AGE_MS && !isAnswered(p.replyTo));
		if (fresh.length) deps.log(`replaying ${fresh.length} unanswered prompt(s) from before the restart`);
		for (const p of fresh) deliver(wrap(p.text), p.target ? { target: p.target, replyTo: p.replyTo } : undefined);
		return fresh.length;
	}

	return { deliver, settleSteered, sent, holdEarly, retarget, markAnswered, isAnswered, redeliverSteered, onPrompt, onText, settleTurn, onAnswer, replay, queued: () => prompts.slice(), current: () => current };
}
