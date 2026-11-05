// A call the owner's rules, a plugin or a feature refuse is refused the same way every time until the owner says otherwise (an OK in the mail's
// thread, a new instruction). The agent still retried it, wrapped in variables, loops or a written OK file, and every retry re-reads the whole
// context. The first refusal is said as it is; the same reason again, within the same owner input, tells the agent to end the turn with a report.
// The refusal itself is never weakened: every call is checked afresh, this only changes what the repeat says.
const ORDINAL = ["", "1st", "2nd", "3rd"];

export function createRefusals() {
	const counts = new Map<string, number>();
	return {
		say(reason: string): string {
			const n = (counts.get(reason) ?? 0) + 1;
			counts.set(reason, n);
			if (n === 1) return reason;
			return `${reason}\nRefused for the ${ORDINAL[n] ?? `${n}th`} time this turn, for the same reason: do not call it again or wrap it differently (variables, loops, a written OK file). End this turn now: tell the owner what is refused and what you need, then wait.`;
		},
		/** A new owner input or the end of the run: what was refused may be allowed now. */
		reset(): void {
			counts.clear();
		},
	};
}
