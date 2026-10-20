// A project orchestrator in the web chat: the orchestrator working in a project's Discord work channel. dotz runs one
// orchestrator process; a work channel (a project's channel, the 구성/홈 프로젝트 with a channel) is its own conversation
// there, with the channel's setup and rules (channelContext). The web chat reaches it the way a message in that channel
// does: target `ch:<id>` with the channel name, through intake, and the answer goes back to ch:<id> (Discord and web).
export const isProjectTarget = (t: string) => /^ch:\d+$/.test(t);

// `id` is the channel id or `ch:<id>`; only a work channel the gateway knows is a project target.
export function projectTarget(id: string, work: Record<string, string>): { target: string; name: string } {
	const bare = id.startsWith("ch:") ? id.slice(3) : id;
	if (!/^\d+$/.test(bare) || !work[bare]) throw new Error(`no project channel ${id}: pick one of the work channels`);
	return { target: `ch:${bare}`, name: work[bare] };
}
