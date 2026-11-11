// What of a lane's reports reaches the orchestrator, and how (owner 2026-10-19: complete where it matters, but token-lean).
// Every report still goes to the lane's channel and to report.md; for the orchestrator:
// - a question, a failure, a result or an untagged report goes in whole (never cut), with its status and where the
//   evidence is on disk;
// - a routine [run] progress report is not a turn: it stays on disk and in the what-runs-now line of the next prompt;
// - an untagged reply in an exchange between the owner and the lane alone (the orchestrator sent nothing since its last
//   relayed report) is not a turn either: the owner read it in the lane channel;
// - nor is the gateway's own usage-limit notice (the lane resumes by itself), or an untagged report while the lane's workers run: 7 days
//   to 2026-11-05 held 25 such "still running" turns (8.6M tokens) and 22 of them did nothing. `orchAsked` stays set, so the report that
//   follows is the one relayed;
// - a report repeating the lane's last relayed one is dropped (a gateway notice such as [lane exited] never is);
// - a report arriving while the orchestrator is in a turn is steered into that turn at once (2026-10-20: held reports
//   reached it after p90 368 s); only when the turn cannot take it are reports batched into one prompt for idle.
import { orchestratorOnlyAsk } from "./forline.ts";
import { MAIN } from "./session-key.ts";
import { parkedTone, parseTone, type Tone } from "./tone.ts";

/** `from`: the session key of the conversation that launched the lane (none = main); its report goes to that session. */
export type Relay = { lane: string; tone?: Tone; text: string; file: string; from?: string };

/** No orchestrator turn for an untagged report: see the list above. A done claim made further down the text still goes. */
export const ownerAlone = (l: { orchAsked?: boolean; claim?: unknown }, pause: boolean, workers: number): boolean => pause || l.orchAsked === false || (workers > 0 && !l.claim);

function relayItem(r: Relay): string {
	return `- lane ${r.lane} status=${r.tone ?? "report"} (full: ${r.file})\n${r.text.trim()}`;
}

// Owner messages a lane has not answered yet (2026-10-21: "내가 직접 레인에 보내는건 피드백이 안와서"). The lane's first text that ends
// in a tool call after such a message is its short answer note (the footer asks for one): it is shown to the owner where he wrote
// at once, and is never routine progress ("disk") or an owner-only exchange kept off the surface. A text that ends the turn is
// the final report, which answers them when it is reported.
type OwnerNotesDeps = { note: (lane: string, text: string, refs: string[]) => void; answered: (lane: string, refs: string[]) => void; refused?: (lane: string, refs: string[]) => void; lost?: (lane: string, refs: string[]) => void };

// A session that took a steered message for injected tool output says so in its next text (see hub/steer-mark.ts). That text is no
// answer: the message stays unanswered and the owner sees that it failed, instead of an "answered" over a dropped instruction.
const REFUSED = [
	/(?:도구|툴)\s*(?:출력|결과)[^\n.]{0,80}(?:따르지|무시)/,
	/(?:프롬프트\s*인젝션|prompt.injection)[^\n.]{0,80}(?:따르지|무시|ignor|not follow|won't follow|not act)/i,
	/(?:tool|function) (?:output|result)[^\n.]{0,80}(?:ignor|not follow|won't follow|not act|not treat)/i,
];
export const refusesAsInjection = (text: string): boolean => REFUSED.some(r => r.test(text));

export function createOwnerNotes(deps: OwnerNotesDeps) {
	const open = new Map<string, string[]>();
	// Lanes whose owner message a mid-turn note already answered: the report that ends that turn is still the answer the owner waits for.
	const noted = new Set<string>();
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
			const refused = refusesAsInjection(text);
			if (!refused) noted.add(lane);
			deps.note(lane, text.trim(), refused ? [] : refs);
			(refused ? deps.refused : deps.answered)?.(lane, refs);
			return "note";
		},
		/** The lane reported (its turn's final text): everything still open is answered by it; true when something was open, or a note earlier prompted the owner's answer and this is the first report that is not a [run] (a [run] stays progress and keeps the note; a [run] that answers open messages leaves the note for the result that follows). */
		reported(lane: string, text = ""): boolean {
			const refs = open.get(lane);
			const run = parseTone(text).tone === "run";
			if (!refs?.length) return noted.has(lane) && !run && noted.delete(lane);
			noted.delete(lane);
			if (run) noted.add(lane);
			open.delete(lane);
			(refusesAsInjection(text) ? deps.refused : deps.answered)?.(lane, refs);
			return true;
		},
		/** The lane has owner messages waiting for an answer. */
		waiting: (lane: string): boolean => (open.get(lane)?.length ?? 0) > 0,
		/** The lane's process ended: nothing more will answer them. */
		lost(lane: string): void {
			const refs = open.get(lane);
			open.delete(lane);
			noted.delete(lane);
			if (refs?.length) deps.lost?.(lane, refs);
		},
		/** The message could not be delivered after all. */
		drop: (lane: string): void => void (open.delete(lane), noted.delete(lane)),
	};
}

// Busy, deliver and steer name the session (`key`) the report belongs to: a lane started from a conversation reports to that conversation's session, not to main.
export function createLaneRelay(deps: { busy: (key: string) => boolean; deliver: (text: string, key: string) => void; lead: (n: number) => string; steer?: (text: string, key: string) => boolean }) {
	const last = new Map<string, string>();
	const held: Relay[] = [];
	const norm = (t: string) => t.replace(/\s+/g, " ").trim();
	const body = (items: Relay[]) => `${deps.lead(items.length)}\n${items.map(relayItem).join("\n\n")}`;
	// The lanes whose question for the owner this session's turn heard (lane -> session key); the turn ends at the idle hook (flush).
	const asked = new Map<string, string>();
	const heard = (items: Relay[]) => {
		for (const r of items) if (r.tone === "ask" && !orchestratorOnlyAsk(parseTone(r.text).text)) asked.set(r.lane, r.from ?? MAIN);
	};
	const send = (key: string, items: Relay[]) => {
		heard(items);
		deps.deliver(body(items), key);
	};

	/** A lane's report: "relayed" (now), "steered" (into the running turn), "held" (batched for idle), "disk" (routine), "owner" (owner-only exchange) or "duplicate". */
	function report(lane: string, text: string, file: string, ownerOnly = false, from = MAIN): "relayed" | "steered" | "held" | "disk" | "owner" | "duplicate" {
		const { tone } = parseTone(text);
		if (parkedTone(tone)) return "disk";
		if (!tone && ownerOnly && !/^\[lane [a-z]+\]/.test(text)) return "owner";
		const key = norm(text);
		// A gateway notice ([lane exited], [lane error]) is a new event each time, even in the same words: an owner message
		// that resumed a lane which died again at once must still reach the orchestrator (2026-10-20 17:16, gateway-ui).
		if (last.get(lane) === key && !/^\[lane [a-z]+\]/.test(text)) return "duplicate";
		last.set(lane, key);
		const item = { lane, tone, text, file, from };
		if (deps.busy(from)) {
			if (deps.steer?.(body([item]), from)) {
				heard([item]);
				return "steered";
			}
			// A newer report of the same lane replaces the held one: only its latest state matters.
			const i = held.findIndex(h => h.lane === lane && h.tone !== "ask");
			if (i >= 0 && tone !== "ask") held.splice(i, 1, item);
			else held.push(item);
			return "held";
		}
		send(from, [item]);
		return "relayed";
	}

	/** The session `key` went idle: what it held goes in as one prompt. */
	function flush(key = MAIN): number {
		for (const [lane, k] of asked) if (k === key) asked.delete(lane);
		if (deps.busy(key)) return 0;
		const items = held.filter(h => (h.from ?? MAIN) === key);
		if (!items.length) return 0;
		for (const h of items) held.splice(held.indexOf(h), 1);
		send(key, items);
		return items.length;
	}

	return { report, flush, held: () => held.slice(), asked: () => [...asked.keys()] };
}
