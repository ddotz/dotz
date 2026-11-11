import { type Lane, pendingFile, ownerNotes, persist, dir, hooks, setStatus } from "./lanestate.ts";
import { rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { now, writeAtomic, log } from "./config.ts";
import { parseTone } from "./tone.ts";
import { pendingAskFile } from "./asks.ts";
import { lastQuestion } from "./ask-options.ts";
import { bareAsk, normalizeAsk } from "./ask-normalize.ts";
import { parseDecisions } from "./choices.ts";
import { join } from "node:path";
import { workerCheck } from "./activity.ts";
import { orchestratorOnlyAsk } from "./forline.ts";
import { msg } from "./i18n.ts";
import { checkDone, doneChecks, type Check } from "./donesignals.ts";
import { unlanded } from "./lanetree.ts";
import { prompt } from "./laneprompt.ts";

// A line that says something stays unchecked ("실기기 미확인") reads as if that closes the job (owner, 2026-11-09). It must say why it cannot be
// checked here and what was checked instead, behind one of these markers; without one the report goes back to the lane once.
const UNVERIFIED = /unverified|not (yet )?(verified|checked|tested)|could ?n[o']t (verify|check|test)|미확인|확인\s?못|확인하지 못|검증\s?못|검증하지 못/i;
export const INSTEAD_CHECKED = /대신 확인\s*:|instead checked\s*:/i;
export function bareUnverified(text: string): string[] {
	return text.split("\n").map(l => l.trim()).filter(l => UNVERIFIED.test(l) && !INSTEAD_CHECKED.test(l));
}

export const REPORT_DEBOUNCE_MS = Number(process.env.DOTZ_REPORT_DEBOUNCE_MS ?? 0);

// An [ask] while the lane's last one is still open (any owner message clears it) that asks nothing new: the same text, or a line with no
// option and no question ("답을 받기 전에는 진행할 수 없어서 멈췄어요", 2026-11-04 spacing-rules, 11 s after the real question). A card of this
// lane still open on the owner's side counts too: "still waiting" asks nothing, whatever its words (2026-11-05 cloudflare-webapp).
function repeatsOpenAsk(lane: Lane, text: string): boolean {
	if (parseTone(text).tone !== "ask") return false;
	if (bareAsk(text) && hooks.openCard(lane.name)) return true;
	if (!lane.pendingAsk) return false;
	return lane.pendingAsk.text === text || (!parseDecisions(text).blocks.length && !lastQuestion(text));
}

// A question the owner has not seen stays the turn's report: a harness continuation inside one turn (senpi.todo-owed, 2026-11-05 cloudflare-webapp)
// made two "still waiting" texts in 5 s, the last text won at turn_end and the [ask] with its two decisions reached nobody. A later untagged text or
// bare [ask] does not replace it; a tagged one does, and the question goes out as a real message first. Returns the text the turn now stands on.
export function nextLastText(lane: Lane, text: string): string {
	const asked = lane.lastText;
	if (!lane.unreported || parseTone(asked).tone !== "ask" || !parseDecisions(normalizeAsk(asked)).blocks.length) return text;
	if (!parseTone(text).tone || bareAsk(normalizeAsk(text))) return asked;
	if (text !== asked) hooks.progress(lane, asked);
	return text;
}

// `notice` marks a gateway-written text ([lane error], [lane exited], pause/rate-limit): it is not the lane speaking, so it
// leaves a pending ask alone. "pause": a usage-limit stop or recovery, which also starts no orchestrator turn (hub/lanerelay.ts).
export function report(lane: Lane, written: string, notice: boolean | "pause" = false): void {
	let text = notice ? written : normalizeAsk(written);
	rmSync(pendingFile(lane), { force: true });
	lane.unreported = false;
	if (lane.reportedThisTurn === text) return log(`lane ${lane.name} report dropped (same text again before a new turn)`);
	lane.reportedThisTurn = text;
	if (!notice && repeatsOpenAsk(lane, text)) return log(`lane ${lane.name} report dropped (restates the question still open)`);
	if (!notice && bareAsk(text)) {
		// Once back to the session for a real choice block; the second time it is a plain note, so the text is never lost and never loops.
		if (lane.proc && !lane.askRefused) {
			lane.askRefused = true;
			lane.bareAsk = true;
			persist(lane);
			log(`lane ${lane.name} [ask] refused (no choice block)`);
			return prompt(lane, msg().askRefused(parseTone(text).text));
		}
		text = parseTone(text).text;
		lane.bareAsk = true;
	} else if (!notice) lane.bareAsk = undefined;
	if (!notice) {
		const unchecked = bareUnverified(text);
		if (unchecked.length && lane.proc && !lane.unverifiedRefused) {
			lane.unverifiedRefused = true;
			persist(lane);
			log(`lane ${lane.name} report refused (unverified without reason: ${unchecked.length} line(s))`);
			return prompt(lane, msg().unverifiedRefused(unchecked));
		}
		lane.unverifiedRefused = undefined;
	}
	// The turn's final text answers every owner message still open (a gateway notice does not).
	const answering = !notice && ownerNotes.reported(lane.name, text);
	lane.reports++;
	lane.lastReportAt = now();
	const tone = parseTone(text).tone;
	// A report without a marker (a gateway notice, or the OmO handoff block "Ask: ... wanted: ..." that an OmO lane posts
	// as a separate turn right after its [done], custom-ui 2026-10-20) leaves the claim as it was; [run]/[ask]/[fail] withdraw it.
	// A report that opens with that block and says [done] further down is a done claim (account-switch and layers-redesign
	// 2026-10-21: their [done] could not be verified).
	const claimsDone = tone === "done" || (!tone && /\[(done|완료)\]/i.test(text));
	lane.claim = claimsDone ? { state: "reported", at: now() } : tone ? undefined : lane.claim;
	// An [ask] that only hands its question to the orchestrator ("<bot> 몫:") waits on no owner answer: no 답변 필요 mark, no pending-ask entry.
	if (tone === "ask" && !notice && !orchestratorOnlyAsk(parseTone(text).text)) {
		lane.askRefused = false;
		lane.pendingAsk = { text, at: now() };
		writeAtomic(pendingAskFile(lane.name), `${text}\n`);
	} else if (!notice) clearAsk(lane);
	persist(lane);
	writeFileSync(join(dir(lane.name), "report.md"), `${text}\n`);
	// A [done] is checked against the task metadata before it is relayed; what contradicts it goes along with it. So is a
	// report without a leading marker that says [done] further down (an OmO lane can open with its handoff block, "Ask: ...").
	if (notice || !claimsDone) return hooks.report(lane, text, answering, notice === "pause");
	const what = tone === "done" ? "[done]" : "report";
	const claim = lane.claim;
	void workerCheck(`lane:${lane.name}`, lane.workingSince ?? 0, lane.sessionFile)
		.catch(e => [`task metadata unreadable: ${e}`])
		.then(problems => {
			if (!problems.length) return gatewayCheck(lane, text, answering);
			if (lane.claim === claim && claim) {
				claim.problems = problems.slice(0, 10);
				persist(lane);
			}
			log(`lane ${lane.name} ${what} contradicted by task metadata: ${problems.join("; ")}`);
			hooks.report(lane, `${text}\n\n${msg().checkContradicted(problems.length)}`, answering);
		});
}
// The gateway reads a machine-checkable Done-when back itself (donesignals.ts, dori done-flow.ts settle) instead of spending
// an orchestrator turn on it: every check passes and the branch is landed -> the claim is verified and the report goes on
// with the results; a failure goes straight back to the lane (DONE_BOUNCES times in a row, then to the orchestrator). A
// plain-text Done-when (owner-asked lanes) is relayed as before and verified by the orchestrator.
export const DONE_BOUNCES = 2;
async function gatewayCheck(lane: Lane, text: string, answering: boolean): Promise<void> {
	const claim = lane.claim;
	const brief = join(dir(lane.name), "brief.md");
	const signals = claim && existsSync(brief) ? doneChecks(readFileSync(brief, "utf8")) : undefined;
	if (!claim || !signals) return hooks.report(lane, text, answering);
	const checks: Check[] = await checkDone(signals, lane.cwd).catch(e => [{ signal: "Done when", ok: false, detail: `check failed: ${e}` }]);
	const open = lane.worktree ? unlanded(lane.worktree) : undefined;
	if (lane.worktree) checks.push({ signal: `landed ${lane.worktree.branch} in ${lane.worktree.base}`, ok: !open, detail: open ?? "merged" });
	// A newer report replaced this claim while the checks ran: that report has its own check.
	if (lane.claim !== claim) return log(`lane ${lane.name} Done-when check dropped (a newer report replaced the claim)`);
	const lines = checks.map(c => `${c.ok ? "ok" : "NOT"} ${c.signal} -> ${c.detail}`);
	const landed = checks.some(c => c.ok && c.signal.startsWith("landed "));
	if (checks.every(c => c.ok)) {
		lane.claim = { state: "verified", at: now(), evidence: `gateway Done-when check: ${lines.join("; ")}`.slice(0, 1000) };
		lane.doneBounces = 0;
		persist(lane);
		log(`lane ${lane.name} [done] verified by the gateway: ${lines.join("; ")}`);
		hooks.report(lane, `${text}\n\n${msg().checkPassed(checks.length, landed)}`, answering);
		return hooks.verified(lane.name, text);
	}
	const failed = lines.filter(l => l.startsWith("NOT"));
	claim.problems = failed.slice(0, 10);
	lane.doneBounces = (lane.doneBounces ?? 0) + 1;
	persist(lane);
	log(`lane ${lane.name} [done] not verified by the gateway (${lane.doneBounces}): ${failed.join("; ")}`);
	if (lane.proc && lane.doneBounces <= DONE_BOUNCES) {
		hooks.notice(lane, msg().checkBounced(checks.length, failed.length));
		lane.claim = undefined;
		persist(lane);
		return prompt(lane, `[gateway check] Your [done] is not verified: these Done-when checks fail now:\n- ${failed.join("\n- ")}\nFix them (land the branch if that is what fails) and report [done] again, or report [fail] / [ask] saying why they cannot pass.`);
	}
	lane.doneBounces = 0;
	hooks.report(lane, `${text}\n\n${msg().checkFailed(checks.length, failed.length)}`, answering);
}

// Drops the pending ask; the caller persists.
export function clearAsk(lane: Lane): void {
	if (!lane.pendingAsk) return;
	lane.pendingAsk = undefined;
	rmSync(pendingAskFile(lane.name), { force: true });
}

// The omp budget gate opens only for a /budget-ok typed into the lane session, but the owner approves in Discord.
// When the lane's last report asked for /budget-ok and the owner answers with a short yes, the command goes in first.
const BUDGET_ASK_RE = /\/budget-ok/;
const APPROVE_RE = /^\s*(ㄱ+|ㄱㄱ|고+|ㅇㅋ|ㅇㅇ|오케이|ok(ay)?|go|yes|1번?|1\s*ㄱ+|진행(해|하자|해줘)?|해|해줘|바로)\s*[.!]*\s*$/i;
export function approvesBudget(name: string, text: string): boolean {
	const file = join(dir(name), "report.md");
	if (!APPROVE_RE.test(text) || !existsSync(file)) return false;
	return BUDGET_ASK_RE.test(readFileSync(file, "utf8"));
}

export function scheduleReport(lane: Lane): void {
	if (lane.status !== "rate-limited") setStatus(lane, "idle");
	// A transient provider error is being retried, or a failed request is still being resolved (a fallback may redo it):
	// the failed turn is not a report.
	if (lane.transientTimer || lane.failing) return;
	if (lane.silent && !lane.lastText.startsWith("[lane error]")) {
		lane.lastText = lane.silent.lastText;
		lane.unreported = false;
		lane.silent = undefined;
		rmSync(pendingFile(lane), { force: true });
		return;
	}
	lane.silent = undefined;
	// A turn that wrote no text of its own (aborted, empty) has nothing new to report.
	if (!lane.unreported) return void rmSync(pendingFile(lane), { force: true });
	if (lane.lastText) writeAtomic(pendingFile(lane), lane.lastText);
	clearTimeout(lane.timer);
	lane.timer = setTimeout(() => {
		if (lane.status !== "idle" || !lane.lastText) return;
		report(lane, lane.lastText, lane.lastText.startsWith("[lane error]"));
	}, REPORT_DEBOUNCE_MS);
}

// The owner messages held during the pause ride along with the resume note and stay on disk until a turn succeeds.
export function withHeld(lane: Lane, text: string): string {
	if (!lane.held?.length) return text;
	return msg().heldMessages(text, lane.held);
}
