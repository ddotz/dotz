import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampEffort, type Effort } from "../hub/model-effort.ts";
import { harness } from "../onboard/harness.ts";
import { type Answers, type Checked, type Prior, type RuntimeModels, validateAnswers } from "./answers.ts";

const OMP_TIMEOUT_MS = 20_000;
const RPC_FLAGS = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session", "--no-title"];

type OmpModel = { provider?: string; id?: string; kind?: string; thinking?: string[] | null };
type OmpState = { model?: { provider?: string; id?: string }; thinkingLevel?: string };

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

async function ompModels(bin: string): Promise<OmpModel[] | undefined> {
	const p = Bun.spawn([bin, "models", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: OMP_TIMEOUT_MS, killSignal: "SIGKILL" });
	const out = await new Response(p.stdout).text();
	const models = (parseJson(out) as { models?: OmpModel[] } | undefined)?.models;
	return Array.isArray(models) ? models.filter(m => m.kind === "chat") : undefined;
}

async function ompState(bin: string): Promise<OmpState | undefined> {
	const cwd = mkdtempSync(join(tmpdir(), "dotz-omp-state-"));
	const p = Bun.spawn([bin, ...RPC_FLAGS, "--cwd", cwd], { stdin: "pipe", stdout: "pipe", stderr: "ignore", timeout: OMP_TIMEOUT_MS, killSignal: "SIGKILL" });
	try {
		p.stdin.write(`${JSON.stringify({ id: "s", type: "get_state" })}\n`);
		await p.stdin.flush();
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of p.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			for (const line of buffered.split("\n")) {
				const reply = parseJson(line) as { id?: string; data?: OmpState } | undefined;
				if (reply?.id === "s") return reply.data;
			}
		}
		return undefined;
	} finally {
		p.kill();
		rmSync(cwd, { recursive: true, force: true });
	}
}

/**
 * What the runtime itself offers, so the default model is one the signed-in accounts can run. Only omp has a model list of its own: the
 * Anthropic default stays when omp lists it, else omp's own default model (what `get_state` reports for the signed-in providers) takes over.
 * Undefined for any other runtime, a missing omp, or an omp that answers nothing.
 */
export async function runtimeModels(runtime: string): Promise<RuntimeModels | undefined> {
	const h = harness(runtime);
	const bin = h?.id === "omp" ? (h.bin.includes("/") ? h.bin : Bun.which(h.bin, { PATH: process.env.PATH })) : undefined;
	if (!bin) return undefined;
	try {
		const models = await ompModels(bin);
		if (!models?.length) return undefined;
		const key = (m: { provider?: string; id?: string }) => `${m.provider}/${m.id}`;
		const available = new Set(models.map(key));
		const state = await ompState(bin);
		const current = state?.model ? models.find(m => key(m) === key(state.model!)) : undefined;
		const level = clampEffort((state?.thinkingLevel ?? "medium") as Effort, current?.thinking ?? []);
		return { available, ...(current ? { fallback: `${key(current)}:${level}` } : {}) };
	} catch {
		return undefined;
	}
}

/** validateAnswers with the models the chosen runtime offers (a runtime that lists none validates as before). */
export async function validateWithModels(a: Partial<Answers>, prior: Prior, home: string): Promise<Checked> {
	const first = validateAnswers(a, prior, home);
	if (!first.ok) return first;
	const models = await runtimeModels(first.answers.runtime);
	return models ? validateAnswers(a, prior, home, models) : first;
}
