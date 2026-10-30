// An OmO task worker may not end its run while a background run it started is still live (owner 2026-10-30, "구조로 막기").
// On 10-29 workers started `bun test` in a background bash session or put a watch on its log, ended with "I'll wait for the
// completion notification", and the task host marked them completed: the notification never woke them. OmO publishes every
// live wake source on the shared `pi.events` bus as `wake_source_state` {source, activeCount, items | monitors} (its Stop
// hook waits on the same signal, hooks/stop-lifecycle.js); only the sources below are runs the worker started itself. When
// the run ends with one of them live, one hidden follow-up message (the same delivery as OmO's goal continuation) asks the
// worker to wait in the foreground. An exited run leaves the snapshot, so it does not count; after MAX_REPROMPTS the end is allowed.
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";
export const MAX_REPROMPTS = 3;
const SOURCES: Record<string, string> = {
	"terminal-background-sessions": "background bash",
	"terminal-monitors": "monitor",
	"senpi-codemode": "detached eval cell",
};

export const liveReason = (what: string) =>
	`A background run you started is still live (${what}). Wait for it in the foreground with one blocking call, then finish.`;

type Host = {
	on: (name: string, fn: (event: any, ctx: any) => any) => void;
	events?: { on: (name: string, fn: (data: any) => void) => unknown };
	sendMessage: (message: any, options?: any) => unknown;
};

export function installBgGuard(pi: Host, max = MAX_REPROMPTS): void {
	if (typeof pi.events?.on !== "function") return;
	const live = new Map<string, string[]>();
	let reprompts = 0;
	pi.events.on(WAKE_SOURCE_STATE_EVENT, (data: any) => {
		const kind = SOURCES[data?.source];
		if (!kind) return;
		const entries: any[] = Array.isArray(data.items) ? data.items : Array.isArray(data.monitors) ? data.monitors : [];
		if (!(data.activeCount > 0)) live.delete(data.source);
		else live.set(data.source, entries.length ? entries.map(e => `${kind}: ${String(e?.description || e?.id || "?").slice(0, 80)}`) : [kind]);
	});
	pi.on("agent_end", (event: any) => {
		if (!live.size || event?.aborted === true || reprompts >= max) return;
		reprompts++;
		const what = [...live.values()].flat().join("; ");
		pi.sendMessage({ customType: "dotz-bg-guard", content: liveReason(what), display: false }, { triggerTurn: true, deliverAs: "followUp" });
	});
}
