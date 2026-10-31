// Elements the owner picked in the web preview (click on a page element) and sent with a message. The message carries
// them next to the text and uploads; the agent reads one [picked N] line per element in the inbox prompt.
export type Picked = { n: number; tag: string; sel: string; text: string; html: string; view: string; title: string };

const MAX_ITEMS = 20;
const LIMITS = { tag: 40, sel: 300, text: 200, html: 600, view: 200, title: 120 } as const;

const flat = (v: unknown, max: number): string =>
	(typeof v === "string" || typeof v === "number" ? String(v) : "").replace(/\s+/g, " ").trim().slice(0, max);

export function ownerElements(input: unknown): Picked[] {
	if (!Array.isArray(input)) return [];
	const out: Picked[] = [];
	for (const raw of input) {
		if (out.length >= MAX_ITEMS) break;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const r = raw as Record<string, unknown>;
		const sel = flat(r.sel, LIMITS.sel);
		const text = flat(r.text, LIMITS.text);
		if (!sel && !text) continue;
		const n = typeof r.n === "number" && Number.isInteger(r.n) && r.n > 0 ? r.n : out.length + 1;
		out.push({
			n,
			tag: flat(r.tag, LIMITS.tag),
			sel,
			text,
			html: flat(r.html, LIMITS.html),
			view: flat(r.view, LIMITS.view),
			title: flat(r.title, LIMITS.title),
		});
	}
	return out;
}

export const pickedLines = (els: Picked[]): string =>
	els
		.map(e => [`[picked ${e.n}] ${e.view}${e.title ? ` (${e.title})` : ""}`, `${e.tag} ${e.sel}`.trim(), e.text ? `"${e.text}"` : "", e.html ? `html: ${e.html}` : ""].filter(Boolean).join(" | "))
		.join("\n");
