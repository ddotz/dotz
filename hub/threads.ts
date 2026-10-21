// Where an answer and a lane go on Discord, as pure decisions (tested in threads.test.ts). The rule table in MODE.md
// ("Threads") describes the same behaviour for the model; the gateway applies it here so it holds whatever the model writes.
//
//   owner writes ...                         -> the answer / the work goes ...
//   top-level in chat, dm or a work channel  -> a reply to that message in the same channel
//   inside a thread or a lane channel        -> the same thread or channel, no reply reference (unless newer messages came in between)
//   a Discord reply to a thread's starter    -> into that thread
//   long work (a lane) from a work channel   -> a thread on the owner's own message in that channel
//   long work (a lane) from a thread         -> that thread becomes the lane's thread
//   long work (a lane) from chat             -> a new work channel (chat gets one pointer line)

export type LanePlace = { kind: "channel" } | { kind: "thread"; parent: string; fromMessage?: string } | { kind: "adopt"; thread: string; parent: string };

/**
 * Where a new lane works. `home` is the orchestrator's explicit ch:<id>; `asking` / `askingMessage` are the channel and
 * message of the owner request the launching turn answers; `threadParent` maps a known sub-topic thread to its parent.
 */
export function lanePlace(a: { home?: string; asking?: string; askingMessage?: string; isWork: (id: string) => boolean; threadParent: (id: string) => string | undefined }): LanePlace {
	if (a.home?.startsWith("ch:")) {
		const parent = a.home.slice(3);
		return { kind: "thread", parent, ...(a.asking === a.home && a.askingMessage ? { fromMessage: a.askingMessage } : {}) };
	}
	if (a.asking?.startsWith("ch:") && a.isWork(a.asking.slice(3))) return { kind: "thread", parent: a.asking.slice(3), ...(a.askingMessage ? { fromMessage: a.askingMessage } : {}) };
	if (a.asking?.startsWith("th:")) {
		const thread = a.asking.slice(3);
		const parent = a.threadParent(thread);
		if (parent) return { kind: "adopt", thread, parent };
	}
	return { kind: "channel" };
}

/**
 * Whether the launching turn's answer moves into the new lane's thread: only when the owner asked in that Discord work
 * channel or thread. An ask from chat, dm, the web or the terminal is answered where it was asked; with a `home` channel
 * the lane still gets its thread, but the answer stays (2026-10-21: two web answers went only to Discord lane threads).
 */
export function answerMovesToLane(place: LanePlace, asking: string | undefined): boolean {
	return place.kind !== "channel" && Boolean(asking && (asking.startsWith("ch:") || asking.startsWith("th:")));
}

/** A Discord message id. A web message id (8 hex chars) is not one: Discord rejects it as a message_reference. */
export const isSnowflake = (id: string): boolean => /^\d{15,22}$/.test(id);

const TOP_LEVEL = new Set(["chat", "dm", "worklog", "alert"]);
/**
 * The Discord reply reference for an answer to owner message `replyTo` in `target`. A top-level channel always gets it (the
 * answer shows under the question). In a thread or lane channel the conversation is already one topic, so the reference is
 * noise on a phone; it is kept only when the owner wrote something newer there meanwhile (`lastOwner`), so the pairing is clear.
 */
export function replyRef(target: string, replyTo: string | undefined, lastOwner: string | undefined): string | undefined {
	if (!replyTo || !isSnowflake(replyTo)) return undefined;
	if (TOP_LEVEL.has(target) || target.startsWith("ch:")) return replyTo;
	return lastOwner && lastOwner !== replyTo ? replyTo : undefined;
}

/**
 * A Discord reply (in the parent channel) to the message a thread hangs from belongs in that thread. A thread started from a
 * message has that message's id, so `ref` is the thread id; `threads` maps thread id -> parent channel id.
 */
export function threadForReply(ref: string | undefined, channelId: string, threads: Record<string, string>): string | undefined {
	return ref && threads[ref] === channelId ? ref : undefined;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
export const THREAD_NAME_MAX = 60;
/**
 * A thread name the owner can read on a phone: plain words of what the work is. No "[kind]" prefix, status, emoji or pipes;
 * a code name ("dinobot-rea") gives way to the first words of `fallback` (the goal or starter text); cut at a word.
 */
export function threadTitle(title: string | undefined, fallback?: string): string {
	const clean = (s: string) => s.replace(EMOJI, "").replace(/^\s*(?:\[[^\]]{0,30}\]\s*)+/, "").replace(/[┃|]/g, " ").replace(/\s+/g, " ").trim();
	let name = clean(title ?? "");
	const alt = clean(fallback ?? "").replace(/[.。!?].*$/, "");
	if ((!name || SLUG.test(name)) && alt) name = alt;
	if (name.length > THREAD_NAME_MAX) {
		const cut = name.slice(0, THREAD_NAME_MAX);
		const sp = cut.lastIndexOf(" ");
		name = (sp > 20 ? cut.slice(0, sp) : cut).trim();
	}
	return name || "work";
}
