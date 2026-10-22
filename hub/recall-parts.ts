// Pure pieces of the orchestrator's recall prompt (the first message of a session, which the runtime keeps through every compaction).

export const STATE_CAP = 2500;

type OpenTask = { id?: unknown; what?: unknown; next?: unknown; lane?: unknown };

// state.json as a compact listing: one line per open task, the other top-level keys by name only, cut at a line
// boundary under `max` characters with a marker that names the file. Not a JSON object: the old raw slice.
export function renderState(raw: string, path: string, max = STATE_CAP): string {
	let state: unknown;
	try {
		state = JSON.parse(raw);
	} catch {
		return raw.slice(0, 4000);
	}
	if (!state || typeof state !== "object" || Array.isArray(state)) return raw.slice(0, 4000);
	const { open_tasks: tasks, ...rest } = state as Record<string, unknown>;
	const lines: string[] = [];
	if (Array.isArray(tasks)) {
		lines.push("open_tasks:");
		for (const t of tasks as OpenTask[]) {
			const task = t && typeof t === "object" ? t : {};
			const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
			lines.push(`- ${text(task.id)}: ${text(task.what)}${task.next ? ` (next: ${text(task.next)})` : ""}${task.lane ? ` [lane: ${text(task.lane)}]` : ""}`);
		}
	}
	const others = Object.keys(rest);
	if (others.length) lines.push(`other keys: ${others.join(", ")}`);
	const text = lines.join("\n");
	if (text.length <= max) return text;
	const marker = `[... cut at ${max} characters; read ${path} for the rest]`;
	const room = max - marker.length - 1;
	const cut = text.slice(0, Math.max(0, room));
	const end = cut.lastIndexOf("\n");
	return `${end >= 0 ? cut.slice(0, end) : ""}\n${marker}`;
}

// MODE.md without one `## ` section: from the heading that starts with `heading` to the next `## ` heading (or the end).
export function dropSection(mode: string, heading: string): string {
	const lines = mode.split("\n");
	const from = lines.findIndex(l => l.startsWith(heading));
	if (from < 0) return mode;
	let to = lines.findIndex((l, i) => i > from && l.startsWith("## "));
	if (to < 0) to = lines.length;
	return [...lines.slice(0, from), ...lines.slice(to)].join("\n");
}
