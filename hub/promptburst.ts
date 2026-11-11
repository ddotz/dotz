// Owner messages that ride along with a turn instead of starting one: steered into it, or gathered behind a prompt that has not
// started yet. A burst reaches the model together and gets one answer; each message is delivered once and none is lost:
// - `gathered`: the session is starting, or its first prompt waits behind another conversation's turn. The messages stay here and
//   go in as one note when that turn starts (owner 2026-11-06: nine messages, nine turns, six of them twice).
// - `seen`: the steered note's user frame came, so the model has it and the next stop may answer it. A note lands after the stop
//   the model was already writing (2026-11-06 07:31:27), so only a seen note counts as answered, never every note open at a stop.
// - What is still open when the session goes idle was never seen or never answered: it goes in once, one turn per conversation.
import type { Prompt, PromptDeps } from "./prompts.ts";

// "chat" and "web" are both the owner's main conversation on the web page (hub/events.ts eventTarget).
export const isMain = (t: string) => t === "chat" || t === "web";
export const sameConv = (a: string, b: string) => a === b || (isMain(a) && isMain(b));
// A prompt older than this has lost its turn or waits on a usage limit: nothing gathers behind it, and what did goes on alone.
export const GATHER_MAX_MS = 60_000;

const idsOf = (p: Prompt) => [...new Set([...(p.refs ?? []), ...(p.replyTo ? [p.replyTo] : [])])];
const convOf = (p: Prompt) => (p.target && isMain(p.target) ? "web" : (p.target ?? ""));

type BurstDeps = Pick<PromptDeps, "steer" | "note" | "deliver" | "settled"> & {
	isAnswered: (id?: string) => boolean;
	markAnswered: (id?: string) => void;
	save: () => void;
};

export function createBurst(prompts: Prompt[], deps: BurstDeps) {
	const remove = (p: Prompt) => void prompts.splice(prompts.indexOf(p), 1);
	const inConv = (p: Prompt, target: string) => p.target !== undefined && sameConv(p.target, target);

	/** One prompt for `list`, oldest text first: its answer settles every message (`refs`), a restart keeps them. */
	function merge(list: Prompt[]): Prompt {
		if (list.length === 1) return list[0]!;
		for (const p of list) remove(p);
		const text = list.map(p => p.text).join("\n\n");
		const merged: Prompt = { key: text.slice(0, 300), text, at: list[0]!.at, target: list.at(-1)!.target, replyTo: list.findLast(p => p.replyTo)?.replyTo, refs: list.flatMap(idsOf), sent: [], owner: true };
		prompts.push(merged);
		return merged;
	}
	const unanswered = (list: Prompt[]) => list.filter(p => {
		if (!deps.isAnswered(p.replyTo)) return true;
		remove(p);
		return false;
	});

	/** Goes in as normal turns, one per conversation. */
	function hand(list: Prompt[]): void {
		const convs = Map.groupBy(unanswered(list), convOf);
		for (const group of convs.values()) {
			const m = merge(group);
			Object.assign(m, { steered: false, gathered: undefined, noted: undefined, seen: undefined });
			deps.deliver(m.text, true);
		}
		deps.save();
	}

	/** Should this owner message wait for the prompt of its conversation that has not started? */
	const gathers = (target: string) => prompts.some(p => p.owner && !p.steered && !p.gathered && !p.cancelled && inConv(p, target) && Date.now() - p.at < GATHER_MAX_MS);

	/** A prompt gathered behind one that never starts (a lost pairing, no idle to follow) must still go in. */
	function gathered(): void {
		setTimeout(() => {
			const old = prompts.filter(p => p.gathered && !p.cancelled && Date.now() - p.at >= GATHER_MAX_MS);
			if (old.length) hand(old);
		}, GATHER_MAX_MS).unref?.();
	}

	/** The turn of `target` started: what gathered behind its prompt joins it as one note. */
	function release(target: string): void {
		const list = unanswered(prompts.filter(p => p.gathered && !p.cancelled && inConv(p, target)));
		if (!list.length) return;
		const m = merge(list);
		const note = deps.note(m.target!, m.replyTo, m.text);
		Object.assign(m, { gathered: undefined, steered: true, noted: note.trim() });
		deps.save();
		if (deps.steer(note) !== false) return;
		Object.assign(m, { steered: false, noted: undefined });
		deps.deliver(m.text, true);
	}

	/** A note's user frame: the model has those messages now. */
	function see(frame: string): void {
		for (const p of prompts) if (p.noted && frame.includes(p.noted)) p.seen = true;
	}
	const seen = (target: string) => prompts.filter(p => p.steered && p.seen && inConv(p, target));

	/** The messages of `list` leave the queue; `close` marks them answered once the answer went out. Returns their ids. */
	function take(list: Prompt[]): string[] {
		for (const p of list) remove(p);
		return list.flatMap(idsOf);
	}

	/** `ids` were answered in `target`: they stop waiting, for the queue and on screen. */
	function close(target: string, ids: string[]): void {
		for (const id of ids) deps.markAnswered(id);
		if (ids.length) deps.settled?.(target, ids);
	}

	const find = (target: string, replyTo?: string) => prompts.find(p => p.steered && p.target === target && (replyTo ? p.replyTo === replyTo || p.refs?.includes(replyTo) === true : true));

	/** A dotz_send settles the steered prompt it answers: the one with this message id, or, when it names none, the first the model has seen. */
	function settle(target: string, replyTo?: string): void {
		const p = replyTo ? find(target, replyTo) : prompts.find(q => q.seen && q.target === target);
		if (!p) return;
		close(target, take([p]));
		deps.save();
	}

	/** The orchestrator is idle: what no answer covered goes in again, once. */
	const redeliver = () => hand(prompts.filter(p => (p.steered || p.gathered) && !p.cancelled));

	return { gathers, gathered, release, see, seen, cover: (target: string) => take(seen(target)), close, find, settle, redeliver };
}
