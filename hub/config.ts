import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const DATA_DIR = process.env.DOTZ_DIR ?? join(HOME, ".dotz");
export const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

// `language`: BCP-47-ish code of the identity's main language ("ko", "en", "ja", ...); setup writes it. See hub/i18n.ts.
// `address` (what the bot calls the owner) and `timezone` (IANA name for every time shown to the owner) are per install too.
export type Identity = { name: string; character?: string; tone?: string; avatar?: string; language?: string; address?: string; notices?: string; timezone?: string };
export type Config = {
	identity?: Identity;
	// Agent runtime of the orchestrator and the lanes unless their own section names one; see hub/runtime/index.ts.
	runtime?: string;
	// Extra hosts an API-key fallback entry's base_url may point at (https only); the providers' own API hosts are always allowed.
	key_hosts?: string[];
	discord: { token_file: string; owner_id: string; guild: string; app_id?: string; category?: string; work_category?: string };
	web: { port: number; tailscale_https_port: number; allow_logins: string[] };
	orchestrator?: { rotate_tokens?: number; runtime?: string };
	ui?: { origin_view?: boolean };
	lanes: { runtime?: string; max_active?: number; compact_at?: number; keep_recent?: number; nightly_at?: string; nightly_compact_at?: number; rotate_mb?: number; max_rss_gb?: number };
	// Model choice and fallback order, one block per target (the web 모델 · 폴백 screen edits exactly this).
	models?: ModelsConfig;
};
// One target's model, thinking level and ordered fallback chain: the orchestrator, the lanes (default of every lane) and the
// lanes' task workers. Missing values take the defaults below.
export type TargetModels = { model?: string; thinking?: string; fallback?: Array<string | FallbackEntry> };
export type ModelsConfig = Partial<Record<FallbackTarget, TargetModels>>;

export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
// Before 2026-10-20 the model settings were spread over orchestrator.{model,thinking,fallback} and lanes.{model,thinking,
// fallback,worker_model,worker_fallback}. Moves those keys into `models` (a value already in `models` wins) and reports
// whether anything moved; every other key stays where it is.
const LEGACY: Array<[FallbackTarget, "orchestrator" | "lanes", string, "model" | "thinking" | "fallback" | "selector"]> = [
	["orchestrator", "orchestrator", "model", "model"],
	["orchestrator", "orchestrator", "thinking", "thinking"],
	["orchestrator", "orchestrator", "fallback", "fallback"],
	["lanes", "lanes", "model", "model"],
	["lanes", "lanes", "thinking", "thinking"],
	["lanes", "lanes", "fallback", "fallback"],
	["workers", "lanes", "worker_model", "selector"],
	["workers", "lanes", "worker_fallback", "fallback"],
];
export function migrateModels(disk: Record<string, any>): boolean {
	const models: ModelsConfig = disk.models && typeof disk.models === "object" && !Array.isArray(disk.models) ? disk.models : {};
	let moved = false;
	for (const [target, section, key, as] of LEGACY) {
		const sec = disk[section];
		if (!sec || typeof sec !== "object" || !(key in sec)) continue;
		const v = sec[key];
		delete sec[key];
		moved = true;
		if (v == null || v === "") continue;
		const t = (models[target] ??= {});
		if (as === "selector") {
			const s = splitThinking(String(v));
			t.model ??= s.model;
			if (s.thinking) t.thinking ??= s.thinking;
		} else if (t[as] === undefined) (t as Record<string, unknown>)[as] = v;
	}
	if (moved) disk.models = models;
	return moved;
}
// Reads config.json, moving legacy model keys into `models` first; the file as it was is kept next to it
// (config.json.bak-models-<time>) before the migrated one replaces it.
function loadConfig(): Config {
	const text = readFileSync(CONFIG_FILE, "utf8");
	const disk = JSON.parse(text);
	if (migrateModels(disk)) {
		writeFileSync(`${CONFIG_FILE}.bak-models-${new Date().toISOString().replace(/[:.]/g, "-")}`, text, { mode: 0o600 });
		writeAtomic(CONFIG_FILE, `${JSON.stringify(disk, null, 2)}\n`);
	}
	return disk;
}
export const cfg: Config = loadConfig();
// Model + thinking level a section of config.json selects; omp takes them as one `--model <model>:<thinking>` selector.
const DEFAULT_MODEL = { model: "anthropic/claude-opus-5-5", thinking: "medium" };
const targetOf = (t: FallbackTarget): TargetModels => cfg.models?.[t] ?? {};
export const orchestratorModel = () => ({ model: targetOf("orchestrator").model ?? DEFAULT_MODEL.model, thinking: targetOf("orchestrator").thinking ?? DEFAULT_MODEL.thinking });
export const lanesModel = () => ({ model: targetOf("lanes").model ?? DEFAULT_MODEL.model, thinking: targetOf("lanes").thinking ?? DEFAULT_MODEL.thinking });
export const selectorOf = (m: { model: string; thinking: string }) => `${m.model}:${m.thinking}`;
// Model the lanes' task workers (implementation, tests, renders, grind) run on: a "<model>:<thinking>" selector, set per run through an omp overlay.
export const DEFAULT_WORKER_MODEL = "anthropic/claude-sonnet-5-5:high";
export function workerModel(): string {
	const w = targetOf("workers"), d = splitThinking(DEFAULT_WORKER_MODEL);
	const model = w.model ?? d.model, thinking = w.thinking ?? (w.model ? undefined : d.thinking);
	return thinking ? `${model}:${thinking}` : model;
}
// Model fallback chains: entries tried in order after the primary fails at request time. One chain per layer: the
// orchestrator, the lanes (every lane's own model) and the lanes' task workers. They apply the next time a process starts.
// An entry is a model selector ("<provider>/<id>[:<thinking>]") or an object with conditions (hub/fallback.ts owns them):
//   when     "any" (default) | "quota" (the previous entry hit a usage limit) | "error" (a provider error)
//   cap      stop using the entry once it spent that much in the period (KST month/day); usd and/or tokens
//   revert   go back to an earlier entry when its limit resets
//   key_file name of a file under <data dir>/secrets/ with an API key: the same model billed through that key
//   base_url / api  override of the key provider's endpoint (default: the provider's own API)
export type FallbackEntry = { model: string; when?: "quota" | "error"; cap?: { period: "month" | "day"; usd?: number; tokens?: number }; revert?: boolean; key_file?: string; base_url?: string; api?: string };
export type FallbackTarget = "orchestrator" | "lanes" | "workers";
export const FALLBACK_MAX = 6;
const positiveNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
export function entryOf(x: unknown): FallbackEntry | undefined {
	const o = typeof x === "string" ? { model: x } : x && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
	const model = typeof o?.model === "string" ? o.model.trim() : "";
	if (!o || !model) return undefined;
	const cap = o.cap && typeof o.cap === "object" ? (o.cap as Record<string, unknown>) : undefined;
	const usd = positiveNumber(cap?.usd);
	const tokens = positiveNumber(cap?.tokens);
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	return {
		model,
		...(o.when === "quota" || o.when === "error" ? { when: o.when } : {}),
		...(cap && (usd || tokens) ? { cap: { period: cap.period === "day" ? ("day" as const) : ("month" as const), ...(usd ? { usd } : {}), ...(tokens ? { tokens } : {}) } } : {}),
		...(o.revert === true || o.revert === false ? { revert: o.revert } : {}),
		...(str(o.key_file) ? { key_file: str(o.key_file) } : {}),
		...(str(o.base_url) ? { base_url: str(o.base_url) } : {}),
		...(str(o.api) ? { api: str(o.api) } : {}),
	};
}
// Same model through the same key counts once.
export const entryId = (e: FallbackEntry) => `${e.model}|${e.key_file ?? ""}`;
export function chainOf(v: unknown): FallbackEntry[] {
	const seen = new Set<string>();
	const out: FallbackEntry[] = [];
	for (const x of Array.isArray(v) ? v : []) {
		const e = entryOf(x);
		if (e && !seen.has(entryId(e))) {
			seen.add(entryId(e));
			out.push(e);
		}
	}
	return out.slice(0, FALLBACK_MAX);
}
export const fallbackChain = (target: FallbackTarget): FallbackEntry[] => chainOf(targetOf(target).fallback);
// An entry omp can walk by itself: a bare model, no condition, cap, key or revert.
// `revert: false` (stay on this entry once used) is a setting too, so such an entry is not plain.
export const isPlain = (e: FallbackEntry) => !e.when && !e.cap && e.revert === undefined && !e.key_file;
// The entries a process starts with: the stored ones without the primary itself (an entry equal to the primary model would
// only retry the model that just failed, unless it is that model through its own key).
export const chainAfter = (primary: string, chain: FallbackEntry[]): FallbackEntry[] => chain.filter(e => e.key_file || (e.model !== primary && parseSelector(e.model).model !== parseSelector(primary).model));
// Stored form: bare selector strings for plain entries, objects for the rest.
const storedOf = (e: FallbackEntry): string | FallbackEntry => (isPlain(e) && !e.base_url && !e.api ? e.model : e);
export function setFallbackChain(target: FallbackTarget, chain: FallbackEntry[]): void {
	updateModels(target, { fallback: chainOf(chain).map(storedOf) });
}
// Edits one target's block of `models` in config.json (re-read from disk, legacy keys moved first) and mirrors it into `cfg`.
export function updateModels(target: FallbackTarget, values: TargetModels): void {
	const disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	migrateModels(disk);
	disk.models = { ...disk.models, [target]: { ...disk.models?.[target], ...values } };
	writeAtomic(CONFIG_FILE, `${JSON.stringify(disk, null, 2)}\n`);
	cfg.models = { ...cfg.models, [target]: { ...cfg.models?.[target], ...values } };
}
// Lane context management: omp compacts a lane's session at `compact_at` tokens keeping the last `keep_recent`; each night
// at `nightly_at` (local time, "off" disables) idle lanes past `rotate_mb` of session file start a fresh session with a
// handover and idle lanes at `nightly_compact_at` tokens or more are compacted.
const positive = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
// Owner value 2026-10-20 (was 400K); the 구성 page shows this default when config.json leaves it unset.
export const LANES_COMPACT_AT = 300_000;
export const lanesCompactAt = () => positive(cfg.lanes?.compact_at, LANES_COMPACT_AT);
export const lanesNightlyCompactAt = () => positive(cfg.lanes?.nightly_compact_at, 300_000);
export const lanesKeepRecent = () => positive(cfg.lanes?.keep_recent, 40_000);
export const lanesRotateMb = () => positive(cfg.lanes?.rotate_mb, 50);
export const lanesNightlyAt = () => String(cfg.lanes?.nightly_at ?? "04:30");
// RSS limit of one agent process (orchestrator or lane, task workers included) before the memory guard restarts it; 0 turns the guard off.
export const lanesMaxRssGb = () => (typeof cfg.lanes?.max_rss_gb === "number" && cfg.lanes.max_rss_gb >= 0 ? cfg.lanes.max_rss_gb : 8);
// `ui.origin_view` (default false): the 구성 view marks what the owner changed against what ships with dotz, and its requests carry a
// 범위 (개인/배포) line. Off, the view shows no such distinction. Read once at start like the other cfg flags.
export const uiOriginView = () => cfg.ui?.origin_view === true;
// Splits "<model>:<thinking>" at the last colon when the suffix is a thinking level (model ids may contain colons).
export function parseSelector(selector: string): { model: string; thinking: string } {
	const i = selector.lastIndexOf(":");
	const tail = selector.slice(i + 1);
	return i > 0 && (THINKING_LEVELS as readonly string[]).includes(tail) ? { model: selector.slice(0, i), thinking: tail } : { model: selector, thinking: DEFAULT_MODEL.thinking };
}
// "<model>[:<thinking>]" typed as one argument: the thinking level when the suffix is one, else just the model.
export function splitThinking(input: string): { model: string; thinking?: string } {
	const i = input.lastIndexOf(":");
	return i > 0 && (THINKING_LEVELS as readonly string[]).includes(input.slice(i + 1)) ? { model: input.slice(0, i), thinking: input.slice(i + 1) } : { model: input };
}
// Overwrites a state file all-or-nothing: the text goes to a sibling temp file, then rename() swaps it in (same directory,
// so the rename is atomic). A crash or a second writer never leaves a half-written file behind.
export function writeAtomic(file: string, text: string, mode?: number): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
	renameSync(tmp, file);
}
// Edits config.json (re-read from disk so keys this process never parsed survive) and mirrors the change into `cfg`.
export function updateConfig(section: "orchestrator" | "lanes", values: Record<string, unknown>): void {
	const disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	disk[section] = { ...disk[section], ...values };
	writeAtomic(CONFIG_FILE, `${JSON.stringify(disk, null, 2)}\n`);
	(cfg as any)[section] = { ...(cfg as any)[section], ...values };
}
// Selects the agent runtime for the given roles (`orchestrator.runtime` / `lanes.runtime`), keeping every other key of config.json.
export function setRuntime(roles: ("orchestrator" | "lanes")[], runtime: string): void {
	const disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	for (const role of roles) {
		disk[role] = { ...disk[role], runtime };
		(cfg as any)[role] = { ...(cfg as any)[role], runtime };
	}
	writeAtomic(CONFIG_FILE, `${JSON.stringify(disk, null, 2)}\n`);
}
// The bot's name (onboarding asks for it); every user-facing string and Discord name derives from it.
export const NAME = cfg.identity?.name?.trim() || "dotz";
export const IDENTITY_FILE = join(DATA_DIR, "identity", "IDENTITY.md");
// The owner's clock: identity.timezone, else this machine's zone. Times shown to the owner use it; tzLabel() is its short name.
export const TZ = cfg.identity?.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const tzLabel = () => (TZ === "Asia/Seoul" ? "KST" : TZ);
// What the bot calls the owner (identity.address); empty = no title.
export const ADDRESS = cfg.identity?.address?.trim() ?? "";
export const PORT = Number(process.env.DOTZ_PORT ?? cfg.web?.port ?? 7420);
export const OMP = process.env.DOTZ_OMP ?? "omp";
export const paths = {
	inbox: join(DATA_DIR, "inbox.jsonl"),
	outbox: join(DATA_DIR, "outbox.jsonl"),
	log: join(DATA_DIR, "hub.log"),
	channels: join(DATA_DIR, "channels.json"),
	lanes: join(DATA_DIR, "lanes"),
	hubToken: join(DATA_DIR, "secrets", "hub-token"),
	pid: join(DATA_DIR, "hub.pid"),
	schedules: join(DATA_DIR, "schedules.json"),
	watches: join(DATA_DIR, "watches.json"),
	setups: join(DATA_DIR, "channel-setups.json"),
	rules: join(DATA_DIR, "RULES.md"),
	lessons: join(DATA_DIR, "LESSONS.md"),
	// Owner memory (modeled on 오모냥's human card / boundaries / observations): owner.md and boundaries.md go into the
	// orchestrator's start prompt, observations.md only into the nightly reflection.
	memory: join(DATA_DIR, "memory"),
	owner: join(DATA_DIR, "memory", "owner.md"),
	boundaries: join(DATA_DIR, "memory", "boundaries.md"),
	observations: join(DATA_DIR, "memory", "observations.md"),
	laneHygiene: join(DATA_DIR, "lane-hygiene.json"),
};

export const TEMPLATES: Record<string, string> = {
	[paths.rules]: `# Owner rules

Standing rules and prohibitions from the owner, one short line each (this file is read every session). The bot adds one
the moment the owner states it and changes or removes one only when the owner says so; the owner's own words go to
RULES.history.md. They override MODE.md defaults and lessons, and lanes read this file too.

## Rules

## Blocked commands
Shell commands refused before they run (orchestrator, lanes and their workers). One per line, the reason after the
last " | " (spaces around the bar; a bar inside the regex has none): \`- deny: <regex> | <reason>\`
- deny: (^|[\\s;&|(])agent-discord\\s | messages go out only as the bot (bot token), never with the owner's user token
`,
	[paths.lessons]: `# Lessons

Self-learned notes from the nightly reflection, dated, at most ~30 lines; outdated or duplicate ones are removed.
Owner rules win over these.
`,
	[paths.owner]: `# Owner

Durable preferences and context about the owner, read every session. Only what the owner said or did here, never a
guess and never about other people: \`- [YYYY-MM-DD] <fact> <!-- src: <message id or file> -->\`.
`,
	[paths.boundaries]: `# Boundaries

What the owner told me not to do, in their own words, added only when they say it:
\`- [YYYY-MM-DD] "<their words>" (<what it covers>) <!-- src: <message id or file> -->\`. Their current instruction wins.
`,
	[paths.observations]: `# Observations

How my work landed with the owner, one sourced line each (not in prompts; the nightly reflection reads them):
\`- [YYYY-MM-DD] cond: <situation> | reaction: "<their words>" (<src>) | next: <what to do differently>\`.
Lines older than 90 days are dropped; a pattern seen twice moves to owner.md or LESSONS.md.
`,
};

mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
mkdirSync(paths.memory, { recursive: true });
mkdirSync(paths.lanes, { recursive: true });
for (const [file, text] of Object.entries(TEMPLATES)) if (!existsSync(file)) writeFileSync(file, text);
if (!existsSync(paths.hubToken)) {
	writeFileSync(paths.hubToken, randomBytes(24).toString("hex"));
	chmodSync(paths.hubToken, 0o600);
}
export const HUB_TOKEN = readFileSync(paths.hubToken, "utf8").trim();
export const now = () => new Date().toISOString();
export const log = (msg: string) => appendFileSync(paths.log, `${now()} ${msg}\n`);
