import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { harnessDir } from "../harness/agent-home.ts";
import { say } from "../harness/notice.ts";
import { showReport } from "../harness/gate/show-report.ts";
import { type Data, key, LADDER, type Model, resolveRoles } from "../harness/model-tiers/plan.ts";

const DATA_FILE = join(harnessDir(), "model-tiers.json");
const STATE_FILE = join(harnessDir(), "model-tiers-state.json");
const APPLIED_FILE = join(harnessDir(), "model-tiers-applied.json");
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
	sendMessage(message: { customType: string; display: boolean; content: string; excludeFromContext?: boolean }, options?: { deliverAs: "nextTurn"; triggerTurn?: boolean }): void;
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
	return data && data.roles && data.sweetSpots ? data : undefined;
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

type RoleResult = { changed: string[]; userSet: string[]; research: string[] };

function claim(pi: Api, data: Data, models: Model[]) {
	const handle = lookup("modelRoles") as unknown as RecordSetting | undefined;
	if (!handle) return undefined;
	const raw = handle.get(pi.pi.settings);
	const current = (raw && typeof raw === "object" ? raw : {}) as Record<string, string | undefined>;
	const applied = readJson<Record<string, string>>(APPLIED_FILE, {});
	return { handle, current, applied, ...resolveRoles({ data, current, applied, models }) };
}

function inspectRoles(pi: Api, data: Data, models: Model[]): RoleResult {
	const c = claim(pi, data, models);
	return { changed: [], userSet: c?.userSet.map(role => `${role} = ${c.current[role]}`) ?? [], research: c?.research ?? [] };
}

function applyRoles(pi: Api, data: Data, models: Model[]): RoleResult {
	const c = claim(pi, data, models);
	if (!c) return { changed: [], userSet: [], research: [] };
	const changed: string[] = [];
	for (const [role, value] of Object.entries(c.set)) {
		if (c.current[role] === value) continue;
		c.handle.setEntry(pi.pi.settings, role, value);
		changed.push(`${role}: ${c.current[role] ?? "(unset)"} -> ${value}`);
	}
	writeJson(APPLIED_FILE, { ...c.applied, ...c.set });
	return { changed, userSet: c.userSet.map(role => `${role} = ${c.current[role]}`), research: c.research };
}

const RESEARCH_BRIEF = [
	"Find, per reasoning-effort level, an independent benchmark score and cost per task (Artificial Analysis Intelligence Index first; vendor effort docs and coding benchmarks as support).",
	"Sweet spot = the level after which the next step buys clearly less score per added cost (a plateau or a level dominated by another model at the same price); when the data is thin, use the vendor's recommended starting level and mark confidence Low.",
	"Record each result with the model_tiers tool (action record): model, effort, confidence, basis with the numbers, sources. Do not guess numbers.",
].join("\n");

const cell = (text: string): string => text.replaceAll("|", "\\|");
const labelled = (label: string, items: string[]): string[] => (items.length ? ["", `**${label}**`, "", ...items.map(item => `- ${item}`)] : []);

function statusMarkdown(pi: Api, data: Data, roles: RoleResult, display = false): string {
	const t = (n: { en: string; ko: string }) => (display ? say(n) : n.en);
	const handle = lookup("modelRoles") as unknown as RecordSetting | undefined;
	const raw = handle?.get(pi.pi.settings);
	const current = (raw && typeof raw === "object" ? raw : {}) as Record<string, string | undefined>;
	const rows = Object.entries(data.roles).map(([role, spec]) => {
		const rule = "above" in spec ? t({ en: `next gaining level above ${spec.above}`, ko: `${spec.above}보다 한 단계 위 (점수가 오르는 수준)` }) : spec.effort ? t({ en: `fixed ${spec.effort}`, ko: `${spec.effort} 고정` }) : "sweet spot";
		return `| ${cell(role)} | ${cell(current[role] ?? t({ en: "(unset)", ko: "(미설정)" }))} | ${cell(rule)} |`;
	});
	return [
		t({ en: `Data \`${DATA_FILE}\``, ko: `데이터 \`${DATA_FILE}\`` }),
		"",
		`| ${t({ en: "role", ko: "역할" })} | ${t({ en: "current", ko: "현재 설정" })} | ${t({ en: "rule", ko: "규칙" })} |`,
		"| --- | --- | --- |",
		...rows,
		...labelled(t({ en: "changed", ko: "변경됨" }), roles.changed),
		...labelled(t({ en: "level set by the user, left alone (pick the model again to hand the level back)", ko: "사용자가 직접 정한 effort라 건드리지 않음 (모델을 다시 고르면 자동 관리로 돌아감)" }), roles.userSet),
		...labelled(t({ en: "research needed", ko: "조사 필요" }), roles.research),
	].join("\n");
}

/**
 * Keeps the effort level of each modelRoles entry at its model's benchmark sweet spot; the user picks the models.
 * Source of truth is model-tiers.json in the harness directory of this copy:
 * `roles` map a role to its rule: the sweet spot of the model the user set (or a fixed `effort`), or `above` another role (that role's model at the next level whose benchmark index gains),
 * `sweetSpots` map provider/model to a sweet-spot effort with benchmark evidence, sources and per-level points.
 * The policy in harness/model-tiers/plan.ts (`resolveRoles`) decides; the values it wrote last are kept in model-tiers-applied.json so a level the user changed by hand stays.
 * A role whose model has no recorded sweet spot keeps its value, and an interactive session is asked to research the model in a turn of its own so the research never rides on the user's first request.
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
		const { changed, research } = applyRoles(pi, data, models);
		if (changed.length)
			showReport(pi, ctx, { title: say({ en: "model-tiers: role levels moved to the models' sweet spots", ko: "model-tiers: 역할 effort를 모델별 sweet spot에 맞췄습니다" }), markdown: changed.map(c => `- ${c}`).join("\n"), level: "info" });
		if (!research.length) return;
		const state = readJson<Record<string, number>>(STATE_FILE, {});
		const now = Date.now();
		const due = research.filter(item => now - (state[item] ?? 0) > ASK_AGAIN_MS);
		if (!due.length) return;
		for (const item of due) state[item] = now;
		writeJson(STATE_FILE, state);
		pi.sendMessage(
			{
				customType: "model-tiers",
				display: true,
				content: `[model-tiers] Benchmark research needed for the models these roles use:\n${due.map(d => `- ${d}`).join("\n")}\n\n${RESEARCH_BRIEF}`,
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	};
	const report = (ctx: Ctx) => (error: unknown) => ctx.ui?.notify(say({ en: `model-tiers: role check failed: ${error instanceof Error ? error.message : String(error)}`, ko: `model-tiers: 역할 점검에 실패했습니다: ${error instanceof Error ? error.message : String(error)}` }), "warning");

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind !== "main" || ctx.mode !== "tui") return;
		await run(ctx).catch(report(ctx));
		setTimeout(() => void run(ctx).catch(report(ctx)), RECHECK_MS).unref();
	});

	pi.registerTool({
		name: "model_tiers",
		label: "Model tiers",
		description:
			"Effort levels for the models the user picked in modelRoles, at each model's benchmark sweet spot (slow and deep run one gaining level above default and plan). action status: roles, user-set levels and pending research. action apply: re-apply the levels now. action record: store a researched sweet spot (model = provider/id, effort, confidence, basis with numbers, sources), then re-apply.",
		parameters: z.object({
			action: z.enum(["status", "apply", "record"]),
			model: z.string().optional(),
			effort: z.string().optional(),
			confidence: z.enum(["High", "Medium", "Low"]).optional(),
			basis: z.string().optional(),
			sources: z.array(z.string()).optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const fail = (text: string): ToolResult => ({ content: [{ type: "text", text: `model_tiers: ${text}` }], isError: true });
			const data = loadData();
			if (!data) return fail(`missing or invalid ${DATA_FILE}`);
			const models = await availableModels(ctx);
			if (params.action === "record") {
				if (!params.model) return fail("record needs model");
				const model = models.find(m => key(m) === params.model);
				if (!model) return fail(`${params.model} is not an available model`);
				if (!params.effort || !model.levels.includes(params.effort)) return fail(`effort must be one of ${model.levels.join(", ")}`);
				if (!params.confidence || !params.basis || !params.sources?.length) return fail("record needs confidence, basis and sources");
				data.sweetSpots[params.model] = {
					effort: params.effort,
					confidence: params.confidence,
					basis: params.basis,
					sources: params.sources,
					...(data.sweetSpots[params.model]?.points ? { points: data.sweetSpots[params.model].points } : {}),
					checked: new Date().toISOString().slice(0, 10),
				};
				writeJson(DATA_FILE, data);
			}
			const roles = params.action === "status" ? inspectRoles(pi, data, models) : applyRoles(pi, data, models);
			return { content: [{ type: "text", text: `model-tiers\n\n${statusMarkdown(pi, data, roles)}` }] };
		},
	});

	pi.registerCommand("model-tiers", {
		description: "Model tiers: show role levels, user-set levels and pending research; /model-tiers apply re-applies the levels now",
		handler: async (args, ctx) => {
			const data = loadData();
			if (!data) return ctx.ui?.notify(say({ en: `model-tiers: missing or invalid ${DATA_FILE}`, ko: `model-tiers: ${DATA_FILE} 파일이 없거나 올바르지 않습니다` }), "warning");
			const models = await availableModels(ctx);
			const roles = String(args ?? "").trim() === "apply" ? applyRoles(pi, data, models) : inspectRoles(pi, data, models);
			showReport(pi, ctx, { title: "model-tiers", markdown: statusMarkdown(pi, data, roles, true), level: "info" });
		},
	});
}
