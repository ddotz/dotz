// What of a lane's reports reaches the orchestrator, and how (owner 2026-10-19: complete where it matters, but token-lean).
// Every report still goes to the lane's channel and to report.md; for the orchestrator:
// - a question, a failure, a result or an untagged report goes in whole (never cut), with its status and where the
//   evidence is on disk;
// - a routine [run] progress report is not a turn: it stays on disk and in the what-runs-now line of the next prompt;
// - an untagged reply in an exchange between the owner and the lane alone (the orchestrator sent nothing since its last
//   relayed report) is not a turn either: the owner read it in the lane channel;
// - a report repeating the lane's last relayed one is dropped (a gateway notice such as [lane exited] never is);
// - a report arriving while the orchestrator is in a turn is steered into that turn at once (2026-10-20: held reports
//   reached it after p90 368 s); only when the turn cannot take it are reports batched into one prompt for idle.
import { parseTone, type Tone } from "./tone.ts";

export type Relay = { lane: string; tone?: Tone; text: string; file: string };

export function relayItem(r: Relay): string {
	return `- lane ${r.lane} status=${r.tone ?? "report"} (full: ${r.file})\n${r.text.trim()}`;
}

// Owner messages a lane has not answered yet (2026-10-21: "내가 직접 레인에 보내는건 피드백이 안와서"). The lane's first text that ends
// in a tool call after such a message is its short answer note (the footer asks for one): it is shown to the owner where he wrote
// at once, and is never routine progress ("disk") or an owner-only exchange kept off the surface. A text that ends the turn is
// the final report, which answers them when it is reported.
export type OwnerNotesDeps = { note: (lane: string, text: string, refs: string[]) => void; answered: (lane: string, refs: string[]) => void; lost?: (lane: string, refs: string[]) => void };

export function createOwnerNotes(deps: OwnerNotesDeps) {
	const open = new Map<string, string[]>();
	return {
		/** The owner message `ref` was sent to `lane`. */
		asked(lane: string, ref: string | undefined): void {
			if (ref) open.set(lane, [...(open.get(lane) ?? []), ref]);
		},
		/** An assistant text of the lane; `endsTurn` is false when it ended in a tool call. "note" = shown now as the answer. */
		text(lane: string, text: string, endsTurn: boolean): "note" | "final" | "none" {
			const refs = open.get(lane);
			if (!refs?.length || !text.trim()) return "none";
			if (endsTurn) return "final";
			open.delete(lane);
			deps.note(lane, text.trim(), refs);
			deps.answered(lane, refs);
			return "note";
		},
		/** The lane reported (its turn's final text): everything still open is answered by it; true when something was open (the report is an answer to the owner, whatever its tone). */
		reported(lane: string): boolean {
			const refs = open.get(lane);
			if (!refs?.length) return false;
			open.delete(lane);
			deps.answered(lane, refs);
			return true;
		},
		/** The lane has owner messages waiting for an answer. */
		waiting: (lane: string): boolean => (open.get(lane)?.length ?? 0) > 0,
		/** The lane's process ended: nothing more will answer them. */
		lost(lane: string): void {
			const refs = open.get(lane);
			open.delete(lane);
			if (refs?.length) deps.lost?.(lane, refs);
		},
		/** The message could not be delivered after all. */
		drop: (lane: string): void => void open.delete(lane),
	};
}

export function createLaneRelay(deps: { busy: () => boolean; deliver: (text: string) => void; lead: (n: number) => string; steer?: (text: string) => boolean }) {
	const last = new Map<string, string>();
	const held: Relay[] = [];
	const norm = (t: string) => t.replace(/\s+/g, " ").trim();
	const body = (items: Relay[]) => `${deps.lead(items.length)}\n${items.map(relayItem).join("\n\n")}`;
	const send = (items: Relay[]) => deps.deliver(body(items));

	/** A lane's report: "relayed" (now), "steered" (into the running turn), "held" (batched for idle), "disk" (routine), "owner" (owner-only exchange) or "duplicate". */
	function report(lane: string, text: string, file: string, ownerOnly = false): "relayed" | "steered" | "held" | "disk" | "owner" | "duplicate" {
		const { tone } = parseTone(text);
		if (tone === "run") return "disk";
		if (!tone && ownerOnly && !/^\[lane [a-z]+\]/.test(text)) return "owner";
		const key = norm(text);
		// A gateway notice ([lane exited], [lane error]) is a new event each time, even in the same words: an owner message
		// that resumed a lane which died again at once must still reach the orchestrator (2026-10-20 17:16, gateway-ui).
		if (last.get(lane) === key && !/^\[lane [a-z]+\]/.test(text)) return "duplicate";
		last.set(lane, key);
		const item = { lane, tone, text, file };
		if (deps.busy()) {
			if (deps.steer?.(body([item]))) return "steered";
			// A newer report of the same lane replaces the held one: only its latest state matters.
			const i = held.findIndex(h => h.lane === lane && h.tone !== "ask");
			if (i >= 0 && tone !== "ask") held.splice(i, 1, item);
			else held.push(item);
			return "held";
		}
		send([item]);
		return "relayed";
	}

	/** The orchestrator went idle: everything held goes in as one prompt. */
	function flush(): number {
		if (!held.length || deps.busy()) return 0;
		const items = held.splice(0);
		send(items);
		return items.length;
	}

	return { report, flush, held: () => held.slice() };
}
