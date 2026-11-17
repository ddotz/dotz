import { sameConv } from "./promptburst.ts";
import { labels, MAX_ANSWERED, type Prompt, type PromptDeps, type Reply, type Turn, type Woke, type WorkLink } from "./prompts-model.ts";

/** What the prompt queue (prompts.ts) lends the two re-asks below. */
export type AskAgainState = {
	deps: PromptDeps;
	woke: Woke[];
	links: Map<string, WorkLink>;
	askedBack: Set<string>;
	turns: Turn[];
	saveLinks: () => void;
	tiedOpen: (l: WorkLink) => Prompt[];
	linksOf: (p: { target?: string; replyTo?: string }) => WorkLink[];
	openDeferred: () => Prompt[];
	deliver: (text: string, reply: Reply) => boolean;
};

/**
 * The two ways a request whose worker's result was read where it was not answered is asked again, each once per worker and leaving the request open.
 * `askLeftover`: the run ended, so a wake still listed was read there and not answered and may not pair with the next run; its request is asked
 * again when it waits on nothing else (a run that said [later] chose to wait; a conversation switch is askBack's).
 * `askBack`: a turn for one conversation ended while a worker of another finished during it: OmO read that result here, but the request it
 * answers still waits in its own conversation, and is asked again with its own text.
 */
export function createAskAgain(c: AskAgainState) {
	const { deps, woke, links, askedBack, turns } = c;

	function askLeftover(target?: string): void {
		const work = deps.work?.() ?? [];
		const live = new Set(work.filter(w => w.status === "running" || w.status === "stalled").map(w => w.id));
		for (const w of woke.splice(0).filter(w => !w.waited)) {
			const l = links.get(w.id);
			if (!l || l.delivered || l.cancelled) continue;
			l.read = true;
			c.saveLinks();
			const d = c.tiedOpen(l)[0];
			if (!d?.target || askedBack.has(l.id) || !deps.readHereNote || (target && !sameConv(target, d.target)) || c.linksOf(d).some(o => live.has(o.id))) continue;
			askedBack.add(l.id);
			deps.log(`the result of ${l.id} was read in a run that did not answer ${d.replyTo ?? "(no id)"}; it is asked again`);
			c.deliver(`${deps.readHereNote(l.id)}\n\n${d.text}`, { target: d.target, replyTo: d.replyTo, ...labels(d) });
		}
	}

	function askBack(target: string | undefined): void {
		const work = deps.work?.();
		const note = deps.readElsewhereNote;
		if (!target || !note || !work?.length) return;
		const from = turns.at(-1)?.start ?? 0;
		const to = Date.now();
		for (const w of work) {
			if (w.status === "running" || w.status === "stalled" || w.endedAt === undefined || w.endedAt < from || w.endedAt > to) continue;
			if (!w.target || sameConv(w.target, target) || askedBack.has(w.id)) continue;
			const open = c.openDeferred().filter(p => p.target === w.target);
			const d = open.find(p => w.replyTo !== undefined && p.replyTo === w.replyTo) ?? open.at(-1);
			if (!d) continue;
			askedBack.add(w.id);
			if (askedBack.size > MAX_ANSWERED) askedBack.delete(askedBack.values().next().value!);
			deps.log(`the result of ${w.id} for ${w.target} was read in a turn for ${target}; ${w.target} is asked again`);
			c.deliver(`${note(w, target)}\n\n${d.text}`, { target: w.target, replyTo: d.replyTo, ...labels(d) });
		}
	}

	return { askLeftover, askBack };
}
