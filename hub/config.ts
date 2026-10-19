import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const DATA_DIR = process.env.DOTZ_DIR ?? join(HOME, ".dotz");
export const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

// `language`: BCP-47-ish code of the identity's main language ("ko", "en", "ja", ...); setup writes it. See hub/i18n.ts.
export type Identity = { name: string; character?: string; tone?: string; avatar?: string; language?: string };
export type Config = {
	identity?: Identity;
	// Agent runtime of the orchestrator and the lanes unless their own section names one; see hub/runtime/index.ts.
	runtime?: string;
	discord: { token_file: string; owner_id: string; guild: string; app_id?: string };
	web: { port: number; tailscale_https_port: number; allow_logins: string[] };
	orchestrator?: { model: string; thinking: string; rotate_tokens?: number; runtime?: string };
	ui?: { origin_view?: boolean };
	lanes: { model: string; thinking: string; runtime?: string; max_active?: number; worker_model?: string; compact_at?: number; keep_recent?: number; nightly_at?: string; nightly_compact_at?: number; rotate_mb?: number; max_rss_gb?: number };
};

export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const cfg: Config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
// Model + thinking level a section of config.json selects; omp takes them as one `--model <model>:<thinking>` selector.
const DEFAULT_MODEL = { model: "anthropic/claude-opus-5-5", thinking: "medium" };
export const orchestratorModel = () => ({ model: cfg.orchestrator?.model ?? DEFAULT_MODEL.model, thinking: cfg.orchestrator?.thinking ?? DEFAULT_MODEL.thinking });
export const lanesModel = () => ({ model: cfg.lanes?.model ?? DEFAULT_MODEL.model, thinking: cfg.lanes?.thinking ?? DEFAULT_MODEL.thinking });
export const selectorOf = (m: { model: string; thinking: string }) => `${m.model}:${m.thinking}`;
// Model the lanes' task workers (implementation, tests, renders, grind) run on: a "<model>:<thinking>" selector, set per run through an omp overlay.
export const DEFAULT_WORKER_MODEL = "anthropic/claude-sonnet-5-5:high";
export const workerModel = () => cfg.lanes?.worker_model ?? DEFAULT_WORKER_MODEL;
// Lane context management: omp compacts a lane's session at `compact_at` tokens keeping the last `keep_recent`; each night
// at `nightly_at` (local time, "off" disables) idle lanes past `rotate_mb` of session file start a fresh session with a
// handover and idle lanes at `nightly_compact_at` tokens or more are compacted.
const positive = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
export const lanesCompactAt = () => positive(cfg.lanes?.compact_at, 400_000);
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
export function updateConfig(section: "orchestrator" | "lanes", values: Record<string, string>): void {
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
};

mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
mkdirSync(paths.lanes, { recursive: true });
for (const [file, text] of Object.entries(TEMPLATES)) if (!existsSync(file)) writeFileSync(file, text);
if (!existsSync(paths.hubToken)) {
	writeFileSync(paths.hubToken, randomBytes(24).toString("hex"));
	chmodSync(paths.hubToken, 0o600);
}
export const HUB_TOKEN = readFileSync(paths.hubToken, "utf8").trim();
export const now = () => new Date().toISOString();
export const log = (msg: string) => appendFileSync(paths.log, `${now()} ${msg}\n`);
