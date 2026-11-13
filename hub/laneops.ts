import { DATA_DIR, log, paths, selectorOf, lanesModel, now, chainAfter, fallbackChain, parseSelector } from "./config.ts";
import { markDeep } from "./deepmark.ts";
import { type Lane, hooks, laneLive, laneWorkerModel, lanes, dir, persist, ownerNotes, setStatus, portOf, type Record_, pendingFile } from "./lanestate.ts";
import { broadcast } from "./events.ts";
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { RESTART_HELD_FILE } from "./restart.ts";
import { msg, lang } from "./i18n.ts";
import { laneWorktree, dropWorktree, withWorktree, unlanded } from "./lanetree.ts";
import { checkBrief } from "./lanegates.ts";
import { newCtx, type Compaction, requestCompact } from "./context.ts";
import { join } from "node:path";
import { spawn, runtimeMismatch, resumeLane, harnessName, sessionRuntime } from "./lanerun.ts";
import { prompt } from "./laneprompt.ts";
import { footer } from "./lanefooter.ts";
import { checkSoon as checkAccountSoon } from "./account-rules.ts";
import { clearAsk, withHeld, report } from "./lanereport.ts";
import { baseLanguage } from "./language.ts";
import { hubChain, Chain, Reverter } from "./fallback.ts";
import { runtimeFor } from "./runtime/index.ts";
import { statusActivity, runningSubagents } from "./activity.ts";
import { quietOmoWork, runningOmoWorkers } from "./bgwork.ts";
import { laneClosed, unfinishedWork, withWorkers } from "./laneunfinished.ts";
import { backgroundWork } from "./todo.ts";
import { parseTone } from "./tone.ts";
import { activeCount, laneLimits, launchWait, waitingLanes } from "./lanelimits.ts";
import { startMachineSampler } from "./limits.ts";
import { trackTimer } from "./shutdown.ts";
import { diskGuardTick } from "./diskguard.ts";
import { ABORT_GRACE_MS, takeSnapshot } from "./stuck.ts";
import { markPark } from "./agent-tree.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The owner's yes to a handover offer (a bare "인계" / "handover", as typed in the lane channel or the web lane view).
const HANDOVER_RE = /^\s*(인계|인계해(줘|요)?|인계\s*ㄱ+|handover|hand\s*over|새\s*(세션|대화\s*기록)(으로)?(\s*이어가(기|줘)?)?)\s*[.!]*\s*$/i;
const ownerWords = (text: string) => text.replace(/^\[owner via [^\]]+\]\s*/, "");

// A queued lane waiting longer than this is reported to the orchestrator once (it never waits unseen).
export const QUEUE_TELL_MS = 30 * 60_000;
// Queued launches start, oldest first, as soon as the limits allow; checked every few seconds.
export function startQueuedLanes(): string[] {
	const started: string[] = [];
	for (const lane of waitingLanes()) {
		const why = launchWait(lane.cwd);
		if (why) {
			if (lane.waiting !== why) {
				lane.waiting = why;
				persist(lane);
			}
			// A wait never goes on unseen: past QUEUE_TELL_MS the orchestrator is told once, to make room, split the work or move it.
			const waited = Date.now() - Date.parse(lane.startedAt);
			if (!lane.queueTold && waited > QUEUE_TELL_MS) {
				lane.queueTold = true;
				report(lane, `[blocked] 세션이 ${Math.round(waited / 60_000)}분째 시작하지 못하고 기다리고 있어요: ${why}. 끝난 세션을 정리하거나, 일을 더 작게 나누거나, 서브에이전트로 돌려서 진행하세요.`, true);
			}
			break;
		}
		lane.waiting = undefined;
		try {
			begin(lane, readFileSync(join(dir(lane.name), "brief.md"), "utf8").trim());
			started.push(lane.name);
		} catch (e) {
			// nobody waits on a queued start: the orchestrator gets the failure to fix
			report(lane, `[fail] 기다리던 세션을 시작하지 못했어요: ${lane.startError ?? (e as Error).message}. 원인(작업 폴더, 하네스, 모델)을 고쳐 다시 띄우세요.`, true);
		}
	}
	return started;
}
export function startLaneQueue(): void {
	const timer = setInterval(() => {
		diskGuardTick([DATA_DIR, ...[...lanes.values()].map(l => l.cwd)]);
		startQueuedLanes();
	}, 5000);
	timer.unref();
	trackTimer("lane queue", timer);
	trackTimer("machine sampler", startMachineSampler());
}

export function launch(name: string, cwd: string, brief: string, model?: string, worker?: string, fableOk?: boolean, title?: string, from?: string, peer?: Lane["peer"]): Lane {
	if (!NAME_RE.test(name)) throw new Error("lane name must match [a-z0-9][a-z0-9-]{0,31}");
	if (!cwd.startsWith("/") || !existsSync(cwd)) throw new Error(`cwd must be an existing absolute path: ${cwd}`);
	const prior = lanes.get(name);
	if (prior?.proc) throw new Error(`lane ${name} is already running; use send`);
	const problem = checkBrief(brief);
	if (problem) throw new Error(problem);
	const why = launchWait(cwd) ?? waitingLanes()[0]?.waiting;
	const selector = model ?? selectorOf(lanesModel());
	mkdirSync(dir(name), { recursive: true });
	const place = laneWorktree(name, cwd);
	if (!existsSync(place.cwd)) throw new Error(`lane ${name}: working directory does not exist: ${place.cwd}`);
	const lane: Lane = { name, ...(title ? { title } : {}), cwd: place.cwd, worktree: place.worktree, model: selector, workerModel: worker || undefined, fableOk: fableOk || undefined, status: "starting", startedAt: now(), lastText: "", reports: 0, ctx: newCtx(), orchAsked: true, ...(from ? { from } : {}), ...(peer ? { peer } : {}), ...(why ? { waiting: why } : {}) };
	lanes.set(name, lane);
	persist(lane);
	writeFileSync(join(dir(name), "brief.md"), `${brief}\n`);
	if (why) log(`lane ${name} queued, ${why} (starts when the limits allow)`);
	else begin(lane, brief);
	return lane;
}

function begin(lane: Lane, brief: string): void {
	// A start that failed has already ended the lane (lanerun.ts startFailed); the launch reports why to its caller.
	if (!spawn(lane, false)) throw new Error(`lane ${lane.name} could not start: ${lane.startError ?? "unknown"}`);
	prompt(lane, brief + footer(lane));
	log(`lane ${lane.name} launched in ${lane.cwd} (${lane.model}, workers ${laneWorkerModel(lane)}, up to ${lane.workerSlots})`);
}

/** How an owner message reached a lane: "steered" into its running step, "received" by an idle process, "held" (paused on a limit, goes in with the resume), "resumed" (stopped session started again). */
export type LaneDelivery = "steered" | "received" | "held" | "resumed";

/** `gateway`: the gateway's own prompt (a stall nudge), not the orchestrator asking: the lane's answer to it stays an untagged
 * report the orchestrator did not ask for. */
export function sendToLane(name: string, text: string, ref?: string, gateway = false, deep = false): LaneDelivery {
	checkAccountSoon();
	const lane = lanes.get(name);
	if (!lane) throw new Error(`lane ${name} does not exist`);
	if (!lane.proc && lane.sessionFile) {
		const wrong = runtimeMismatch(lane);
		if (wrong && HANDOVER_RE.test(ownerWords(text))) {
			handoverLane(name);
			return "resumed";
		}
		if (wrong) {
			if (!HANDOVER_RE.test(ownerWords(text)) && text !== "/budget-ok") lane.pendingHandover = text;
			throw wrong;
		}
	}
	if (lane.waiting) throw new Error(`lane ${name} is queued (${lane.waiting}); it starts by itself when the limits allow`);
	if (!lane.proc && (!lane.sessionFile || !existsSync(lane.sessionFile))) throw new Error(`lane ${name} is not running and has no session to resume`);
	// New work makes an unchecked [done] claim stale; a verified one stays until the lane's next report replaces it.
	// Any message to the lane is the owner's answer to a pending [ask], and starts a new episode of automatic resumes. The gateway's own
	// prompts are not: a stall nudge that cleared the ask left the lane reading as unfinished (ddotz/dotz#44).
	if (!gateway) {
		lane.askRefused = false;
		lane.bareAsk = undefined;
		lane.handedBack = undefined;
		if (lane.claim?.state === "reported") lane.claim = undefined;
		else if (lane.claim) lane.claim.reopened = true;
		clearAsk(lane);
		lane.restartWakes = undefined;
		lane.ownerStopped = undefined;
		persist(lane);
	}
	// 2026-11-01: a stall nudge every few minutes to a lane waiting hours on a video made each "still waiting" reply a relayed
	// report, so every one woke the orchestrator.
	if (!gateway && !/^\[owner via /.test(text) && text !== "/budget-ok") lane.orchAsked = true;
	// A message reached the lane: its wait on main is answered or moved on, so the reminders (laneidle.ts) start over from now. Main's
	// answers come in as gateway prompts too (a handback, dotz_send lane:x), so any message that is not the owner's also makes the lane's
	// next report news, even in the same words as its last relayed one (review-a G7).
	if (lane.waitingMain) {
		lane.waitingMain = { text: lane.waitingMain.text, since: Date.now(), tells: 0 };
		persist(lane);
	}
	if (!/^\[owner via /.test(text) && text !== "/budget-ok") hooks.mainWrote(name);
	const how: LaneDelivery = !lane.proc ? "resumed" : lane.status === "working" || lane.startingOn === lane.proc ? "steered" : lane.status === "rate-limited" ? "held" : "received";
	// The owner's "ultrathink": the prompt carries a line whatever its delivery, so a held one or the one that resumes a stopped lane keeps it
	// (hub/deepmark.ts). A steered message starts no new turn, so there the line reads as a hint.
	if (deep && !gateway) text = markDeep(text, { name: `lane ${lane.name}`, runtime: runtimeFor("lane").id, model: parseSelector(lane.model).model, onFallback: Boolean(lane.chained) || (lane.chain?.active ?? 0) > 0 }, log);
	if (!gateway && lane.proc && lane.status === "working") (lane.steered ??= []).push(text);
	if (lane.proc) prompt(lane, text);
	else resumeLane(lane, text);
	ownerNotes.asked(name, ref);
	return how;
}

function known(name: string): Lane {
	const lane = lanes.get(name);
	if (!lane) throw new Error(`no lane ${name}`);
	return lane;
}

// A lane's "done" report is only its own claim (OMH evidence labels: reported vs verified); "verified" is set here, by the
// orchestrator, after it checked the Done-when itself, and any later report that is not [done] withdraws the claim.
// A lane whose lane/<name> branch is not in its base yet is refused (dori done-flow.ts:54): "done" must mean landed. `force`
// is for work that stays unmerged on purpose (a PR awaiting review); the evidence then says why.
export function verifyLane(name: string, evidence: string, force = false): void {
	const lane = known(name);
	if (lane.claim?.state !== "reported") throw new Error(`lane ${name} has no reported-done claim to verify${lane.claim ? " (already verified)" : ""}`);
	const text = evidence.trim();
	if (!text) throw new Error("verify needs evidence: what was run and its result");
	if (lane.claim.problems?.length) throw new Error(`task metadata contradicts lane ${name}'s [done] (${lane.claim.problems.join("; ")}); have the lane redo or explain it, then verify its next [done]`);
	const open = lane.worktree && !force ? unlanded(lane.worktree) : undefined;
	if (open) throw new Error(`lane ${name} is not landed: ${open}. Have it land first (rebase + ff-merge into ${lane.worktree!.base}), or verify with force=true and say in text why it stays unmerged`);
	lane.claim = { state: "verified", at: now(), evidence: text.slice(0, 1000) };
	persist(lane);
}

// "보고됨 · " / "확인됨 · " for a lane's worklog entry; empty while the lane has no claim.
export function claimPrefix(name: string): string {
	const state = lanes.get(name)?.claim?.state;
	if (!state) return "";
	const ko = baseLanguage(lang()) === "ko";
	return `${state === "verified" ? (ko ? "확인됨" : "verified") : ko ? "보고됨" : "reported"} · `;
}

// Stops the lane's process; a closed lane whose branch is merged and clean also loses its worktree and branch.
export function stopLane(name: string): void {
	const lane = known(name);
	const proc = lane.proc;
	lane.ownerStopped = true;
	lane.died = undefined;
	persist(lane);
	// Queued, or no process at all (a spawn that failed): nothing to kill, the lane just ends and frees its slot.
	if (lane.waiting || !proc) {
		lane.waiting = undefined;
		setStatus(lane, "exited");
	}
	proc?.kill();
	void (proc?.exited ?? Promise.resolve()).then(() => {
		const note = dropWorktree(lane);
		if (note) log(`lane ${name}: ${note}`);
	});
}

export function abortLane(name: string): void {
	const lane = known(name);
	if (!lane.proc) throw new Error(`lane ${name} is not running`);
	lane.ownerStopped = true;
	persist(lane);
	const p = lane.proc;
	p.abort();
	// A process that ignores the abort stays "working": killed after the grace and resumed on the same session idle, with no continue text
	// and not counted as a recovery (the owner stopped it; laneevents.ts turn_end disarms this).
	clearTimeout(lane.abortTimer);
	lane.abortTimer = setTimeout(() => {
		lane.abortTimer = undefined;
		if (lane.proc !== p || lane.status !== "working") return;
		log(`lane ${name} ignored the owner abort; restarting it on the same session`);
		lane.revive = { text: undefined };
		// A diagnostic file first (hub/stuck.ts, a few seconds at most); the kill follows whatever happens to it.
		void takeSnapshot(`lane:${name}`, p.pid, lane.sessionFile).then(() => lane.proc === p && p.kill(true));
	}, ABORT_GRACE_MS);
}

// Resumes a stopped lane (or, with text, steers a running one) from its saved session.
export function resumeByName(name: string, text?: string): void {
	const lane = known(name);
	lane.ownerStopped = undefined;
	if (lane.proc) {
		if (!text) throw new Error(`lane ${name} is already running`);
		if (lane.pendingAsk) {
			clearAsk(lane);
			persist(lane);
		}
		return prompt(lane, text);
	}
	const wrong = runtimeMismatch(lane);
	if (wrong) {
		if (text) lane.pendingHandover = text;
		throw wrong;
	}
	if (!lane.sessionFile || !existsSync(lane.sessionFile)) throw new Error(`lane ${name} has no session to resume`);
	resumeLane(lane, text || msg().laneOwnerResumed);
}

// Restarts the omp process of a lane, resuming its session (a turn that was running is cut off, so it is told to continue,
// with `note` when the caller knows why).
export async function restartLane(name: string, note = msg().laneOwnerRestarted, byOwner = false): Promise<void> {
	const lane = known(name);
	if (byOwner) lane.ownerStopped = undefined;
	if (!lane.proc) return resumeByName(name);
	if (!lane.sessionFile || !existsSync(lane.sessionFile)) throw new Error(`lane ${name} has no session yet; try again in a few seconds`);
	// The process runs on the runtime it started on; a runtime switched in config since then cannot take its session over.
	const wrong = runtimeMismatch(lane);
	if (wrong) throw wrong;
	// A worker or shell under an idle lane dies with the process (the memory guard asks for this too), so it is brought back with word of them.
	const wasWorking = lane.status === "working" || lane.status === "starting";
	const jobs = laneJobs(lane).map(j => j.what);
	const cut = wasWorking || ((laneBusy(lane) || jobs.length > 0) && !laneClosed(lane));
	const old = lane.proc;
	lane.quiet = true;
	old.kill();
	await old.exited;
	if (cut) resumeLane(lane, withWorkers(note, jobs));
	else if (spawn(lane, true)) setStatus(lane, "idle");
}

// Persists a new model selector on the lane record. A running idle lane switches in place on its session (set_model /
// set_thinking_level, no restart); a working one, or one on a fallback entry or a runtime-owned fallback list, restarts
// and resumes its session.
export async function setLaneModel(name: string, selector: string): Promise<"live" | "restarted" | "next-start"> {
	const lane = known(name);
	lane.model = selector;
	persist(lane);
	if (!lane.proc) return "next-start";
	if (switchLaneInPlace(lane)) return "live";
	await restartLane(name);
	return "restarted";
}
// Sets the model a lane's task workers run on; `selector` undefined drops the lane's own value so it follows models.workers.
// A running process keeps the worker profile it was spawned with (OMO_PROFILE is fixed at spawn), so the lane is told once:
// steered in now when it is working, otherwise on its next prompt (no extra turn). `byLane`: the lane records a switch it
// already made on the owner's word, so it is not told. Every view reads the new value at once (the lanes frame).
export function setLaneWorkerModel(name: string, selector: string | undefined, byLane = false): "live" | "next-start" {
	const lane = known(name);
	lane.workerModel = selector;
	lane.workerByLane = byLane && selector ? true : undefined;
	persist(lane);
	const next = laneWorkerModel(lane), was = lane.activeWorkerModel;
	if (lane.proc) {
		lane.activeWorkerModel = next;
		if (!byLane && was !== next) {
			const note = msg().workerSwitched(next);
			if (lane.status === "working") lane.proc.send(note, "steer");
			else lane.workerNext = note;
		}
	}
	log(`lane ${name} workers -> ${next}${byLane ? " (recorded by the lane)" : ""}`);
	broadcast({ kind: "lanes", lane: name, status: lane.status, live: laneLive(lane), was_live: laneLive(lane) });
	return lane.proc ? "live" : "next-start";
}
function switchLaneInPlace(lane: Lane): boolean {
	if (!lane.proc?.setModel || lane.chained || lane.status !== "idle" || (lane.chain && lane.chain.active !== 0)) return false;
	const driven = hubChain(runtimeFor("lane").id, chainAfter(lane.model, fallbackChain("lanes")));
	const next = driven ? new Chain(lane.model, driven, parseSelector(lane.model).thinking) : undefined;
	if (next && next.initial() !== 0) return false;
	lane.proc.setModel(lane.model);
	lane.chain = next;
	lane.capped = undefined;
	lane.activeModel = lane.startedModel = lane.model;
	lane.reverter = new Reverter();
	log(`lane ${lane.name} switched in place to ${lane.model}`);
	statusActivity(`lane:${lane.name}`, `lane switched to ${lane.model} on its session`);
	return true;
}

// Compacts a running lane's context: now when idle, after the running turn otherwise. Rewrites the prompt cache once.
export function compactLane(name: string): Compaction {
	const lane = known(name);
	if (!lane.proc) throw new Error(`lane ${name} is not running (resume it first)`);
	return requestCompact(lane.ctx, portOf(lane));
}

// Asks a running lane's runtime for its current context numbers (they arrive as a usage event).
export function refreshLaneStats(name: string): void {
	const lane = known(name);
	lane.proc?.refreshUsage();
}

// Moves an idle lane to a fresh session with a handover (the same pattern as the orchestrator's rotation): the lane
// keeps its model, folder, brief and goal, and reads its brief and last report to continue. The reload turn is silent
// (no report); an owner message that arrives meanwhile makes the next turn a normal one.
export async function rotateLane(name: string, why: string): Promise<void> {
	const lane = known(name);
	if (!lane.proc || lane.status !== "idle") throw new Error(`lane ${name} is not idle`);
	const previous = lane.sessionFile;
	const old = lane.proc;
	lane.quiet = true;
	old.kill();
	await old.exited;
	lane.ctx = newCtx();
	lane.retainNext = lane.contractDue = undefined; // the fresh session's handover already carries the nudge and the footer
	spawn(lane, false);
	const tail = previous && existsSync(previous) ? runtimeFor("lane").recentExchanges(previous) : undefined;
	const brief = join(dir(name), "brief.md");
	const lastReport = join(dir(name), "report.md");
	// The fresh session has neither the launch prompt nor a compaction hook to carry the lane's identity and rules: the footer goes in with it.
	prompt(lane, `${msg().laneRotated(why, lane.cwd, brief, lastReport)}${previous ? `\n\n${msg().laneHandover(previous, tail)}` : ""}${footer(lane)}`);
	lane.silent = { lastText: lane.lastText };
}

// The same lane in a fresh session on the current runtime, for a session another runtime wrote (runtimeMismatch): the
// lane keeps its name, channel, folder, model, brief and goal and gets the previous session's recent exchanges (OmO and omp
// write the same session format), its brief and its last report. The owner message the refused resume carried, or `text`,
// goes in the same prompt; without one the reload turn is silent, as after a rotation.
export function handoverLane(name: string, text?: string): void {
	const lane = known(name);
	if (lane.proc) throw new Error(`lane ${name} is running; it needs no handover`);
	lane.ownerStopped = undefined;
	const previous = lane.sessionFile;
	const from = harnessName(sessionRuntime(lane) ?? "?");
	const to = harnessName(runtimeFor("lane").id);
	const owner = text?.trim() || lane.pendingHandover;
	lane.pendingHandover = undefined;
	lane.ctx = newCtx();
	lane.retainNext = lane.contractDue = undefined;
	lane.sessionFile = undefined;
	const tail = previous && existsSync(previous) ? runtimeFor("lane").recentExchanges(previous) : undefined;
	const brief = join(dir(name), "brief.md");
	const lastReport = join(dir(name), "report.md");
	const prior = previous ? `\n\n${msg().laneHandover(previous, tail)}` : "";
	const lead = owner ? msg().laneRuntimeHandover(from, to, lane.cwd, brief, lastReport) : msg().laneRotated(`${from} -> ${to}`, lane.cwd, brief, lastReport);
	spawn(lane, false);
	const body = withWorktree(lane, `${lead}${prior}`) + footer(lane);
	log(`lane ${name} handed over to a fresh ${to} session (previous ${from} session ${previous ?? "none"})`);
	if (owner) return prompt(lane, withHeld(lane, `${body}\n\n${owner}`));
	prompt(lane, body);
	lane.silent = { lastText: lane.lastText };
}

const closesTurn = (text: string) => ["done", "ask"].includes(parseTone(text).tone ?? "");

export { laneClosed };

// Brings back every lane that was alive when the gateway stopped: working ones resume their turn, and the rest (finished, waiting on the
// owner) are respawned idle so they keep answering in their channel. One that stopped idle with work left, or a parked or crashed one,
// costs no slot at boot: the resume sweep (laneresume.ts) brings those back through the one gate of capacity, budget and the wake bound.
// A wake costs no context: the note is one prompt on the same session, and the first turn after the 33-minute gap read the whole prefix
// from cache (site-demo-proto 01:43: 182,024 read, 738 written). Returns the lanes that were resumed mid-work.
// A lane can also stop on its own words, a last [wait] for the gateway restart with no held file: qa-golden sat 27 min after the restart
// on 2026-11-10 (projects/session-stalls #9). It goes on like a held one.
function waitsForRestart(name: string): boolean {
	const file = join(dir(name), "report.md");
	if (!existsSync(file)) return false;
	const { tone, text } = parseTone(readFileSync(file, "utf8"));
	// Only a gateway restart, named in the same sentence ("게이트웨이를 <버전>으로 재시작하라는 요청에 따라", a version holds dots): a [wait] on a worker's restart
	// got the gateway's resume note after every restart (review-a G11).
	return tone === "wait" && /게이트웨이(?:(?![.!?]\s)[^\n]){0,20}(?:재시작|다시\s*(?:시작|띄))|gateway(?:(?![.!?]\s)[^\n]){0,20}restart|restart(?:(?![.!?]\s)[^\n]){0,20}gateway/i.test(text);
}

export function restoreLanes(): string[] {
	const resumed: string[] = [];
	if (!existsSync(paths.lanes)) return resumed;
	for (const name of readdirSync(paths.lanes)) {
		const file = join(dir(name), "lane.json");
		if (!existsSync(file) || lanes.has(name)) continue;
		const rec = JSON.parse(readFileSync(file, "utf8")) as Record_;
		const lane: Lane = { ...rec, lastText: "", ctx: newCtx() };
		lanes.set(name, lane);
		// It stopped because the waiting restart refused its task workers (extension/restart-hold.ts): one note to go on, sent by the
		// resume sweep like a message its busy session refused. A lane cut off mid-turn gets laneGatewayRestarted instead.
		const restartHeld = join(dir(name), RESTART_HELD_FILE);
		if (existsSync(restartHeld) || waitsForRestart(name)) {
			rmSync(restartHeld, { force: true });
			if (rec.status === "idle" && !lane.refused) {
				lane.refused = { text: msg().laneRestartResume, tries: 0 };
				persist(lane);
			}
		}
		if (existsSync(pendingFile(lane))) {
			lane.lastText = readFileSync(pendingFile(lane), "utf8");
			report(lane, lane.lastText, lane.lastText.startsWith("[lane error]"));
		}
		const wrong = runtimeMismatch(lane);
		if (wrong && rec.status !== "exited") log(`lane ${name} not restored: its session was written by ${wrong.from}, lanes run on ${wrong.to} (a message to it offers a handover)`);
		const session = !wrong && Boolean(rec.sessionFile && existsSync(rec.sessionFile));
		if (session && (rec.status === "working" || rec.status === "starting" || rec.status === "rate-limited")) {
			resumeLane(lane, msg().laneGatewayRestarted);
			resumed.push(name);
		} else if (session && rec.status === "idle" && rec.parked) {
			lane.quiet = true;
			log(`lane ${name} parked (idle, no process): a message resumes it, and so does the sweep if it has work left`);
		} else if (session && rec.status === "idle") {
			// A message a busy session refused counts: its retry was cut off by the restart (laneevents.ts refusedTurn).
			if (unfinishedWork(lane)) {
				lane.quiet = true;
				lane.parked = true;
				log(`lane ${name} has work left: the resume sweep brings it back`);
				continue;
			}
			lane.restartWakes = undefined;
			if (spawn(lane, true)) setStatus(lane, "idle");
			log(`lane ${name} respawned idle ${rec.sessionFile}`);
		} else if (rec.waiting && rec.status === "starting") log(`lane ${name} still queued (${rec.waiting}), it starts when the limits allow`);
		else if (rec.status !== "exited") setStatus(lane, "exited");
	}
	return resumed;
}

// A lane is busy while its turn runs, any of its task workers still runs (a turn often ends while workers go on), or its ended turn
// waits on a background shell of its own: on OmO neither shows in the lane's status or frames, only in its task store and session file
// (a restart killed the shell of a turn that had ended 88 s earlier, site-demo-proto 2026-11-04 01:11; 0.6 s, prototype-to-product 00:44).
// A shell left running after a [done] or an [ask] (a dev server, say) is not what the lane waits on.
// Only a live process is busy: a queued lane or one whose spawn failed has nothing a gateway restart could cut off (the Mac mini's
// restart waited on the dead acme-allowance-review, 2026-10-29). `shells` false leaves the shell out: the idle stop bounds it itself.
const waitsOnShell = (lane: Lane): boolean => backgroundWork(lane.sessionFile) > 0 && !closesTurn(lane.lastText);
export const laneBusy = (lane: Lane, shells = true): boolean =>
	(Boolean(lane.proc) && (lane.status === "working" || lane.status === "starting" || runningOmoWorkers(lane.sessionFile) > 0 || (shells && waitsOnShell(lane)))) ||
	runningSubagents(`lane:${lane.name}`) > 0;

// What an idle stop would end with the lane, and since when nothing was heard of it: its silent workers and the shell it waits on.
export const laneJobs = (lane: Lane): { what: string; since: number }[] => [
	...quietOmoWork(lane.sessionFile).map(w => ({ what: w.description, since: w.ended_at ?? w.started_at })),
	...(waitsOnShell(lane) ? [{ what: msg().laneShellJob, since: lane.lastFrameAt ?? Date.now() }] : []),
];

// Memory: stops an idle lane's process (~1 GB with its claude child) and keeps the lane idle on the same session file; the
// next message resumes it there (sendToLane), and if it has work left the resume sweep does (laneresume.ts). Never a lane that holds a
// worker or a shell it waits on, silent or not, whoever asks: the stop would end them with no word to anyone.
export function parkLane(lane: Lane): boolean {
	if (!lane.proc || lane.status !== "idle" || laneBusy(lane) || laneJobs(lane).length || lane.revive || !lane.sessionFile) return false;
	lane.quiet = true;
	lane.parked = true;
	lane.resumeDue = unfinishedWork(lane) ? { state: "due" } : undefined;
	persist(lane);
	markPark(lane.proc.pid); // a routine stop: what the lane left running for the owner stays (hub/agent-tree.ts)
	lane.proc.kill();
	return true;
}

export function shutdownLanes(): void {
	for (const lane of lanes.values()) {
		if (!lane.proc) continue;
		// An idle lane whose workers or shells are cut off here (only the owner's restart now does that) is saved as working, so restoreLanes resumes it with the note that
		// its workers stopped instead of respawning it idle.
		if (lane.status === "idle" && laneBusy(lane)) {
			lane.status = "working";
			persist(lane);
		}
		lane.quiet = true;
		lane.proc.kill();
	}
}

// The lanes' fallback chain in config changed (hub/control.ts setFallback), as the orchestrator's (orchestrator.ts
// applyChainChange): an OmO lane on its primary takes the new chain in place, a lane paused on a limit restarts now (held
// messages go in with the resume note), and a lane on a fallback entry restarts on its session at its next idle moment.
export function applyChainChange(): void {
	for (const lane of lanes.values()) {
		if (!lane.proc) continue;
		if (lane.status === "rate-limited") {
			if (!lane.pausing) void restartPaused(lane).catch(e => log(`lane ${lane.name} restart for the new fallback chain failed: ${(e as Error).message}`));
		} else if (lane.runtime === "omo" && (!lane.chain || lane.chain.active === 0)) {
			const driven = hubChain("omo", chainAfter(lane.model, fallbackChain("lanes")));
			lane.chain = driven ? new Chain(lane.model, driven, parseSelector(lane.model).thinking) : undefined;
			lane.capped = undefined;
		} else lane.accountStale = true;
	}
	restartStaleLanes();
}
// The lanes waiting out the subscription's usage limit, whose pause the usage check (hub/limit-lift.ts) may end early.
export const limitPausedLanes = (): Lane[] => [...lanes.values()].filter(l => l.proc && l.status === "rate-limited" && l.limitPause);
export const limitPausedModels = (): string[] => limitPausedLanes().map(l => l.activeModel || l.model);
export function liftLanePauses(): number {
	const paused = limitPausedLanes();
	for (const lane of paused) {
		log(`lane ${lane.name} usage limit is over; resuming now`);
		void restartPaused(lane).catch(e => log(`lane ${lane.name} restart after the limit lifted failed: ${(e as Error).message}`));
	}
	return paused.length;
}
async function restartPaused(lane: Lane): Promise<void> {
	lane.limitPause = false;
	clearTimeout(lane.resumeTimer);
	lane.resumeTimer = undefined;
	const old = lane.proc!;
	lane.quiet = true;
	old.kill();
	await old.exited;
	setStatus(lane, "idle");
	resumeLane(lane, msg().laneRate);
}
export function restartStaleLanes(): void {
	for (const lane of lanes.values()) {
		if (!lane.accountStale || !lane.proc || lane.status !== "idle" || laneBusy(lane) || lane.revive) continue;
		lane.accountStale = false;
		void restartLane(lane.name).catch(e => log(`lane ${lane.name} account restart failed: ${(e as Error).message}`));
	}
}
