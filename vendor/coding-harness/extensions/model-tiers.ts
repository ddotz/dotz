import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { harnessDir } from "../harness/agent-home.ts";
import { type Data, type Family, key, LADDER, type Model, plan } from "../harness/model-tiers/plan.ts";

const DATA_FILE = join(harnessDir(), "model-tiers.json");
const STATE_FILE = join(harnessDir(), "model-tiers-state.json");
const ASK_AGAIN_MS = 24 * 3600_000;
const RECHECK_MS = 120_000;

interface Ui {
	notify(text: string, level: "info" | "warning"): void;
}
interface Ctx {
	agent?: { kind?: string };
	mode?: string;
	ui?: Ui;
	modelRegistry?: { getAvailable?(): unknown };
}
interface SchemaNode {
	optional(): SchemaNode;
}
interface Schema {
	object(shape: Record<string, SchemaNode>): SchemaNode;
	enum(values: string[]): SchemaNode;
	string(): SchemaNode;
	array(item: SchemaNode): SchemaNode;
}
interface RecordSetting {
	get(scope: unknown): unknown;
	setEntry(scope: unknown, entry: string, value: string): void;
}
interface Api {
	zod: Schema;
	pi: { settings: unknown };
	setLabel?(label: string): void;
	on(event: "session_start", handler: (event: unknown, ctx: Ctx) => Promise<void>): void;
	sendMessage(message: { customType: string; display: boolean; content: string }, options: { deliverAs: "nextTurn"; triggerTurn?: boolean }): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: SchemaNode;
		execute(id: string, params: ToolParams, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<ToolResult>;
	}): void;
	registerCommand(name: string, command: { description: string; handler(args: unknown, ctx: Ctx): Promise<void> }): void;
}
interface ToolParams {
	action: "status" | "apply" | "record";
	model?: string;
	effort?: string;
	confidence?: "High" | "Medium" | "Low";
	basis?: string;
	sources?: string[];
	family?: Family;
}
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(harnessDir(), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(tmp, file);
}

function loadData(): Data | undefined {
	if (!existsSync(DATA_FILE)) return undefined;
	const data = readJson<Data | undefined>(DATA_FILE, undefined);
	return data && Array.isArray(data.families) && data.roles && data.sweetSpots ? data : undefined;
}

function levelsOf(model: unknown): string[] {
	const thinking = model && typeof model === "object" && "thinking" in model ? model.thinking : undefined;
	const raw = thinking && typeof thinking === "object" && "efforts" in thinking ? thinking.efforts : undefined;
	const list = Array.isArray(raw) ? raw.map(String).filter(level => LADDER.includes(level)) : [];
	return list.length ? list : LADDER.slice(1);
}

async function availableModels(ctx: Ctx): Promise<Model[]> {
	const list = await ctx.modelRegistry?.getAvailable?.();
	if (!Array.isArray(list)) return [];
	return list
		.map(m => {
			const row = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
			return { provider: String(row.provider ?? ""), id: String(row.id ?? ""), levels: levelsOf(m) };
		})
		.filter(m => m.provider && m.id);
}

function applyRoles(pi: Api, target: Record<string, string>): string[] {
	const handle = lookup("modelRoles") as unknown as RecordSetting | undefined;
	if (!handle) return [];
	const raw = handle.get(pi.pi.settings);
	const current = (raw && typeof raw === "object" ? raw : {}) as Record<string, string | undefined>;
	const changed: string[] = [];
	for (const [role, value] of Object.entries(target)) {
		if (current[role] === value) continue;
		handle.setEntry(pi.pi.settings, role, value);
		changed.push(`${role}: ${current[role] ?? "(unset)"} -> ${value}`);
	}
	return changed;
}

const RESEARCH_BRIEF = [
	"Find, per reasoning-effort level, an independent benchmark score and cost per task (Artificial Analysis Intelligence Index first; vendor effort docs and coding benchmarks as support).",
	"Sweet spot = the level after which the next step buys clearly less score per added cost (a plateau or a level dominated by another model at the same price); when the data is thin, use the vendor's recommended starting level and mark confidence Low.",
	"For a provider without families: decide which model lines are worker (Sonnet-class), base (Opus-class), deep (Fable-class) and light (Haiku-class), and record one family per line with a version-capturing id pattern.",
	"Record each result with the model_tiers tool (action record): model, effort, confidence, basis with the numbers, sources. Do not guess numbers.",
].join("\n");

function statusText(data: Data, models: Model[], changed: string[]): string {
	const p = plan(data, models);
	const lines = [`model-tiers (primary provider ${data.primaryProvider}; data ${DATA_FILE})`];
	for (const [tier, pick] of Object.entries(p.tiers)) {
		const spot = pick.adopted ? data.sweetSpots[key(pick.adopted)] : undefined;
		lines.push(`- ${tier}: ${pick.adopted ? `${key(pick.adopted)} sweet spot ${spot?.effort} (${spot?.confidence})` : "no researched model"}${pick.adopted && key(pick.adopted) !== key(pick.newest) ? `; newer ${key(pick.newest)} awaits research` : ""}`);
	}
	lines.push("roles:", ...Object.entries(p.roles).map(([role, value]) => `- ${role} = ${value}`));
	if (changed.length) lines.push("changed:", ...changed.map(c => `- ${c}`));
	if (p.research.length) lines.push("research needed:", ...p.research.map(r => `- ${r}`));
	return lines.join("\n");
}

/**
 * Keeps modelRoles on the newest model of each tier, at that model's benchmark sweet spot.
 * Source of truth is model-tiers.json in the harness directory of this copy:
 * `families` map provider + id pattern (capture groups are version numbers) to a tier (worker / base / deep / light),
 * `roles` map a role to a tier plus `step` levels above the sweet spot or a fixed `effort`,
 * `sweetSpots` map provider/model to a sweet-spot effort with benchmark evidence and sources.
 * On a main session start, and once more after the background catalog refresh adds model ids, the newest available model of each tier on the primary provider is chosen.
 * It is adopted only once its sweet spot is recorded; until then the newest researched generation stays and an interactive session is asked to research it, in a turn of its own so the research never rides on the user's first request.
 * Connected providers without family entries are queued the same way, so every connected provider keeps baseline values although roles use the primary provider only.
 * A model line on the primary provider that matches no family is queued for research unless `ignoredModels` names it; dated snapshot ids (-YYYYMMDD) are aliases of classified lines, not new lines.
 * Only interactive main sessions are checked: headless runs (-p, RPC, dotz lanes) often carry a --model runtime override that would read as a role change and must not start research turns.
 * The agent records findings with the model_tiers tool (action "record"), which re-applies the roles.
 */
export default function modelTiers(pi: Api) {
	const z = pi.zod;
	pi.setLabel?.("Model tiers");

	const run = async (ctx: Ctx) => {
		const data = loadData();
		if (!data) return;
		const models = await availableModels(ctx);
		if (!models.length) return;
		const p = plan(data, models);
		const changed = applyRoles(pi, p.roles);
		if (changed.length) ctx.ui?.notify(`model-tiers: roles moved to the newest researched models\n${changed.map(c => `- ${c}`).join("\n")}`, "info");
		if (!p.research.length) return;
		const state = readJson<Record<string, number>>(STATE_FILE, {});
		const now = Date.now();
		const due = p.research.filter(item => now - (state[item] ?? 0) > ASK_AGAIN_MS);
		if (!due.length) return;
		for (const item of due) state[item] = now;
		writeJson(STATE_FILE, state);
		pi.sendMessage(
			{
				customType: "model-tiers",
				display: true,
				content: `[model-tiers] Benchmark research needed before these models get default roles:\n${due.map(d => `- ${d}`).join("\n")}\n\n${RESEARCH_BRIEF}`,
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	};
	const report = (ctx: Ctx) => (error: unknown) => ctx.ui?.notify(`model-tiers: role check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind !== "main" || ctx.mode !== "tui") return;
		await run(ctx).catch(report(ctx));
		setTimeout(() => void run(ctx).catch(report(ctx)), RECHECK_MS).unref();
	});

	pi.registerTool({
		name: "model_tiers",
		label: "Model tiers",
		description:
			"Automatic model-role selection by tier (worker = Sonnet-class, base = Opus-class, deep = Fable-class, light = Haiku-class) at each model's benchmark sweet spot. action status: current picks, roles and pending research. action apply: re-apply roles now. action record: store a researched sweet spot (model = provider/id, effort, confidence, basis with numbers, sources) and/or a tier family (family = { provider, tier, pattern } with version capture groups), then re-apply.",
		parameters: z.object({
			action: z.enum(["status", "apply", "record"]),
			model: z.string().optional(),
			effort: z.string().optional(),
			confidence: z.enum(["High", "Medium", "Low"]).optional(),
			basis: z.string().optional(),
			sources: z.array(z.string()).optional(),
			family: z.object({ provider: z.string(), tier: z.string(), pattern: z.string() }).optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const fail = (text: string): ToolResult => ({ content: [{ type: "text", text: `model_tiers: ${text}` }], isError: true });
			const data = loadData();
			if (!data) return fail(`missing or invalid ${DATA_FILE}`);
			const models = await availableModels(ctx);
			if (params.action === "record") {
				if (params.family) {
					const { provider, tier, pattern } = params.family;
					if (!Object.values(data.roles).some(r => r.tier === tier)) return fail(`unknown tier ${tier}`);
					try {
						new RegExp(pattern);
					} catch (error) {
						return fail(`bad pattern: ${String(error)}`);
					}
					data.families = [...data.families.filter(f => !(f.provider === provider && f.tier === tier)), { provider, tier, pattern }];
				}
				if (params.model) {
					const model = models.find(m => key(m) === params.model);
					if (!model) return fail(`${params.model} is not an available model`);
					if (!params.effort || !model.levels.includes(params.effort)) return fail(`effort must be one of ${model.levels.join(", ")}`);
					if (!params.confidence || !params.basis || !params.sources?.length) return fail("record needs confidence, basis and sources");
					data.sweetSpots[params.model] = {
						effort: params.effort,
						confidence: params.confidence,
						basis: params.basis,
						sources: params.sources,
						checked: new Date().toISOString().slice(0, 10),
					};
				}
				if (!params.family && !params.model) return fail("record needs model and/or family");
				writeJson(DATA_FILE, data);
			}
			const changed = params.action === "status" ? [] : applyRoles(pi, plan(data, models).roles);
			return { content: [{ type: "text", text: statusText(data, models, changed) }] };
		},
	});

	pi.registerCommand("model-tiers", {
		description: "Model tiers: show picks, roles and pending research; /model-tiers apply re-applies the roles now",
		handler: async (args, ctx) => {
			const data = loadData();
			if (!data) return ctx.ui?.notify(`model-tiers: missing or invalid ${DATA_FILE}`, "warning");
			const models = await availableModels(ctx);
			const changed = String(args ?? "").trim() === "apply" ? applyRoles(pi, plan(data, models).roles) : [];
			ctx.ui?.notify(statusText(data, models, changed), "info");
		},
	});
}
