let take: (asker: (to: string) => boolean) => string[] = () => [];
/** The notice store hands over the lines a card's asker still has to hear (hub/notices-tell.ts takeAskerNotes). */
export const setAskerNotes = (fn: typeof take): void => void (take = fn);
/** The lines waiting for the asker of every card whose `to` matches, each taken once: main's queue (hub/outbound.ts) and a session's prompt (hub/laneprompt.ts) carry them. */
export const askerNotes = (asker: (to: string) => boolean): string[] => take(asker);
/** The lines as they lead a prompt: each one a gateway line. */
export const askerLines = (lines: readonly string[]): string => lines.map(l => `[dotz gateway] ${l}`).join("\n");
