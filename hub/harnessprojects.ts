// "구성" view, 프로젝트 band (read-only): every lane that is tied to a work channel or a home channel is a project. Each one
// gets its values next to the global defaults ({ value, source, global? } per field), the instruction files found in its
// folder (name, size, mtime, first heading; never their content), its channel setup, the features and blocked commands
// that apply only there, and its own map (channels -> gateway -> orchestrator -> lane -> workers) in the node shape the
// 구성 map already draws. Nothing here writes. Logins are shown by name only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chainOf, type FallbackEntry, parseSelector, splitThinking, THINKING_LEVELS, lanesModel, workerModel } from "./config.ts";
import * as discord from "./discord.ts";
import type { HarnessEdge, HarnessNode, Setting } from "./harness.ts";
import { msg } from "./i18n.ts";
import { type Lane, laneRunning, lanes } from "./lanes.ts";
import { allWatches } from "./watch.ts";
import { listSetups, type Setup } from "./workchannels.ts";

export type Field<T> = { value: T; source: "global" | "project"; global?: T };
export type Fallback = FallbackEntry;
type Chan = { id: string; name: string; kind: "work" | "home" | "thread" };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// The project's value when it has its own and it differs; otherwise the global one (with source "global").
const field = <T,>(own: T | undefined, global: T): Field<T> => (own === undefined || same(own, global) ? { value: global, source: "global" } : { value: own, source: "project", global });

// "- deny: <regex> | <reason>" lines under "## Blocked commands" (the RULES.md format, also used in a project's instruction files).
export const denyLines = (text: string) => [...((text.split(/^## Blocked commands\s*$/m)[1]?.split(/^## /m)[0] ?? "").matchAll(/^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/gm))];

// config.json fallback entries, read with the same parser the processes use (hub/config.ts chainOf).
export const fallbackChain = (v: unknown): Fallback[] => chainOf(v);
const capText = (c: NonNullable<Fallback["cap"]>) => `${c.period} ${[c.usd ? `$${c.usd}` : "", c.tokens ? `${c.tokens} tokens` : ""].filter(Boolean).join(" / ")}`;
const chainText = (c: Fallback[]) => (c.length ? c.map(e => msg().harness.project.fallbackStep(`${e.model}${e.key_file ? " (API key)" : ""}`, e.when, e.cap ? capText(e.cap) : undefined, e.revert ? "on" : undefined)).join(" → ") : msg().harness.project.lane.none);

function channelsOf(lane: Lane): Chan[] {
	const ch = discord.channels, thread = ch.lanes[lane.name], parent = ch.homes[lane.name];
	if (parent) return [{ id: parent, name: ch.work[parent] ?? "?", kind: "home" }, ...(thread ? [{ id: thread, name: ch.threads[thread]?.name ?? lane.name, kind: "thread" as const }] : [])];
	return thread ? [{ id: thread, name: ch.work[thread] ?? lane.name, kind: "work" }] : [];
}

// ---- project folder facts ------------------------------------------------------------------------------------------
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", "CONVENTIONS.md", ".github/copilot-instructions.md"];
const FILE_CAP = 12;
export type ProjectFile = { name: string; bytes?: number; modified?: string; heading?: string; dir?: boolean };
const stat = (p: string) => { try { return statSync(p); } catch { return undefined; } };
const firstHeading = (p: string): string | undefined => {
	try { return /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(readFileSync(p, "utf8").slice(0, 4096))?.[1]?.slice(0, 80); } catch { return undefined; }
};

function projectFiles(roots: string[]): { files: ProjectFile[]; texts: { file: string; text: string }[] } {
	const files: ProjectFile[] = [], texts: { file: string; text: string }[] = [], seen = new Set<string>();
	const add = (root: string, name: string, heading: boolean) => {
		const st = stat(join(root, name));
		if (!st || seen.has(name) || files.length >= FILE_CAP) return;
		seen.add(name);
		if (st.isDirectory()) { files.push({ name: `${name}/`, dir: true }); return; }
		if (!st.isFile()) return;
		files.push({ name, bytes: st.size, modified: st.mtime.toISOString(), ...(heading ? { heading: firstHeading(join(root, name)) } : {}) });
		if (INSTRUCTIONS.includes(name) && st.size <= 200_000) texts.push({ file: name, text: readFileSync(join(root, name), "utf8") });
	};
	for (const root of roots) {
		for (const n of INSTRUCTIONS) add(root, n, true);
		let entries: string[] = [];
		try { entries = readdirSync(join(root, ".omp")).filter(n => !n.startsWith(".")).sort(); } catch {}
		for (const n of entries) add(root, `.omp/${n}`, /\.(md|mdc|txt)$/i.test(n));
	}
	return { files, texts };
}

type Feature = { kind: "skill" | "watch"; name: string; what: string };
function projectFeatures(roots: string[], channelIds: string[], setupNames: Set<string>): Feature[] {
	const T = msg().harness.project.features, out: Feature[] = [];
	for (const root of roots) for (const rel of [".omp/skills", ".claude/skills", ".agents/skills"]) {
		let dirs: string[] = [];
		try { dirs = readdirSync(join(root, rel)).filter(n => !n.startsWith(".")).sort(); } catch { continue; }
		for (const d of dirs) {
			let text: string;
			try { text = readFileSync(join(root, rel, d, "SKILL.md"), "utf8"); } catch { continue; }
			const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
			const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "") || d;
			if (!out.some(f => f.kind === "skill" && f.name === name)) out.push({ kind: "skill", name, what: (/^description:\s*(.+)$/m.exec(fm)?.[1] ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 120) });
		}
	}
	for (const w of allWatches()) {
		if (setupNames.has(w.name) || out.some(f => f.kind === "watch" && f.name === w.name)) continue;
		const there = w.channels?.some(c => channelIds.includes(c)) || (w.cwd !== undefined && roots.some(r => w.cwd === r || w.cwd!.startsWith(`${r}/`)));
		if (there) out.push({ kind: "watch", name: w.name, what: T.watchValue(w.every_minutes, w.on) });
	}
	return out.slice(0, 16);
}

// ---- the entries -----------------------------------------------------------------------------------------------------
type SetupRow = Setup & { login_health: { login: string; ok: boolean }[] };

function buildProject(lane: Lane, chans: Chan[], ctx: { disk: Record<string, any>; mName: (s: string) => string; gateway: HarnessNode; orchestrator: HarnessNode; setups: SetupRow[] }) {
	const P = msg().harness.project, H = msg().harness, { disk, mName } = ctx;
	const lm = lanesModel(), wm = parseSelector(workerModel());
	const own = splitThinking(lane.model), ownWorker = lane.workerModel ? splitThinking(lane.workerModel) : undefined;
	const runtimeGlobal = String(disk.lanes?.runtime ?? disk.runtime ?? "omo");
	const laneRuntime = "runtime" in lane && typeof lane.runtime === "string" ? lane.runtime : undefined;
	const fields = {
		model: field(own.model, lm.model),
		effort: field(own.thinking, lm.thinking),
		worker_model: field(ownWorker?.model, wm.model),
		worker_effort: field(ownWorker?.thinking, wm.thinking),
		runtime: field(laneRuntime, runtimeGlobal),
		fallback: field<Fallback[] | undefined>(undefined, fallbackChain(disk.lanes?.fallback)) as Field<Fallback[]>,
		worker_fallback: field<Fallback[] | undefined>(undefined, fallbackChain(disk.lanes?.worker_fallback)) as Field<Fallback[]>,
	};
	const overrides = Object.values(fields).filter(f => f.source === "project").length;

	const roots = [lane.cwd, ...(lane.worktree?.repo && lane.worktree.repo !== lane.cwd ? [lane.worktree.repo] : [])];
	const { files, texts } = projectFiles(roots);
	const deny = texts.flatMap(t => denyLines(t.text).slice(0, 10).map(m => ({ pattern: m[1]!, reason: m[2]!, file: t.file }))).slice(0, 20);

	const setupOf = chans.map(c => ctx.setups.find(s => s.channel === c.id)).find(Boolean);
	const setup = setupOf ? { channel: setupOf.name, purpose: setupOf.purpose, logins: setupOf.login_health.map(h => ({ name: h.login, ok: h.ok })), monitors: setupOf.monitors, standing: setupOf.standing ?? "", updated: setupOf.updated } : null;
	const features = projectFeatures(roots, chans.map(c => c.id), new Set([...(setupOf?.logins ?? []), ...(setupOf?.monitors ?? [])]));

	const status = lane.status;
	const tone: HarnessNode["status"] = ({ working: "busy", starting: "busy", idle: "ok", "rate-limited": "warn", exited: "off" } as const)[status];
	const statusText = H.status[status] ?? status;
	const channels = chans.map(c => ({ ...c, kind_text: P.channelKind[c.kind] }));
	const stamp = (t: string) => new Date(t).toLocaleString(H.locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

	// -- the project's own map
	const setting = (key: string, text: { label: string; hint?: string }, type: Setting["type"], f: Field<string>, applies: Setting["applies"], extra: Partial<Setting> = {}): Setting =>
		({ key: `lane:${lane.name}:${key}`, label: text.label, value: f.value, type, editable: true, applies, source: `lane ${lane.name}`, default: f.global ?? f.value, ...(text.hint ? { hint: text.hint } : {}), ...extra });
	const effortOptions = THINKING_LEVELS.map(v => ({ value: v, label: v }));
	const globalNode = (n: HarnessNode, extraFacts: HarnessNode["facts"] = []): HarnessNode => ({ ...n, facts: [...n.facts, ...extraFacts, { label: n.label, value: P.globalNote }], settings: [], custom: undefined, origin: undefined, fileMeta: undefined });
	const orchFallback = fallbackChain(disk.orchestrator?.fallback);

	const inputs: HarnessNode[] = chans.filter(c => c.kind !== "thread").map(c => {
		const s = ctx.setups.find(x => x.channel === c.id);
		return {
			id: `ch-${c.id}`, kind: "channel", group: "flow", label: `#${c.name}`, status: discord.status.connected ? "ok" : "off",
			summary: P.channel.summary(P.channelKind[c.kind], s?.purpose ?? ""), desc: P.channel.desc,
			facts: [{ label: P.channel.kind, value: P.channelKind[c.kind] }, ...(s ? [
				{ label: P.channel.purpose, value: s.purpose },
				...(s.logins.length ? [{ label: P.channel.logins, value: s.login_health.map(h => h.login).join(", ") }] : []),
				...(s.monitors.length ? [{ label: P.channel.monitors, value: s.monitors.join(", ") }] : []),
				...(s.standing ? [{ label: P.channel.standing, value: s.standing }] : []),
				{ label: P.channel.updated, value: stamp(s.updated) },
			] : [{ label: P.channel.purpose, value: P.channel.noSetup }])],
			settings: [],
		};
	});
	const threadChan = chans.find(c => c.kind === "thread");
	const laneNode: HarnessNode = {
		id: "p-lane", kind: "lanes", group: "flow", label: P.lane.label(lane.name), status: tone,
		summary: `${mName(fields.model.value)} · ${fields.effort.value} · ${statusText}`, desc: P.lane.desc,
		facts: [
			{ label: P.lane.state, value: statusText }, { label: P.lane.cwd, value: lane.cwd },
			...(lane.worktree ? [{ label: P.lane.repo, value: `${lane.worktree.repo} (${lane.worktree.branch})` }] : []),
			...(threadChan ? [{ label: P.lane.thread, value: threadChan.name }] : []),
			{ label: P.lane.runtime, value: fields.runtime.value }, { label: P.lane.fallback, value: chainText(fields.fallback.value) },
		],
		settings: [
			setting("model", P.settings.model, "model", fields.model, "live"),
			setting("effort", P.settings.effort, "effort", fields.effort, "live", { options: effortOptions }),
			setting("runtime", P.settings.runtime, "text", fields.runtime, "restart"),
		],
	};
	const workersNode: HarnessNode = {
		id: "p-workers", kind: "workers", group: "flow", label: P.workers.label(lane.name), status: "ok",
		summary: `${mName(fields.worker_model.value)} · ${fields.worker_effort.value}`, desc: P.workers.desc,
		facts: [{ label: P.workers.model, value: fields.worker_model.value }, { label: P.workers.effort, value: fields.worker_effort.value }, { label: P.workers.fallback, value: chainText(fields.worker_fallback.value) }],
		settings: [setting("worker_model", P.settings.workerModel, "model", fields.worker_model, "next-turn"), setting("worker_effort", P.settings.workerEffort, "effort", fields.worker_effort, "next-turn", { options: effortOptions })],
	};
	const fileNodes: HarnessNode[] = files.map((f, i) => ({
		id: `p-file-${i}`, kind: "file", group: "files", anchor: "p-lane", order: i + 1, label: f.name, status: "ok",
		summary: f.dir ? P.files.folder : `${P.files.bytes(f.bytes!.toLocaleString(H.locale))} · ${stamp(f.modified!)}`, desc: P.files.desc,
		facts: f.dir ? [{ label: P.files.folder, value: f.name }] : [{ label: P.files.size, value: P.files.bytes(f.bytes!.toLocaleString(H.locale)) }, { label: P.files.modified, value: stamp(f.modified!) }, ...(f.heading ? [{ label: P.files.heading, value: f.heading }] : [])],
		settings: [],
	}));
	const supports: HarnessNode[] = [
		...(features.length ? [{ id: "p-features", kind: "system", group: "support", anchor: "p-lane", order: 1, label: P.features.label, status: "ok", summary: P.features.summary(features.length), desc: P.features.desc, facts: features.map(f => ({ label: f.kind === "skill" ? P.features.skill : P.features.watch, value: f.what ? `${f.name} · ${f.what}` : f.name })), settings: [] } satisfies HarnessNode] : []),
		...(deny.length ? [{ id: "p-deny", kind: "system", group: "support", anchor: "p-lane", order: 2, label: P.deny.label, status: "ok", summary: P.deny.summary(deny.length), desc: P.deny.desc, facts: deny.slice(0, 8).map(d => ({ label: d.file, value: `${d.pattern} | ${d.reason}` })), settings: [] } satisfies HarnessNode] : []),
	];
	const E = H.edges;
	const edges: HarnessEdge[] = [
		...inputs.map(n => ({ from: n.id, to: "gateway", label: P.edgeIn })),
		{ from: "gateway", to: "orchestrator", label: E.batch }, { from: "orchestrator", to: "p-lane", label: E.delegate }, { from: "p-lane", to: "p-workers", label: E.parallel },
		...fileNodes.map(n => ({ from: n.id, to: "p-lane", label: P.edgeFiles })), ...supports.map(n => ({ from: n.id, to: "p-lane", label: P.edgeFeatures })),
	];
	return {
		id: lane.name, name: lane.name, status, status_text: statusText, channels, cwd: lane.cwd, ...(lane.worktree ? { repo: lane.worktree.repo, branch: lane.worktree.branch } : {}),
		fields, overrides, files, setup, features, deny,
		map: { nodes: [...inputs, globalNode(ctx.gateway), globalNode(ctx.orchestrator, orchFallback.length ? [{ label: P.lane.fallback, value: chainText(orchFallback) }] : []), laneNode, workersNode, ...fileNodes, ...supports], edges },
	};
}

// Lanes run from a scratch folder (/tmp test projects) are not the owner's projects, and an ended lane (laneRunning, the
// process half of the laneLive rule every lane list uses) leaves the band; its data stays on disk and in the lanes tab's '종료된 레인' fold.
const scratch = (p: string | undefined) => !!p && /^\/(private\/)?tmp(\/|$)/.test(p);

export function harnessProjects(ctx: { disk: Record<string, any>; mName: (s: string) => string; gateway: HarnessNode; orchestrator: HarnessNode }) {
	const setups = listSetups();
	return [...lanes.values()].filter(lane => laneRunning(lane) && !scratch(lane.cwd) && !scratch(lane.worktree?.repo)).flatMap(lane => {
		const chans = channelsOf(lane);
		return chans.length ? [buildProject(lane, chans, { ...ctx, setups })] : [];
	}).sort((a, b) => a.name.localeCompare(b.name));
}
