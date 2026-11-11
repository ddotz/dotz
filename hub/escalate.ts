// The stronger-model proposal (`dotz_escalate`): a session that hits one hard step asks to run just that step on a stronger model.
// The owner always decides on a decision card; there is no other way to a launch, also when an expensive-model grant exists. On his
// yes a new session (a lane, through the normal launch route with its budget gate and model guard) does the step with a handover of
// the asker's brief and report, its report goes back to the asker (lane `from`), and it is closed after its final report. The asking
// session's own model never changes. One proposal per session: a card waiting, a no, or a session that really started uses it up;
// a launch a gate refused does not (nothing ran, the asker may ask again once the gate allows).
//
// The candidate comes from this install's own role models only (main, sessions, workers in config.json `models`; fallback entries,
// which may hold API keys, never), ranked by role: main above sessions above workers. The nearest model ranked above the asker's is
// offered at the higher of the two thinking levels, else the asker's own model one level up. A model or level the guards keep for
// the owner's own request (`ownerOnly`: guard.expensive_models, the model guard's built-in families, the owner's blocked commands)
// is never offered, nor one the runtime does not list. State: one record per asking session in <data>/state/escalations.json.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, readJsonOrQuarantine, splitThinking, writeAtomic } from "./config.ts";
import { msg } from "./i18n.ts";
import { primaryTarget } from "./session-key.ts";

export type Configured = { role: "orchestrator" | "lanes" | "workers"; selector: string };
type Listed = { selector: string; thinking?: string[] };
export type LaunchRequest = { name: string; title: string; why: string; cwd: string; brief: string; model: string; est: number; session: string };
type State = "asked" | "declined" | "refused" | "started" | "done";
type Proposal = { asker: string; target: string; cwd: string; step: string; reason: string; est: number; from: string; offer: string; yes: string; no: string; brief?: string; report?: string; at: string; state: State; lane?: string; note?: string };
export type ProposeInput = { asker: string; cwd: string; current: string; offer?: string; step: string; reason: string; est: number; brief?: string; report?: string };
type Deps = {
	file: string;
	now: () => number;
	/** Posts the card in the asker's conversation as that session's message (`source` lane:<name> or orchestrator), so it becomes a decision. */
	post: (target: string, text: string, source: string) => unknown;
	launch: (req: LaunchRequest) => Promise<{ lane: string } | { error: string }>;
	/** A gateway note to the asking session. */
	tell: (asker: string, text: string) => void;
	stop: (lane: string) => void;
};

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const RANK: Record<Configured["role"], number> = { workers: 1, lanes: 2, orchestrator: 3 };
const split = (selector: string) => {
	const s = splitThinking(selector.trim());
	return { model: s.model, thinking: s.thinking ?? "" };
};
const sameModel = (a: string, b: string) => a === b || a.split("/").pop() === b.split("/").pop();
const higher = (a: string, b: string) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);
/** "provider/vendor-model-x:high" as the owner reads it: "vendor-model-x high". */
export const offerLabel = (selector: string) => {
	const s = split(selector);
	return `${s.model.split("/").pop()}${s.thinking ? ` ${s.thinking}` : ""}`;
};

export function pickCandidate(i: { current: string; configured: Configured[]; available?: Listed[]; ownerOnly: (selector: string) => string | undefined }): string | undefined {
	const cur = split(i.current);
	const roles = i.configured.map(c => ({ rank: RANK[c.role], ...split(c.selector) }));
	const rank = Math.max(0, ...roles.filter(r => sameModel(r.model, cur.model)).map(r => r.rank));
	const above = roles.filter(r => r.rank > rank && !sameModel(r.model, cur.model)).sort((a, b) => a.rank - b.rank);
	const options = [...above.map(r => ({ model: r.model, thinking: higher(r.thinking, cur.thinking) })), ...(LEVELS.includes(cur.thinking) ? LEVELS.slice(LEVELS.indexOf(cur.thinking) + 1) : []).map(thinking => ({ model: cur.model, thinking }))];
	const listed = (o: { model: string; thinking: string }) => {
		if (!i.available?.length) return true;
		const m = i.available.find(a => sameModel(split(a.selector).model, o.model));
		return Boolean(m) && (!m!.thinking || !o.thinking || m!.thinking.includes(o.thinking));
	};
	const pick = options.find(o => o.thinking && listed(o) && !i.ownerOnly(`${o.model}:${o.thinking}`));
	return pick && `${pick.model}:${pick.thinking}`;
}

// The main chat's card is posted to "web" and answered as "main" (web) or "chat" (a Discord button).
const chat = (target: string) => (target === "main" || target === "chat" ? "web" : target);
const laneName = (asker: string) => `${asker.replace(/^lane:/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 28) || "step"}-up`;

export function createEscalations(deps: Deps) {
	const read = (): Record<string, Proposal> => readJsonOrQuarantine<Record<string, Proposal>>(deps.file, () => ({}), { keepGood: false });
	const save = (p: Proposal): void => {
		mkdirSync(dirname(deps.file), { recursive: true });
		writeAtomic(deps.file, `${JSON.stringify({ ...read(), [p.asker]: p }, null, 2)}\n`, 0o600);
	};
	return {
		get: (asker: string): Proposal | undefined => read()[asker],
		async propose(i: ProposeInput): Promise<{ ok: true; offer: string; text: string } | { refused: string }> {
			const t = msg().escalate;
			const prior = read()[i.asker];
			if (prior?.state === "asked") return { refused: t.waiting };
			if (prior && prior.state !== "refused") return { refused: t.used(prior.state) };
			if (!i.offer) return { refused: t.noCandidate };
			const offer = offerLabel(i.offer);
			const lane = i.asker.startsWith("lane:");
			const p: Proposal = { asker: i.asker, target: lane ? i.asker : primaryTarget(i.asker), cwd: i.cwd, step: i.step.trim(), reason: i.reason.trim(), est: i.est, from: i.current, offer: i.offer, yes: t.yes(offer), no: t.no, ...(i.brief ? { brief: i.brief } : {}), ...(i.report ? { report: i.report } : {}), at: new Date(deps.now()).toISOString(), state: "asked" };
			save(p);
			await deps.post(p.target, t.card({ step: p.step, reason: p.reason, from: offerLabel(i.current), offer, est: p.est, yes: p.yes, no: p.no }), lane ? i.asker : "orchestrator");
			return { ok: true, offer: i.offer, text: t.asked(offer) };
		},
		/** The owner's card answer (web or messenger button). "none": not an answer to an open proposal of that conversation. */
		async answer(a: { to: string; label: string }): Promise<"none" | "declined" | "started" | "refused"> {
			const p = Object.values(read()).find(x => x.state === "asked" && chat(x.target) === chat(a.to) && (a.label === x.yes || a.label === x.no));
			if (!p) return "none";
			const t = msg().escalate;
			if (a.label === p.no) {
				save({ ...p, state: "declined" });
				deps.tell(p.asker, t.declined);
				return "declined";
			}
			const r = await deps.launch({ name: laneName(p.asker), title: t.title, why: t.why(p.asker), cwd: p.cwd, brief: t.brief({ asker: p.asker, offer: offerLabel(p.offer), step: p.step, reason: p.reason, brief: p.brief, report: p.report, est: p.est }), model: p.offer, est: p.est, session: p.asker });
			if ("error" in r) {
				save({ ...p, state: "refused", note: r.error });
				deps.tell(p.asker, t.refused(r.error));
				return "refused";
			}
			save({ ...p, state: "started", lane: r.lane });
			deps.tell(p.asker, t.started(r.lane, offerLabel(p.offer)));
			return "started";
		},
		/** A lane's report: the stronger-model session's [done] or [fail] closes it (its report already went to the asker). */
		reported(lane: string, tone: string | undefined): boolean {
			const p = Object.values(read()).find(x => x.state === "started" && x.lane === lane);
			if (!p || (tone !== "done" && tone !== "fail")) return false;
			save({ ...p, state: "done" });
			deps.stop(lane);
			return true;
		},
	};
}
export type Escalations = ReturnType<typeof createEscalations>;

export const ESCALATIONS_FILE = join(DATA_DIR, "state", "escalations.json");
// The gateway's instance, wired in main.ts (the launcher and the poster live in modules that import this one).
let live: Escalations | undefined;
export const wireEscalations = (deps: Omit<Deps, "file" | "now">): Escalations => (live = createEscalations({ file: ESCALATIONS_FILE, now: Date.now, ...deps }));
export const escalations = (): Escalations | undefined => live;
export const setEscalationsForTest = (e: Escalations | undefined): void => {
	live = e;
};
