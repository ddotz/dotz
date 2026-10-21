// A project orchestrator in the web chat: the orchestrator working in a project's Discord work channel. dotz runs one
// orchestrator process; a work channel (a project's channel, the 구성/홈 프로젝트 with a channel) is its own conversation
// there, with the channel's setup and rules (channelContext). The web chat reaches it the way a message in that channel
// does: target `ch:<id>` with the channel name, through intake, and the answer goes back to ch:<id> (Discord and web).
export const isProjectTarget = (t: string) => /^ch:\d+$/.test(t);

// The outbox event of anything the gateway sends to Discord (owner 2026-10-21: what goes out on Discord also shows in the gateway chat).
// A work channel is its own web conversation by its target; a thread of a work channel (`th:<id>`) belongs to the channel it hangs from,
// which `eventTarget` finds through `channel`. `parentOf` gives that work channel's id for a thread, or nothing for any other thread.
export function outEvent<E extends { target: string }>(e: E, parentOf: (thread: string) => string | undefined): E & { channel?: string } {
	const parent = e.target.startsWith("th:") ? parentOf(e.target.slice(3)) : undefined;
	return parent ? { ...e, channel: `ch:${parent}` } : e;
}

// `id` is the channel id or `ch:<id>`; only a work channel the gateway knows is a project target.
export function projectTarget(id: string, work: Record<string, string>): { target: string; name: string } {
	const bare = id.startsWith("ch:") ? id.slice(3) : id;
	if (!/^\d+$/.test(bare) || !work[bare]) throw new Error(`no project channel ${id}: pick one of the work channels`);
	return { target: `ch:${bare}`, name: work[bare] };
}
