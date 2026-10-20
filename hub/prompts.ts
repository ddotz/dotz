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

export type Prompt = { key: string; text: string; at: number; target?: string; replyTo?: string; sent: { target: string; text: string }[]; done?: boolean; steered?: boolean; held?: string[] };
export type Pending = { text: string; at?: number; target?: string; replyTo?: string };
export type Reply = { target: string; replyTo?: string; owner?: boolean };

export type PromptDeps = {
	/** Starts a normal orchestrator turn with this prompt. */
	deliver: (text: string, owner?: boolean) => void;
	/** Steers a note into the running turn. */
	steer: (text: string) => void;
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
};

const MAX_PROMPTS = 200;
const MAX_ANSWERED = 5000;
const REPLAY_MAX_AGE_MS = 12 * 3600_000;

export function createPrompts(deps: PromptDeps) {
	const prompts: Prompt[] = [];
	let current: Prompt | undefined;
	// Insertion order doubles as age: the oldest id goes first when the set is full.
	const answered = new Set<string>(deps.answered ?? []);

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
		prompts.push({ key: text.slice(0, 300), text, at: Date.now(), target: reply?.target, replyTo: reply?.replyTo, sent: [], steered });
		if (prompts.length > MAX_PROMPTS) prompts.splice(0, prompts.length - MAX_PROMPTS);
		save();
		if (!steered) return deps.deliver(text, Boolean(reply?.owner));
		deps.steer(deps.note(reply!.target, reply!.replyTo, text));
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
		const i = prompts.findIndex(p => !p.steered && text.includes(p.key));
		current = i >= 0 ? prompts.splice(i, 1)[0] : undefined;
		save();
	}

	/** An assistant stop: the turn's final answer goes to the channel that asked, once. */
	function onAnswer(text: string): void {
		const p = current;
		// A turn omp continues (steered notes) stops again; the prompt it started with was answered at the first stop.
		if (!p || p.done) return;
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

	return { deliver, settleSteered, sent, holdEarly, retarget, markAnswered, isAnswered, redeliverSteered, onPrompt, onAnswer, replay, queued: () => prompts.slice(), current: () => current };
}
