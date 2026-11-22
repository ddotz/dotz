import { setAskerNotes } from "./asker-notes.ts";
import { laneExists } from "./notices-lanes.ts";
import { plainCard } from "./notices-decisions.ts";
import { items, save } from "./notices-store.ts";
import type { Notice } from "./notices-types.ts";

/**
 * Keeps `line` on the card for its asker (the session that asked, or the orchestrator), who hears it with its next prompt and no turn of its own. A question of
 * the gateway, a send approval, a login request, a schedule run and the card of a session that has ended get none. Saved with the card, so it survives a restart.
 */
export function tellAsker(n: Notice, line: string): void {
	const d = n.decision;
	if (!d || !plainCard(d) || n.by === "gateway") return;
	if (d.to.startsWith("lane:") && !laneExists(d.to.slice(5))) return;
	d.tell = line;
}

/** Takes the lines waiting for the askers of the cards whose `to` matches: each is given once. */
export function takeAskerNotes(asker: (to: string) => boolean): string[] {
	const hit = items.filter(n => n.decision?.tell && asker(n.decision.to));
	const lines = hit.map(n => n.decision!.tell!);
	for (const n of hit) delete n.decision!.tell;
	if (hit.length) save();
	return lines;
}
setAskerNotes(takeAskerNotes);
