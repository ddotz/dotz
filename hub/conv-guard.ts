// A session posts in its own conversation. A post into another one needs a named reason (dotz_send from main, an approval card);
// without one it lands in the session's own conversation instead of being lost, and the log says where it was meant to go.
import { primaryTarget } from "./session-key.ts";

export type Guarded = { target: string; crossed?: string; refused?: true };

/** Where `session`'s post to `target` lands. `keyOf` maps a target to the session that owns its conversation. */
export function guardTarget(session: string, target: string, keyOf: (target: string) => string, reason?: string): Guarded {
	if (keyOf(target) === session) return { target };
	return reason ? { target, crossed: reason } : { target: primaryTarget(session), refused: true };
}

/** The log line for a guarded post; nothing for a post in its own conversation. */
export function guardLine(session: string, target: string, g: Guarded): string | undefined {
	if (g.crossed) return `cross-conversation post: ${session} -> ${target} (${g.crossed})`;
	if (g.target !== target) return `cross-conversation post refused: ${session} -> ${target}; posted in ${g.target}`;
	return undefined;
}
