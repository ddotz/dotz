// A chat about a monitor (its settings conversation, or its project's conversation with the monitor's note attached): once the answer to it is
// out, the owner has likely fixed something (a relogin, a setting), so that monitor runs once now and the list does not stay 실패 until the next
// scheduled check. intake.ts records the question, outbound.ts reports the answer.
import { log } from "./config.ts";
import { runWatch } from "./watch.ts";
import { watchOfSubject } from "./watch-settings.ts";

let run: (name: string) => Promise<void> = runWatch;
/** Tests replace the runner; production runs the watch. */
export const setRecheckRunner = (fn: (name: string) => Promise<void>): void => void (run = fn);

const asked = new Map<string, string>();

/** The owner asked about monitor `subject` ("w:<name>") in conversation `conv`; other subjects (apps) are ignored. */
export function watchAsked(conv: string, subject: string): void {
	const name = watchOfSubject(subject);
	if (name) asked.set(conv, name);
}

/** An answer went out in `conv`: the monitor asked about there runs once now. Returns its name. */
export function recheckAnswered(conv: string): string | undefined {
	const name = asked.get(conv);
	if (!name) return undefined;
	asked.delete(conv);
	void run(name).catch(e => log(`watch ${name}: the run after its settings answer failed: ${(e as Error).message}`));
	return name;
}
