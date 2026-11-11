// What the owner named with @ in the web composer (web/js/14-slash-commands.js): something that runs now, a background worker
// (task), a session (lane) or a conversation with a session of its own (conv). The message carries {kind, id, label} per pick; the
// turn reads one [지칭] line per item, resolved against the live state here, so "이거 멈춰" maps to one id.
export type Ref = { kind: "task" | "lane" | "conv"; id: string; label: string };
export type RefWorld = {
	task: (id: string) => { description?: string; status: string; folder?: string } | undefined;
	lane: (name: string) => { title?: string; status: string; cwd?: string } | undefined;
	conv: (key: string) => { name?: string; live: boolean } | undefined;
};

const MAX_REFS = 10;
const flat = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);

export function ownerRefs(input: unknown): Ref[] {
	if (!Array.isArray(input)) return [];
	const out: Ref[] = [];
	for (const raw of input) {
		if (out.length >= MAX_REFS) break;
		const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const kind = r.kind === "task" || r.kind === "lane" || r.kind === "conv" ? r.kind : undefined;
		const id = flat(r.id, 120);
		if (!kind || !id || out.some(x => x.kind === kind && x.id === id)) continue;
		out.push({ kind, id, label: flat(r.label, 120) || id });
	}
	return out;
}

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
export function refLines(refs: Ref[], w: RefWorld): string[] {
	return refs.map(r => {
		const head = `[지칭] @${r.label} = ${r.kind} ${r.id}`;
		if (r.kind === "task") {
			const t = w.task(r.id);
			return t ? `${head} ${q(t.description || r.label)} (${t.status}${t.folder ? `, folder ${t.folder}` : ""})` : `${head} (not in the work list now)`;
		}
		if (r.kind === "lane") {
			const l = w.lane(r.id);
			return l ? `${head} ${q(l.title || r.id)} (${l.status}${l.cwd ? `, cwd ${l.cwd}` : ""})` : `${head} (no such session now)`;
		}
		const c = w.conv(r.id);
		return c ? `${head} ${q(c.name || r.label)} (${c.live ? "session running" : "no session"})` : `${head} (no such conversation now)`;
	});
}
