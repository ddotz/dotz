// The usage screen's 적용 (POST /api/usage/fix {id}): applies ONE fix the nightly audit listed (hub/token-audit.ts fixesOf), only on
// the owner's own press. An agent's token is refused, an id the newest audit did not list is refused, a fix already applied is refused,
// and a fix whose situation has changed since the audit (the watch is gone, the context was compacted, the worker model was changed) is
// refused with the reason instead of applied. A model change goes through the guarded route (hub/control.ts changeTarget ->
// hub/model-guard.ts ownerGate) with the request, like any other change from the app.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_WORKER_MODEL, log, parseSelector, workerModel, writeAtomic } from "./config.ts";
import { changeTarget, targetView } from "./control.ts";
import { laneWorkerModel } from "./lanestate.ts";
import { lanes } from "./lanes.ts";
import { isAgentRequest } from "./model-guard.ts";
import { APPLIED_FILE, type FixRow, readApplied, readUseShare } from "./usage-share.ts";
import { allWatches, patchWatch } from "./watch.ts";

// A context still at least this big is compacted; a smaller one already was (the audit's own threshold, hub/token-audit.ts BIG_CTX).
const BIG_CTX = 300_000;
const MAX_EVERY_MINUTES = 7 * 24 * 60;

export type FixDeps = {
	isAgent: (req: Request) => boolean;
	fixes: () => FixRow[];
	applied: () => Record<string, number>;
	markApplied: (id: string, at: number) => void;
	watches: () => { id: string; name: string; every_minutes: number }[];
	patchWatch: (id: string, input: { every_minutes: number }) => unknown;
	contextTokens: (target: string) => Promise<number>;
	currentWorkerModel: (target: string) => string;
	change: typeof changeTarget;
	now: () => number;
};

const markApplied = (id: string, at: number): void => {
	mkdirSync(dirname(APPLIED_FILE), { recursive: true });
	writeAtomic(APPLIED_FILE, `${JSON.stringify({ ...readApplied(), [id]: at })}\n`);
};

const realDeps: FixDeps = {
	isAgent: isAgentRequest,
	fixes: () => readUseShare()?.fixes ?? [],
	applied: () => readApplied(),
	markApplied,
	watches: allWatches,
	patchWatch,
	contextTokens: async target => (await targetView(target)).context.tokens ?? 0,
	currentWorkerModel: target => (target === "workers" ? workerModel() : laneWorkerModel(lanes.get(target.slice(5)) ?? {})),
	change: changeTarget,
	now: Date.now,
};

export type FixAnswer = { status: number; body: { ok: boolean; reason?: string; note?: string; fix?: FixRow["fix"]; every_minutes?: number; worker_model?: string } };
const refuse = (status: number, reason: string): FixAnswer => ({ status, body: { ok: false, reason } });

export async function applyFix(req: Request, input: unknown, deps: FixDeps = realDeps): Promise<FixAnswer> {
	if (deps.isAgent(req)) return refuse(403, "only the owner applies a usage fix, from the usage screen");
	const id = (input as { id?: unknown })?.id;
	if (typeof id !== "string") return refuse(400, "id is required");
	const fix = deps.fixes().find(f => f.id === id);
	if (!fix) return refuse(404, "the latest usage check did not list this fix");
	if (fix.fix === "check") return refuse(400, "this row has no fixed remedy; check its cause");
	const at = deps.now();
	if (deps.applied()[id]) return refuse(409, "already applied");
	let body: FixAnswer["body"];
	if (fix.fix === "watch") {
		const w = deps.watches().find(x => x.name === fix.watch);
		if (!w) return refuse(409, `watch ${fix.watch} no longer exists`);
		const every = Math.min(MAX_EVERY_MINUTES, w.every_minutes * 2);
		if (every === w.every_minutes) return refuse(409, "the watch already runs at the longest interval");
		deps.patchWatch(w.id, { every_minutes: every });
		body = { ok: true, fix: "watch", every_minutes: every };
	} else if (fix.fix === "compact") {
		if ((await deps.contextTokens(fix.target!)) < BIG_CTX) return refuse(409, "the context is no longer big");
		const r = await deps.change(fix.target!, { compact: true, req });
		body = { ok: true, fix: "compact", ...("note" in r && r.note ? { note: String(r.note) } : {}) };
	} else {
		if (parseSelector(deps.currentWorkerModel(fix.target!)).model.split("/").pop() !== fix.model) return refuse(409, "the worker model was changed since the check");
		await deps.change(fix.target!, { workerModel: DEFAULT_WORKER_MODEL, req, byLane: false });
		body = { ok: true, fix: "worker", worker_model: DEFAULT_WORKER_MODEL };
	}
	deps.markApplied(id, at);
	log(`usage fix applied by the owner: ${id}`);
	return { status: 200, body };
}
