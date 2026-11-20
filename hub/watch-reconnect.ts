import { log } from "./config.ts";
import { approveWatch, allWatches, runWatch, type Watch } from "./watch.ts";
import { watchSubject } from "./watch-ask.ts";
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

/** The owner pressed 다시 연결 on the card of the watch issue `question`: the watch it names reconnects, no model turn. */
export function reconnectFromCard(question: string): void {
	const subject = watchSubject(question);
	const named = subject === undefined ? [] : allWatches().filter(w => watchLabel(w.name) === subject);
	if (named.length !== 1) throw new Error("이 모니터링을 찾을 수 없어요");
	const run = reconnectWatch(named[0]!);
	void run.done.catch(e => log(`watch ${named[0]!.name}: the run after 다시 연결 failed: ${(e as Error).message}`));
}
