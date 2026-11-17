import { readFileSync, statSync } from "node:fs";
import type { SubagentFile } from "./activity.ts";

/** The fields of a worker record bgwork.ts reads, in OmO's words: omp's subagents are mapped onto them, so one mapping (toWork) serves both runtimes. */
export type OmpRec = {
	task_id: string;
	omp: true;
	name: string;
	source?: string;
	status: "running" | "completed" | "failed" | "cancelled";
	created_at: string;
	started_at: string;
	updated_at: string;
	terminal_at?: string;
	description?: string;
	resolved_model?: { model_id: string; reasoning_effort?: string };
	final_response?: string;
};

/** The worker the owner stopped, as the session that runs it is told. */
export type StoppedWork = { id: string; name: string; description: string };

const STATUS = { running: "running", done: "completed", failed: "failed", aborted: "cancelled" } as const;
const OUTPUT_CHARS = 100_000;
const OUTPUT_KEPT = 64;
const outputs = new Map<string, { stamp: string; text: string }>();

const iso = (ms: number) => new Date(ms).toISOString();

function outputOf(transcript: string | undefined): string | undefined {
	if (!transcript?.endsWith(".jsonl")) return undefined;
	const file = `${transcript.slice(0, -".jsonl".length)}.md`;
	try {
		const { mtimeMs, size } = statSync(file);
		const stamp = `${mtimeMs}:${size}`;
		let hit = outputs.get(file);
		if (hit?.stamp !== stamp) {
			if (outputs.size >= OUTPUT_KEPT) outputs.delete(outputs.keys().next().value!);
			hit = { stamp, text: readFileSync(file, "utf8").slice(0, OUTPUT_CHARS) };
			outputs.set(file, hit);
		}
		return hit.text;
	} catch {
		return undefined;
	}
}

function modelOf(s: SubagentFile): OmpRec["resolved_model"] {
	if (!s.model) return undefined;
	const [id = "", level] = s.model.replace(/@[^:]*/, "").split(":");
	const effort = s.thinking ?? level;
	return { model_id: id, ...(effort ? { reasoning_effort: effort } : {}) };
}

/** omp keeps no task store: a worker's record is built from the subagent its process reports in frames and from the output file it left (`<id>.md` beside its `<id>.jsonl`). The list is in memory, so a gateway restart starts it empty. */
export const ompRecs = (subagents: readonly SubagentFile[], source?: string): OmpRec[] =>
	subagents.map(s => {
		const model = modelOf(s);
		const report = s.status === "done" ? outputOf(s.transcript) : undefined;
		const name = s.name ?? s.id;
		return {
			task_id: s.id,
			omp: true,
			name,
			...(source ? { source } : {}),
			status: STATUS[s.status],
			created_at: iso(s.started_at),
			started_at: iso(s.started_at),
			updated_at: iso(s.updated_at),
			...(s.status === "running" ? {} : { terminal_at: iso(s.updated_at) }),
			description: s.description || name,
			...(model ? { resolved_model: model } : {}),
			...(report ? { final_response: report } : {}),
		};
	});

/** 중단 of an omp worker: only the process that runs it can end it, so that process is asked and its answer is the result. The session is told first, so the note is queued ahead of the wake the stop brings. */
export async function cancelOmp(
	rec: OmpRec | undefined,
	cancel: ((id: string) => Promise<{ cancelled: boolean }> | undefined) | undefined,
	ownerStopped?: (w: StoppedWork) => void,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	if (!rec) return { ok: false, status: 404, error: "이 작업을 찾을 수 없어요" };
	if (rec.status !== "running") return { ok: false, status: 409, error: "이미 끝난 작업이에요" };
	try {
		ownerStopped?.({ id: rec.task_id, name: rec.name, description: rec.description ?? rec.name });
		const answer = await cancel?.(rec.task_id);
		if (!answer) return { ok: false, status: 409, error: "이 작업을 맡은 프로세스가 지금 없어서 멈출 수 없어요" };
		return answer.cancelled ? { ok: true } : { ok: false, status: 409, error: "이미 끝났거나 멈추라는 요청에 답이 없는 작업이에요" };
	} catch (e) {
		return { ok: false, status: 500, error: `작업을 멈추지 못했어요: ${(e as Error).message}` };
	}
}
