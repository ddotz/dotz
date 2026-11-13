// A lane's request to main (dotz_main, POST /api/conv-sessions/main/send from `lane:<name>`) and main's answer to it. The request is main's
// handed work (hub/routes-send.ts); the answer comes back here, to the lane, as its next message. One round only: the turn that answer starts
// (lane.handedBack, cleared by the lane's next report or any new instruction) may not hand main work again.
import { log } from "./config.ts";
import { msg } from "./i18n.ts";
import { recordHanded } from "./handed.ts";
import { lanes, sendToLane } from "./lanes.ts";

export const laneKey = (name: string): string => `lane:${name}`;

/** Main's final answer `text` to the work lane `lane` handed it: recorded in the lane's channel, then sent to the lane (a gateway prompt, not an owner message). */
export function handBackToLane(lane: string, from: string, text: string): void {
	recordHanded({ to: laneKey(lane), from, text, handback: true });
	const l = lanes.get(lane);
	if (!l) return log(`${laneKey(lane)} is gone; main's answer to its request was not delivered`);
	l.handedBack = true;
	try {
		sendToLane(lane, `${msg().handbackLead} ${text}`, undefined, true);
	} catch (e) {
		l.handedBack = undefined;
		log(`${laneKey(lane)} could not take main's answer (${(e as Error).message})`);
	}
}
