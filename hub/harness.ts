// "구성" view backend (read-only): the harness as a graph (inbound channels -> gateway -> orchestrator -> lanes -> workers,
// plus the support systems), built at runtime from the live process state and ~/.dotz, with the whitelist of config.json
// keys and the prompt files the owner can ask the orchestrator to change. This module writes nothing: edits are requests
// the web UI sends to the main orchestrator. Secrets, Discord ids, ports and the allowed-login list are shown as
// "설정됨"/counts only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runningSubagents } from "./activity.ts";
import { cfg, CONFIG_FILE, DATA_DIR, IDENTITY_FILE, NAME, orchestratorModel, lanesModel, parseSelector, paths, THINKING_LEVELS, uiOriginView, workerModel } from "./config.ts";
import { kTokens, percentOf } from "./context.ts";
import * as discord from "./discord.ts";
import { modeFile, lang, msg } from "./i18n.ts";
import { lanes, WORKER_SLOTS } from "./lanes.ts";
import { orch } from "./orchestrator.ts";
import { availableModels, ControlError, type ModelInfo, quota } from "./providers.ts";
import { listSchedules } from "./schedule.ts";
import { listSetups } from "./workchannels.ts";
import { allWatches } from "./watch.ts";

export type Applies = "live" | "restart" | "next-turn";
type SettingType = "text" | "number" | "bool" | "select" | "model" | "effort";
export type Setting = {
	key: string;
	label: string;
	value: string | number | boolean;
	type: SettingType;
	options?: { value: string; label: string }[];
	editable: boolean;
	applies: Applies;
	source: string;
	default?: string | number | boolean;
	hint?: string;
	unit?: string;
	min?: number;
	max?: number;
	multiline?: boolean;
	pending?: boolean;
};
export type HarnessNode = {
	id: string;
	kind: "channel" | "gateway" | "orchestrator" | "lanes" | "workers" | "file" | "system";
	group: "flow" | "files" | "support";
	anchor?: string;
	order?: number;
	label: string;
	summary: string;
	desc: string;
	status?: "ok" | "busy" | "warn" | "err" | "off";
	facts: { label: string; value: string }[];
	settings: Setting[];
	file?: string;
	fileEditable?: boolean;
	// only with `ui.origin_view`: which side the node belongs to, the settings whose value differs from their default, and a personal file's size/mtime
	origin?: "shipped" | "personal";
	custom?: { key: string; label: string; value: string | number | boolean; default: string | number | boolean; unit?: string }[];
	fileMeta?: { bytes: number; modified?: string };
};
export type HarnessEdge = { from: string; to: string; label: string };

// ---- editable config keys ----------------------------------------------------------------------------------------
// Defaults mirror the module that owns each key (the comment names it); the owner's values live in config.json only.
type Def = {
	type: SettingType;
	applies: Applies;
	default?: string | number | boolean;
	options?: string[]; // option values; their labels, like the setting's label/hint/unit, are in the i18n catalog (harness.settings)
	min?: number;
	max?: number;
	multiline?: boolean;
	mirror?: boolean; // the owner module reads cfg per use (a changed value needs no restart); false = read once at start
	source?: string;
};

const EFFORT_OPTIONS = THINKING_LEVELS.map(v => ({ value: v, label: v }));

const DEFS = new Map<string, Def>([
	["orchestrator.model", { type: "model", applies: "live", mirror: true }],
	["orchestrator.thinking", { type: "effort", applies: "live", mirror: true }],
	// orchestrator.ts ROTATE_TOKENS
	["orchestrator.rotate_tokens", { type: "number", applies: "restart", default: 150_000, min: 20_000, max: 1_000_000 }],
	["lanes.model", { type: "model", applies: "next-turn", mirror: true }],
	["lanes.thinking", { type: "effort", applies: "next-turn", mirror: true }],
	// lanes.ts MAX_ACTIVE
	["lanes.max_active", { type: "number", applies: "restart", default: 4, min: 1, max: 16 }],
	// config.ts lanesCompactAt / lanesKeepRecent (read when a lane process starts)
	["lanes.compact_at", { type: "number", applies: "next-turn", mirror: true, default: 400_000, min: 50_000, max: 2_000_000 }],
	["lanes.keep_recent", { type: "number", applies: "next-turn", mirror: true, default: 40_000, min: 5_000, max: 400_000 }],
	["lanes.worker_model", { type: "model", applies: "next-turn", mirror: true }],
	["lanes.worker_effort", { type: "effort", applies: "next-turn", mirror: true, source: "config.json:lanes.worker_model" }],
	// config.ts lanesNightlyAt (hygiene.ts arms its timer at start)
	["lanes.nightly_at", { type: "text", applies: "restart", default: "04:30" }],
	["lanes.nightly_compact_at", { type: "number", applies: "live", mirror: true, default: 300_000, min: 50_000, max: 2_000_000 }],
	["lanes.rotate_mb", { type: "number", applies: "live", mirror: true, default: 50, min: 5, max: 1000 }],
	// memguard.ts reads the limit on every check, but only starts its timer when it is above 0 at start
	["lanes.max_rss_gb", { type: "number", applies: "restart", default: 8, min: 1, max: 128 }],
	// main.ts COALESCE_MS
	["gateway.coalesce_ms", { type: "number", applies: "restart", default: 4000, min: 0, max: 20_000 }],
	// reflect.ts / token-audit.ts / update.ts
	["reflect_at", { type: "text", applies: "restart", default: "04:40" }],
	["token_audit_at", { type: "text", applies: "restart", default: "04:30" }],
	["omp_update.mode", { type: "select", applies: "restart", default: "check", options: ["check", "install", "off"] }],
	["omp_update.at", { type: "text", applies: "restart", default: "04:20" }],
	// reflect.ts reads backup.remote on every snapshot
	["backup.remote", { type: "text", applies: "live", mirror: true, default: "" }],
	// outlang.ts
	["output_language.mode", { type: "select", applies: "live", mirror: true, default: "rewrite", options: ["rewrite", "off"] }],
	["output_language.model", { type: "text", applies: "live", mirror: true, default: "" }],
	["output_language.timeout_s", { type: "number", applies: "live", mirror: true, default: 30, min: 5, max: 300 }],
	// zele.ts
	["zele.enabled", { type: "bool", applies: "restart", default: true }],
	["zele.poll_sec", { type: "number", applies: "restart", default: 120, min: 60, max: 3600 }],
	["zele.brief_hour", { type: "number", applies: "restart", default: 8, min: 0, max: 23 }],
	["identity.name", { type: "text", applies: "restart" }],
	["identity.language", { type: "text", applies: "live", mirror: true, default: "" }],
	["identity.character", { type: "text", applies: "next-turn", mirror: true, multiline: true }],
	["identity.tone", { type: "text", applies: "next-turn", mirror: true, multiline: true }],
]);

// ---- config.json access ------------------------------------------------------------------------------------------
// The keys this view reads from disk; everything else in config.json passes through untouched.
type Disk = {
	identity?: { name?: string };
	discord?: { token_file?: string; owner_id?: string; guild?: string };
	web?: { port?: number; tailscale_https_port?: number; allow_logins?: string[] };
	lanes?: { max_active?: number; compact_at?: number; nightly_at?: string; max_rss_gb?: number };
	gateway?: { coalesce_ms?: number };
	zele?: { enabled?: boolean; poll_sec?: number; brief_hour?: number };
	omp_update?: { mode?: string; at?: string };
	output_language?: string | { mode?: string };
	backup?: { remote?: string };
	reflect_at?: string;
	token_audit_at?: string;
};
type Tree = Record<string, unknown>;
const readDisk = (): Disk => JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Disk;
const STARTED: Tree = JSON.parse(JSON.stringify(cfg)) as Tree; // what this process was started with
const getPath = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Tree)[k] : undefined), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// output_language may be a bare string ("off"); address it as { mode } for reading.
const outLang = (o: Tree): Tree => (typeof o.output_language === "string" ? { ...o, output_language: { mode: o.output_language } } : o);
const modeOf = (d: Disk) => (typeof d.output_language === "string" ? d.output_language : d.output_language?.mode);

function effective(path: string, disk: Disk): unknown {
	switch (path) {
		case "orchestrator.model": return orchestratorModel().model;
		case "orchestrator.thinking": return orchestratorModel().thinking;
		case "lanes.model": return lanesModel().model;
		case "lanes.thinking": return lanesModel().thinking;
		case "lanes.worker_model": return parseSelector(workerModel()).model;
		case "lanes.worker_effort": return parseSelector(workerModel()).thinking;
		case "identity.name": return disk.identity?.name ?? NAME;
	}
	return getPath(outLang(disk as Tree), path) ?? DEFS.get(path)?.default;
}

function settingOf(path: string, disk: Disk, over: Partial<Setting> = {}): Setting {
	const d = DEFS.get(path)!;
	const t = msg().harness.settings[path]!;
	const value = effective(path, disk);
	const startedValue = getPath(outLang(STARTED), path);
	const stored = getPath(outLang(disk as Tree), path);
	return {
		key: path,
		label: t.label,
		value: (value ?? "") as string | number | boolean,
		type: d.type,
		...(d.type === "effort" ? { options: EFFORT_OPTIONS } : d.options ? { options: d.options.map(v => ({ value: v, label: t.options?.[v] ?? v })) } : {}),
		editable: true,
		applies: d.applies,
		source: d.source ?? `config.json:${path}`,
		...(d.default !== undefined ? { default: d.default } : {}),
		...(t.hint ? { hint: t.hint } : {}),
		...(t.unit ? { unit: t.unit } : {}),
		...(d.min !== undefined ? { min: d.min } : {}),
		...(d.max !== undefined ? { max: d.max } : {}),
		...(d.multiline ? { multiline: true } : {}),
		...(d.applies === "restart" && !d.mirror && !same(stored, startedValue) ? { pending: true } : {}),
		...over,
	};
}

// ---- prompt files ------------------------------------------------------------------------------------------------
type FileDef = { path: () => string; editable: boolean; cap?: number; applies: Applies }; // label and note: i18n catalog, harness.files
const FILES: Record<string, FileDef> = {
	"MODE.md": { path: modeFile, editable: false, applies: "next-turn" },
	"RULES.md": { path: () => paths.rules, editable: true, cap: 12_000, applies: "next-turn" },
	"LESSONS.md": { path: () => paths.lessons, editable: true, cap: 3_000, applies: "next-turn" },
	"identity/IDENTITY.md": { path: () => IDENTITY_FILE, editable: true, cap: 3_000, applies: "next-turn" },
};

function fileDef(name: string): FileDef {
	const d = FILES[name === "IDENTITY.md" ? "identity/IDENTITY.md" : name];
	if (!d) throw new ControlError(msg().harness.notOpenable(name), 404);
	return d;
}
const denyLines = (text: string) => [...((text.split(/^## Blocked commands\s*$/m)[1]?.split(/^## /m)[0] ?? "").matchAll(/^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/gm))];

export function readHarnessFile(name: string) {
	const d = fileDef(name);
	const text = msg().harness.files[name === "IDENTITY.md" ? "identity/IDENTITY.md" : name]!;
	const file = d.path();
	const exists = existsSync(file);
	const st = exists ? statSync(file) : undefined;
	return { name, label: text.label, path: file, text: exists ? readFileSync(file, "utf8") : "", exists, editable: d.editable, bytes: st?.size ?? 0, modified: st?.mtime.toISOString(), applies: d.applies, note: text.note, cap: d.cap };
}

// ---- the graph ---------------------------------------------------------------------------------------------------
const sleep = <T,>(ms: number, v: T) => new Promise<T>(res => setTimeout(() => res(v), ms));
function ago(ms: number): string {
	const a = msg().harness.ago;
	const m = Math.round(ms / 60_000);
	return m < 1 ? a.now : m < 60 ? a.min(m) : m < 48 * 60 ? a.hourMin(Math.floor(m / 60), m % 60) : a.day(Math.round(m / 1440));
}
const fileFact = (name: string): { label: string; value: string }[] => {
	const h = msg().harness, t = h.fileFact;
	const f = fileDef(name).path();
	if (!existsSync(f)) return [{ label: t.label, value: t.missing }];
	const st = statSync(f);
	return [{ label: t.size, value: t.chars(readFileSync(f, "utf8").length.toLocaleString(h.locale)) }, { label: t.modified, value: h.ago.before(ago(Date.now() - st.mtimeMs)) }];
};
const timeOr = (v: unknown, dflt: string) => { const c = msg().harness.common; return String(v ?? dflt) === "off" ? c.off : c.daily(String(v ?? dflt)); };

// `ui.origin_view`: prompt files the owner wrote and the omp extension installed under ~/.omp are personal; MODE and the gateway's own systems ship with dotz.
const PERSONAL_NODES: Record<string, true> = { rules: true, lessons: true, identity: true, guard: true };
function markOrigin(nodes: HarnessNode[]): void {
	for (const n of nodes) {
		n.origin = PERSONAL_NODES[n.id] ? "personal" : "shipped";
		n.custom = n.settings.filter(s => s.editable && s.default !== undefined && !same(s.value, s.default)).map(s => ({ key: s.key, label: s.label, value: s.value, default: s.default!, ...(s.unit ? { unit: s.unit } : {}) }));
		if (n.origin === "personal" && n.file) {
			const f = fileDef(n.file).path();
			if (existsSync(f)) {
				const st = statSync(f);
				n.fileMeta = { bytes: readFileSync(f, "utf8").length, modified: st.mtime.toISOString() };
			}
		}
	}
}

export async function harnessGraph(opts: { terminals?: number; light?: boolean } = {}) {
	const disk = readDisk();
	const models = opts.light ? ([] as ModelInfo[]) : await Promise.race([availableModels().catch((): ModelInfo[] => []), sleep(2500, [] as ModelInfo[])]);
	const mName = (sel: string) => models.find(m => m.selector === sel)?.name ?? (sel.split("/").pop() ?? sel);
	const om = orchestratorModel(), lm = lanesModel(), wm = parseSelector(workerModel());
	const S = (p: string, over: Partial<Setting> = {}) => settingOf(p, disk, over);
	const ro = (key: string, label: string, value: string | number, source: string, extra: Partial<Setting> = {}): Setting => ({ key, label, value, type: "text", editable: false, applies: "restart", source, ...extra });
	const T = msg().harness, N = T.nodes, c = T.common, E = T.edges;
	const stamp = (t: number | string) => new Date(t).toLocaleString(T.locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

	// -- live state
	const dStat = discord.status;
	const laneList = [...lanes.values()];
	const aliveLanes = laneList.filter(l => l.status !== "exited");
	const working = laneList.filter(l => l.status === "working" || l.status === "starting").length;
	const schedules = listSchedules();
	const watches = allWatches();
	const failing = watches.filter(w => w.state.fails >= 2).length;
	const setups = listSetups();
	const maxActive = typeof disk.lanes?.max_active === "number" ? disk.lanes.max_active : 4;
	const guardFile = join(homedir(), ".omp", "agent", "extensions", "orchestrator-guard.ts");
	const guardOn = existsSync(guardFile);
	const rules = existsSync(paths.rules) ? readFileSync(paths.rules, "utf8") : "";
	const subagents = ["orchestrator", ...laneList.map(l => `lane:${l.name}`)].reduce((n, s) => n + runningSubagents(s), 0);
	const zeleOn = disk.zele?.enabled !== false;
	const nextSchedule = schedules.map(s => Date.parse(s.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
	const orchTone: HarnessNode["status"] = ({ idle: "ok", working: "busy", starting: "busy", "rate-limited": "warn", stopped: "err" } as const)[orch.status];

	// -- provider quota (one 2.5 s try; the usage call finishes in the background and the next refresh has it)
	const q = opts.light ? undefined : await Promise.race([quota().catch(() => undefined), sleep(2500, undefined)]);
	const used = [...new Set([om.model, lm.model, wm.model].map(m => m.split("/")[0]))];
	const limits = (q?.providers ?? []).filter(p => used.includes(p.provider)).flatMap(p => p.limits.filter(l => l.limit && l.remaining != null).map(l => ({ p: p.provider, label: l.label, pct: Math.round((l.remaining! / l.limit!) * 100) })));
	const low = limits.length ? Math.min(...limits.map(l => l.pct)) : undefined;

	const nodes: HarnessNode[] = [
		// ---- inbound
		{
			id: "discord", kind: "channel", group: "flow", label: "Discord", status: !dStat.enabled ? "off" : dStat.connected ? "ok" : "err",
			summary: !dStat.enabled ? c.disabled : dStat.connected ? N.discord.summary.connected(Object.keys(discord.channels.work).length) : N.discord.summary.disconnected,
			desc: N.discord.desc,
			facts: [{ label: c.state, value: !dStat.enabled ? N.discord.state.off : dStat.connected ? N.discord.state.connected : N.discord.state.disconnected(dStat.error?.slice(0, 80) ?? "") }, { label: N.discord.workChannels, value: c.count(Object.keys(discord.channels.work).length) }, { label: N.discord.laneThreads, value: c.count(Object.keys(discord.channels.lanes ?? {}).length) }],
			settings: [ro("discord.token_file", N.discord.token, disk.discord?.token_file ? c.set : c.none, "config.json:discord.token_file"), ro("discord.owner_id", N.discord.owner, disk.discord?.owner_id ? c.set : c.none, "config.json:discord.owner_id"), ro("discord.guild", N.discord.guild, disk.discord?.guild ? c.set : c.none, "config.json:discord.guild")],
		},
		{
			id: "web", kind: "channel", group: "flow", label: N.web.label, status: "ok", summary: N.web.summary,
			desc: N.web.desc,
			facts: [{ label: N.web.access, value: N.web.accessValue }, { label: N.web.sending, value: N.web.sendingValue }],
			settings: [ro("web.port", N.web.port, String(disk.web?.port ?? 7420), "config.json:web.port"), ro("web.tailscale_https_port", N.web.tailscalePort, String(disk.web?.tailscale_https_port ?? ""), "config.json:web.tailscale_https_port"), ro("web.allow_logins", N.web.logins, N.web.loginCount((disk.web?.allow_logins ?? []).length), "config.json:web.allow_logins")],
		},
		{
			id: "terminal", kind: "channel", group: "flow", label: N.terminal.label, status: opts.terminals ? "ok" : "off", summary: opts.terminals ? N.terminal.summary(opts.terminals) : N.terminal.none,
			desc: N.terminal.desc(NAME),
			facts: [{ label: N.terminal.connected, value: c.count(opts.terminals ?? 0) }], settings: [],
		},
		{
			id: "schedule", kind: "channel", group: "flow", label: N.schedule.label, status: "ok",
			summary: schedules.length ? N.schedule.summary(schedules.length, nextSchedule ? N.schedule.next(ago(Math.abs(nextSchedule - Date.now())), nextSchedule > Date.now()) : "") : N.schedule.none,
			desc: N.schedule.desc,
			facts: [{ label: N.schedule.schedules, value: c.count(schedules.length) }, ...(nextSchedule ? [{ label: N.schedule.nextRun, value: stamp(nextSchedule) }] : []), { label: N.schedule.repeating, value: c.count(schedules.filter(s => s.every_minutes).length) }], settings: [],
		},
		{
			id: "watch", kind: "channel", group: "flow", label: N.watch.label, status: failing ? "warn" : watches.length ? "ok" : "off", summary: watches.length ? N.watch.summary(watches.length, failing) : N.watch.none,
			desc: N.watch.desc,
			facts: [{ label: N.watch.watches, value: c.count(watches.length) }, { label: N.watch.setups, value: c.count(setups.length) }, { label: N.watch.failing, value: c.count(failing) }], settings: [],
		},
		{
			id: "mail", kind: "channel", group: "flow", label: N.mail.label, status: zeleOn ? "ok" : "off", summary: zeleOn ? N.mail.summary(disk.zele?.poll_sec ?? 120, disk.zele?.brief_hour ?? 8) : c.disabled,
			desc: N.mail.desc,
			facts: [{ label: c.state, value: zeleOn ? N.mail.on : c.off }],
			settings: [S("zele.enabled"), S("zele.poll_sec"), S("zele.brief_hour")],
		},
		// ---- gateway
		{
			id: "gateway", kind: "gateway", group: "flow", label: N.gateway.label, status: "ok", summary: N.gateway.summary,
			desc: N.gateway.desc,
			facts: [{ label: N.gateway.merge, value: N.gateway.mergeValue(disk.gateway?.coalesce_ms ?? 4000) }, { label: N.gateway.direct, value: N.gateway.directValue }, { label: N.gateway.route, value: N.gateway.routeValue }, { label: N.gateway.restart, value: N.gateway.restartValue }],
			settings: [S("gateway.coalesce_ms")],
		},
		// ---- orchestrator
		{
			id: "orchestrator", kind: "orchestrator", group: "flow", label: N.orchestrator.label(NAME), status: orchTone,
			summary: `${mName(om.model)} · ${om.thinking} · ${T.status[orch.status] ?? orch.status}`,
			desc: N.orchestrator.desc,
			facts: [
				{ label: c.state, value: T.status[orch.status] ?? orch.status },
				{ label: N.orchestrator.context, value: orch.ctx.window ? `${kTokens(orch.ctx.tokens)} / ${kTokens(orch.ctx.window)} (${percentOf(orch.ctx) ?? 0}%)` : orch.ctx.tokens ? kTokens(orch.ctx.tokens) : "-" },
				...(orch.status === "rate-limited" && orch.rateLimitedUntil ? [{ label: N.orchestrator.resumes, value: stamp(orch.rateLimitedUntil) }] : []),
				{ label: N.orchestrator.cache, value: N.orchestrator.cacheValue },
				{ label: N.orchestrator.startPrompt, value: N.orchestrator.startPromptValue },
			],
			settings: [S("orchestrator.model"), S("orchestrator.thinking"), S("orchestrator.rotate_tokens")],
		},
		// ---- prompt files
		{ id: "mode", kind: "file", group: "files", anchor: "orchestrator", order: 1, label: N.mode.label, status: existsSync(modeFile()) ? "ok" : "err", summary: N.mode.summary(modeFile().split("/").pop() ?? ""), desc: N.mode.desc, facts: [{ label: N.mode.file, value: modeFile().split("/").pop() ?? "" }, { label: N.mode.language, value: lang() }], settings: [], file: "MODE.md", fileEditable: false },
		{ id: "identity", kind: "file", group: "files", anchor: "orchestrator", order: 2, label: N.identity.label, status: existsSync(IDENTITY_FILE) ? "ok" : "warn", summary: N.identity.summary(NAME, lang()), desc: N.identity.desc, facts: fileFact("identity/IDENTITY.md"), settings: [S("identity.name"), S("identity.language"), S("identity.character"), S("identity.tone")], file: "identity/IDENTITY.md", fileEditable: true },
		{ id: "rules", kind: "file", group: "files", anchor: "orchestrator", order: 3, label: N.rules.label, status: "ok", summary: N.rules.summary(denyLines(rules).length), desc: N.rules.desc, facts: [...fileFact("RULES.md"), { label: N.rules.blocked, value: c.count(denyLines(rules).length) }], settings: [], file: "RULES.md", fileEditable: true },
		{ id: "lessons", kind: "file", group: "files", anchor: "orchestrator", order: 4, label: N.lessons.label, status: "ok", summary: N.lessons.summary, desc: N.lessons.desc, facts: fileFact("LESSONS.md"), settings: [], file: "LESSONS.md", fileEditable: true },
		// ---- lanes
		{
			id: "lanes", kind: "lanes", group: "flow", label: N.lanes.label, status: working ? "busy" : aliveLanes.length ? "ok" : "off",
			summary: aliveLanes.length ? N.lanes.summary(aliveLanes.length, working, maxActive) : N.lanes.none(maxActive),
			desc: N.lanes.desc,
			facts: [{ label: N.lanes.lanes, value: N.lanes.lanesValue(aliveLanes.length, working) }, ...aliveLanes.slice(0, 8).map(l => ({ label: l.name, value: `${mName(l.model)} · ${T.status[l.status] ?? l.status}` })), { label: N.lanes.workDir, value: N.lanes.workDirValue }, { label: N.lanes.compaction, value: N.lanes.compactionValue((disk.lanes?.compact_at ?? 400_000).toLocaleString(T.locale)) }],
			settings: [S("lanes.model"), S("lanes.thinking"), S("lanes.max_active"), S("lanes.compact_at"), S("lanes.keep_recent")],
		},
		// ---- workers
		{
			id: "workers", kind: "workers", group: "flow", label: N.workers.label, status: subagents ? "busy" : "ok", summary: `${mName(workerModel().replace(/:[a-z]+$/, ""))} · ${wm.thinking}${subagents ? N.workers.running(subagents) : ""}`,
			desc: N.workers.desc,
			facts: [{ label: N.workers.kinds, value: N.workers.kindsValue }, { label: N.workers.limit, value: N.workers.limitValue(WORKER_SLOTS) }, { label: N.workers.runningFact, value: c.count(subagents) }, { label: N.workers.isolation, value: N.workers.isolationValue }, { label: N.workers.expensive, value: N.workers.expensiveValue }],
			settings: [S("lanes.worker_model"), S("lanes.worker_effort")],
		},
		// ---- support: around the gateway
		{ id: "outlang", kind: "system", group: "support", anchor: "gateway", order: 1, label: N.outlang.label, status: modeOf(disk) === "off" ? "off" : "ok", summary: modeOf(disk) === "off" ? c.disabled : N.outlang.summary(lang()), desc: N.outlang.desc, facts: [{ label: N.outlang.reference, value: lang() }], settings: [S("output_language.mode"), S("output_language.model"), S("output_language.timeout_s")] },
		{ id: "update", kind: "system", group: "support", anchor: "gateway", order: 2, label: N.update.label, status: disk.omp_update?.mode === "off" || disk.omp_update?.at === "off" ? "off" : "ok", summary: disk.omp_update?.mode === "off" ? c.disabled : `${timeOr(disk.omp_update?.at, "04:20")} · ${N.update[disk.omp_update?.mode === "install" ? "install" : "check"]}`, desc: N.update.desc, facts: [], settings: [S("omp_update.mode"), S("omp_update.at")] },
		{ id: "audit", kind: "system", group: "support", anchor: "gateway", order: 3, label: N.audit.label, status: String(disk.token_audit_at ?? "04:30") === "off" ? "off" : "ok", summary: timeOr(disk.token_audit_at, "04:30"), desc: N.audit.desc, facts: [], settings: [S("token_audit_at")] },
		{ id: "reflect", kind: "system", group: "support", anchor: "gateway", order: 4, label: N.reflect.label, status: String(disk.reflect_at ?? "04:40") === "off" ? "off" : "ok", summary: N.reflect.summary(timeOr(disk.reflect_at, "04:40")), desc: N.reflect.desc, facts: [], settings: [S("reflect_at")] },
		{ id: "backup", kind: "system", group: "support", anchor: "reflect", order: 1, label: N.backup.label, status: disk.backup?.remote ? "ok" : "off", summary: disk.backup?.remote ? N.backup.remote : N.backup.local, desc: N.backup.desc, facts: [{ label: N.backup.external, value: disk.backup?.remote ? c.set : c.none }], settings: [S("backup.remote", disk.backup?.remote && /\/\/[^/@\s]+@/.test(String(disk.backup.remote)) ? { value: N.backup.credentialed, editable: false, hint: N.backup.credentialedHint } : {})] },
		// ---- support: orchestrator column
		{ id: "providers", kind: "system", group: "support", anchor: "orchestrator", order: 5, label: N.providers.label, status: low === undefined ? "ok" : low <= 10 ? "err" : low <= 30 ? "warn" : "ok", summary: N.providers.summary(used.length, low), desc: N.providers.desc, facts: [{ label: N.providers.used, value: used.join(", ") }, ...limits.slice(0, 6).map(l => ({ label: `${l.p} ${l.label}`, value: N.providers.remaining(l.pct) }))], settings: [] },
		// ---- support: lanes column
		{ id: "hygiene", kind: "system", group: "support", anchor: "lanes", order: 1, label: N.hygiene.label, status: String(disk.lanes?.nightly_at ?? "04:30") === "off" ? "off" : "ok", summary: N.hygiene.summary(timeOr(disk.lanes?.nightly_at, "04:30")), desc: N.hygiene.desc, facts: [], settings: [S("lanes.nightly_at"), S("lanes.nightly_compact_at"), S("lanes.rotate_mb")] },
		{ id: "memguard", kind: "system", group: "support", anchor: "lanes", order: 2, label: N.memguard.label, status: (disk.lanes?.max_rss_gb ?? 8) === 0 ? "off" : "ok", summary: (disk.lanes?.max_rss_gb ?? 8) === 0 ? c.disabled : N.memguard.summary(disk.lanes?.max_rss_gb ?? 8), desc: N.memguard.desc, facts: [], settings: [S("lanes.max_rss_gb")] },
		// ---- support: workers column
		{
			id: "guard", kind: "system", group: "support", anchor: "workers", order: 1, label: N.guard.label, status: guardOn ? "ok" : "warn", summary: guardOn ? N.guard.summary : N.guard.missing,
			desc: N.guard.desc,
			facts: [
				{ label: c.state, value: guardOn ? N.guard.installed : N.guard.notInstalled },
				{ label: N.guard.briefing, value: N.guard.briefingValue },
				{ label: N.guard.patch, value: N.guard.patchValue },
				{ label: N.guard.budget, value: N.guard.budgetValue },
				{ label: N.guard.expensive, value: N.guard.expensiveValue },
				{ label: N.guard.external, value: N.guard.externalValue },
				{ label: N.guard.context, value: N.guard.contextValue },
				{ label: N.guard.blocked, value: c.count(denyLines(rules).length) },
			], settings: [],
		},
	];
	const edges: HarnessEdge[] = [
		{ from: "discord", to: "gateway", label: E.discord },
		{ from: "web", to: "gateway", label: E.web },
		{ from: "terminal", to: "gateway", label: E.terminal },
		{ from: "schedule", to: "gateway", label: E.schedule },
		{ from: "watch", to: "gateway", label: E.watch },
		{ from: "mail", to: "gateway", label: E.mail },
		{ from: "gateway", to: "orchestrator", label: E.batch },
		{ from: "orchestrator", to: "lanes", label: E.delegate },
		{ from: "lanes", to: "workers", label: E.parallel },
		{ from: "mode", to: "orchestrator", label: E.mode },
		{ from: "identity", to: "orchestrator", label: E.identity },
		{ from: "rules", to: "orchestrator", label: E.rules },
		{ from: "rules", to: "lanes", label: E.rulesLanes },
		{ from: "lessons", to: "orchestrator", label: E.lessons },
		{ from: "reflect", to: "lessons", label: E.lessonsWrite },
		{ from: "reflect", to: "backup", label: E.snapshot },
		{ from: "reflect", to: "orchestrator", label: E.review },
		{ from: "outlang", to: "gateway", label: E.outlang },
		{ from: "update", to: "gateway", label: E.update },
		{ from: "audit", to: "gateway", label: E.audit },
		{ from: "providers", to: "orchestrator", label: E.providers },
		{ from: "providers", to: "lanes", label: E.budget },
		{ from: "hygiene", to: "lanes", label: E.hygiene },
		{ from: "memguard", to: "lanes", label: E.memguard },
		{ from: "memguard", to: "orchestrator", label: E.memguard },
		{ from: "guard", to: "workers", label: E.guard },
	];
	const originView = uiOriginView();
	if (originView) markOrigin(nodes);
	return { generated: new Date().toISOString(), name: NAME, nodes, edges, ...(originView ? { origin_view: true, data_dir: DATA_DIR.startsWith(`${homedir()}/`) ? `~${DATA_DIR.slice(homedir().length)}` : DATA_DIR } : {}) };
}
