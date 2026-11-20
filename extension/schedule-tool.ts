// dotz_schedule add: every new schedule says whose it is (hub/schedule.ts ScheduleKind). Imports nothing from hub/ (the extension->hub edge ceiling).

const KINDS = ["owner", "task", "check"];

/** The refusal for an add without a name or a valid kind, or undefined when the call may go on. */
export function scheduleAddRefusal(p: { action?: string; kind?: unknown; name?: unknown }): string | undefined {
	if (p.action !== "add") return undefined;
	const named = typeof p.name === "string" && p.name.trim() !== "", kinded = KINDS.includes(p.kind as string);
	if (named && kinded) return undefined;
	return `Not added: ${[named ? "" : "name", kinded ? "" : "kind"].filter(Boolean).join(" and ")} required. name: a short title in the owner's language (up to 40 characters) saying what it is, not when. kind="owner": a reminder, the text is words to pass on to the owner at that time (it rings). kind="task": work for you, an instruction you carry out at that time (a report, a lookup, a command); the owner hears your result. kind="check": your own system check or follow-up (quiet: a plain answer stays one worklog line, and only an answer starting with [ask] or [fail] reaches the owner; checks fall on a :00/:30 grid and those due together are one turn). Add again with both set.`;
}
