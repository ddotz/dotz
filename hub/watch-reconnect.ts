import { log } from "./config.ts";
import { items } from "./notices-store.ts";
import { approveWatch, allWatches, runWatch, type Watch } from "./watch.ts";
import { watchCardId, watchSubject } from "./watch-ask.ts";
import { watchConnection } from "./watch-status.ts";
import { watchLabel } from "./workchannels.ts";

/** 다시 연결: a disconnected watch behind an approval gate (a login that sends a push to the owner's phone) is approved, which runs it; any other watch runs once. `done` is the run. */
export function reconnectWatch(w: Watch): { approved: boolean; done: Promise<void> } {
	if (w.approval_minutes && watchConnection(w).state === "disconnected") {
		approveWatch(w.id);
		return { approved: true, done: Promise.resolve() };
	}
	return { approved: false, done: runWatch(w.name) };
}

/** The owner pressed 다시 연결 on the card `notice` (its id in the notice store) of the watch issue `question`: the watch it names reconnects, no model
 *  turn. A card with an id (`watches:<name>`) names its watch by it; a card stored without one names it by the label in its title. */
export function reconnectFromCard(question: string, notice: string): void {
	const id = items.find(n => n.id === notice)?.decision?.card_id, subject = id === undefined ? watchSubject(question) : undefined;
	const named = allWatches().filter(w => (id === undefined ? subject !== undefined && watchLabel(w.name) === subject : watchCardId(w.name) === id));
	if (named.length !== 1) throw new Error("이 모니터링을 찾을 수 없어요");
	const run = reconnectWatch(named[0]!);
	void run.done.catch(e => log(`watch ${named[0]!.name}: the run after 다시 연결 failed: ${(e as Error).message}`));
}
