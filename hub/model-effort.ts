// The default reasoning effort of every model (its sweet spot): the effort one step below where extra effort starts costing sharply
// more for little gain. One ordered table; every place that picks an effort when none was given reads `sweetSpot`. An effort the
// owner set (config.json, a `model:high` selector, a request) is never looked up here.
// A model the table does not name still gets a value without anyone editing it: an unknown version of a known family takes the
// nearest earlier row of that family (fable-5-3 takes fable-5-2); an unknown family gets medium. Never above high.
// Evidence is on each row, read 2026-11-11. AA = Artificial Analysis leaderboard, index / cost per task.

export const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];
export type SweetSource = "table" | "family" | "default";

const TABLE: ReadonlyArray<readonly [id: string, effort: Effort]> = [
	["claude-fable-5-2", "high"], // AA 2026-11-11: high 62 / $9.08, xhigh 62 / $14.83 (+63%); vendor default high
	["claude-opus-5-5", "medium"], // AA 2026-11-11: medium 48 / $2.45, high 52 / $3.46 (+41% for +4); vendor default medium
	["claude-sonnet-5-5", "high"], // AA 2026-11-11: medium 31 / $0.78, high 42 / $1.64, xhigh 50 / $4.09 (cost per point 10% then 18.7%)
	["claude-haiku-5-5", "medium"], // vendor default medium, OmO quick chain medium; AA 2026-11-11 medium 25 / $0.09, high 30 / $0.16 (+60% time)
	["deepseek-v4.1-flash", "high"], // AA 2026-11-11: no reasoning 19, high 29 for +$0.03, max 33 for +$0.14 (+30%)
	["gpt-6-astra", "high"], // AA 2026-11-11: medium 52 / $2.73, high 55 / $3.24, xhigh 55 / $3.66; OmO deep-high uses high
	["gpt-6.1-sol", "medium"], // AA 2026-11-11: medium 46 / $0.36, high 50 / $0.59 (+64%); OmO deep-low uses medium
	["gpt-6-luna", "medium"], // AA 2026-11-11: low 10, medium 18 / $0.04, high 21 / $0.07
];

const CEILING: Effort = "high";
const FALLBACK: Effort = "medium";

/** "provider/id:effort" -> "id": the provider prefix and a trailing effort level go; a colon that belongs to the id stays. */
const bareId = (id: string): string => {
	const s = id.trim().toLowerCase();
	const i = s.lastIndexOf(":");
	const noLevel = i > 0 && (EFFORT_ORDER as readonly string[]).includes(s.slice(i + 1)) ? s.slice(0, i) : s;
	return noLevel.slice(noLevel.lastIndexOf("/") + 1);
};

const numbers = (s: string): number[] => s.split(/[-.]/).map(Number);
/** Family and version of an id: claude-<name>-5-3, gpt-6.1-<tier>, <vendor>-v4.1-<tier>. */
function familyOf(id: string): { family: string; version: number[] } | undefined {
	let m = /^claude-([a-z]+)-((?:\d{1,2}(?:-|$))+)/.exec(id);
	if (m) return { family: `claude-${m[1]}`, version: numbers(m[2].replace(/-$/, "")) };
	m = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)/.exec(id);
	if (m) return { family: `gpt-${m[2]}`, version: numbers(m[1]) };
	m = /^([a-z]+)-v(\d+(?:\.\d+)?)-([a-z]+)/.exec(id);
	if (m) return { family: `${m[1]}-${m[3]}`, version: numbers(m[2]) };
	return undefined;
}
const compare = (a: number[], b: number[]): number => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
	return 0;
};

const ROWS = TABLE.map(([id, effort]) => ({ id, effort, ...familyOf(id)! }));
const cap = (e: Effort): Effort => (EFFORT_ORDER.indexOf(e) > EFFORT_ORDER.indexOf(CEILING) ? CEILING : e);

/** OmO's clampThinkingLevel (pi-ai models.js): a level the model does not list goes to the nearest listed level above it, else the nearest below, else the first listed. */
export function clampEffort(level: Effort, supported: readonly string[]): Effort {
	const known = EFFORT_ORDER.filter(l => supported.includes(l));
	if (known.includes(level)) return level;
	const at = EFFORT_ORDER.indexOf(level);
	return known.find(l => EFFORT_ORDER.indexOf(l) > at) ?? [...known].reverse().find(l => EFFORT_ORDER.indexOf(l) < at) ?? known[0] ?? "off";
}

/** The effort to use for a model when none was given, and where it came from. `supported` (the model's own levels, when the runtime says them) clamps an unsupported level. */
export function sweetSpot(id: string, supported?: readonly string[]): { effort: Effort; source: SweetSource } {
	const bare = bareId(id);
	const exact = ROWS.find(r => bare === r.id || bare.startsWith(`${r.id}-`));
	const fam = exact ? undefined : familyOf(bare);
	const earlier = fam && ROWS.filter(r => r.family === fam.family && compare(r.version, fam.version) < 0).sort((a, b) => compare(b.version, a.version))[0];
	const found = exact ? { effort: cap(exact.effort), source: "table" as const } : earlier ? { effort: cap(earlier.effort), source: "family" as const } : { effort: FALLBACK, source: "default" as const };
	return { ...found, effort: supported ? clampEffort(found.effort, supported) : found.effort };
}
