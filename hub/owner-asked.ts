// Expensive-model use the owner asked for, for the nightly token audit (hub/token-audit.ts): such use is the owner's choice, not waste,
// so it stays out of the warnings and the doctor's finding and is told as one plain line. The basis is what the gateway records:
// a model pick by the owner or on an owner message (state/model-picks.json and the `model change:` lines in hub.log, hub/model-guard.ts
// noteModelChange), the owner's expensive-model grants (`expensive grant:` lines, hub/model-guard.ts grantExpensive) and a lane launched on
// the owner's ask for an expensive model (lane.json fableOk, the same record the lane's guard reads: hub/lanerun.ts ownerAsked).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PickEvent = { target: string; model: string; thinking: string; at: number; owner: boolean };
export type GrantSpan = { conv: string; from: number; to: number };
export type AskedLane = { model: string; thinking: string };
export type OwnerBasis = { picks: PickEvent[]; grants: GrantSpan[]; lanes?: Record<string, AskedLane> };
// One session's expensive use: the bare model ids and thinking levels that counted as expensive, and when the first and last such turn ran.
export type DearUse = { models: string[]; levels: string[]; first: number; last: number };
export type Covered = { model: boolean; effort: boolean };

const byOwner = (by: string): boolean => by === "owner" || by.startsWith("owner-message:");
// "anthropic-subscription/claude-fable-5-2:high" -> "claude-fable-5-2"
export const bareModel = (selector: string): string => selector.replace(/:[a-z]+$/i, "").split("/").pop() ?? "";
const levelOf = (selector: string): string => selector.match(/:([a-z]+)$/i)?.[1] ?? "";

const readText = (file: string): string => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
};

// Pure: the basis from the picks file's text, hub.log's text and the lanes launched on the owner's ask. Only the two kinds of log line are
// parsed; the rest is skipped. A picks entry with no log line of its own is the state from before the records (a migration writes it, or the
// log rotated), so it holds from the start.
export function parseOwnerBasis(picksJson: string, logText: string, lanes: Record<string, AskedLane> = {}): OwnerBasis {
	const picks: PickEvent[] = [];
	const grants: GrantSpan[] = [];
	const logged = new Set<string>();
	for (const line of logText.split("\n")) {
		if (!line.includes(" model change: ") && !line.includes(" expensive grant: ")) continue;
		const change = line.match(/^(\S+) model change: (\S+) \S+ -> (\S+) by (\S+)$/);
		if (change) {
			const at = Date.parse(change[1]!);
			if (!Number.isNaN(at)) picks.push({ target: change[2]!, model: change[3]!.replace(/:[a-z]+$/i, ""), thinking: levelOf(change[3]!), at, owner: byOwner(change[4]!) });
			logged.add(change[2]!);
			continue;
		}
		const grant = line.match(/^(\S+) expensive grant: (\S+) until (\S+) by (\S+)$/);
		if (grant && byOwner(grant[4]!)) {
			const from = Date.parse(grant[1]!), to = Date.parse(grant[3]!);
			if (!Number.isNaN(from) && !Number.isNaN(to)) grants.push({ conv: grant[2]!, from, to });
		}
	}
	try {
		for (const [target, p] of Object.entries(JSON.parse(picksJson || "{}") as Record<string, { model?: unknown; thinking?: unknown; by?: unknown; at?: unknown }>)) {
			const at = Date.parse(String(p?.at));
			if (typeof p?.model !== "string" || Number.isNaN(at)) continue;
			if (!logged.has(target)) picks.push({ target, model: p.model, thinking: String(p.thinking ?? ""), at: Number.NEGATIVE_INFINITY, owner: byOwner(String(p.by ?? "")) });
		}
	} catch {
		// an unreadable picks file adds nothing; the log lines still count
	}
	return { picks: picks.sort((a, b) => a.at - b.at), grants, lanes };
}

// lane name -> its launch model, for each lane launched on the owner's ask for an expensive model (lane.json fableOk).
function askedLanes(lanesDir: string): Record<string, AskedLane> {
	const out: Record<string, AskedLane> = {};
	let names: string[] = [];
	try {
		names = readdirSync(lanesDir);
	} catch {
		return out;
	}
	for (const name of names) {
		try {
			const lane = JSON.parse(readFileSync(join(lanesDir, name, "lane.json"), "utf8"));
			if (lane?.fableOk === true && typeof lane.model === "string") out[name] = { model: lane.model.replace(/:[a-z]+$/i, ""), thinking: levelOf(lane.model) };
		} catch {
			// a folder without a readable lane.json is no lane
		}
	}
	return out;
}

export const readOwnerBasis = (picksFile: string, logFile: string, lanesDir: string): OwnerBasis => parseOwnerBasis(readText(picksFile), readText(logFile), askedLanes(lanesDir));

// The pick in force on a target at a time: the latest change at or before it (whoever made it: a later fallback ends the owner's basis).
const pickAt = (b: OwnerBasis, target: string, t: number): PickEvent | undefined => b.picks.findLast(p => p.target === target && p.at <= t);

// The targets whose pick a session runs on. The orchestrator folder serves main and every conversation without its own pick (ch:, mail:),
// so any of those counts there; a lane without its own pick runs the lanes default.
function targetsOf(target: string, b: OwnerBasis): string[] {
	if (target === "orchestrator") return ["orchestrator", ...new Set(b.picks.map(p => p.target).filter(t => /^(?:ch|mail|th):/.test(t)))];
	if (target.startsWith("lane:")) return b.picks.some(p => p.target === target) ? [target] : ["lanes"];
	return [target];
}
const convsOf = (target: string): ((conv: string) => boolean) =>
	target === "orchestrator" ? c => c === "main" || /^(?:ch|mail|th):/.test(c) : c => c === target;

// Pure: which parts of a session's expensive use the owner asked for. `target` is the session's own target (orchestrator | lane:<name>);
// `worker` marks a task worker, whose model is never a pick: only a grant on its parent's conversation covers it.
export function ownerCovered(use: DearUse, target: string | undefined, worker: boolean, b: OwnerBasis): Covered {
	if (!target) return { model: false, effort: false };
	const conv = convsOf(target);
	if (b.grants.some(g => conv(g.conv) && g.from <= use.first && use.last <= g.to)) return { model: true, effort: true };
	// a lane launched on the owner's ask runs its own model, and its workers may run an expensive one (the guard lets them: DOTZ_OWNER_ASKED_FABLE)
	const lane = target.startsWith("lane:") ? b.lanes?.[target.slice(5)] : undefined;
	if (lane && worker) return { model: true, effort: false };
	if (worker) return { model: false, effort: false };
	const viaLane = { model: !!lane && use.models.every(m => m === bareModel(lane.model)), effort: !!lane && use.levels.every(l => l === lane.thinking) };
	const held = targetsOf(target, b).flatMap(t => {
		const first = pickAt(b, t, use.first), last = pickAt(b, t, use.last);
		return first && first === last && first.owner ? [first] : [];
	});
	return {
		model: viaLane.model || use.models.every(m => held.some(p => bareModel(p.model) === m)),
		effort: viaLane.effort || use.levels.every(l => held.some(p => p.thinking === l)),
	};
}
