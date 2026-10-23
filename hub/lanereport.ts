import { type Lane, pendingFile, ownerNotes, persist, dir, hooks, setStatus } from "./lanestate.ts";
import { rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { now, writeAtomic, log } from "./config.ts";
import { parseTone } from "./tone.ts";
import { pendingAskFile } from "./asks.ts";
import { join } from "node:path";
import { workerCheck } from "./activity.ts";
import { msg } from "./i18n.ts";

export const REPORT_DEBOUNCE_MS = Number(process.env.DOTZ_REPORT_DEBOUNCE_MS ?? 0);

// `notice` marks a gateway-written text ([lane error], [lane exited], pause/rate-limit): it is not the lane speaking, so it
// leaves a pending ask alone.
export function report(lane: Lane, text: string, notice = false): void {
	rmSync(pendingFile(lane), { force: true });
	lane.unreported = false;
	// The turn's final text answers every owner message still open (a gateway notice does not).
	const answering = !notice && ownerNotes.reported(lane.name);
	lane.reports++;
	lane.lastReportAt = now();
	const tone = parseTone(text).tone;
	// A report without a marker (a gateway notice, or the OmO handoff block "Ask: ... wanted: ..." that an OmO lane posts
	// as a separate turn right after its [done], custom-ui 2026-10-20) leaves the claim as it was; [run]/[ask]/[fail] withdraw it.
	// A report that opens with that block and says [done] further down is a done claim (account-switch and layers-redesign
	// 2026-10-21: their [done] could not be verified).
	const claimsDone = tone === "done" || (!tone && /\[(done|완료)\]/i.test(text));
	lane.claim = claimsDone ? { state: "reported", at: now() } : tone ? undefined : lane.claim;
	if (tone === "ask" && !notice) {
		lane.pendingAsk = { text, at: now() };
		writeAtomic(pendingAskFile(lane.name), `${text}\n`);
	} else if (!notice) clearAsk(lane);
	persist(lane);
	writeFileSync(join(dir(lane.name), "report.md"), `${text}\n`);
	// A [done] is checked against the task metadata before it is relayed; what contradicts it goes along with it. So is a
	// report without a leading marker that says [done] further down (an OmO lane can open with its handoff block, "Ask: ...").
	if (notice || !claimsDone) return hooks.report(lane, text, answering);
	const what = tone === "done" ? "[done]" : "report";
	const claim = lane.claim;
	void workerCheck(`lane:${lane.name}`, lane.workingSince ?? 0, lane.sessionFile)
		.catch(e => [`task metadata unreadable: ${e}`])
		.then(problems => {
			if (!problems.length) return hooks.report(lane, text, answering);
			if (lane.claim === claim && claim) {
				claim.problems = problems.slice(0, 10);
				persist(lane);
			}
			log(`lane ${lane.name} ${what} contradicted by task metadata: ${problems.join("; ")}`);
			hooks.report(lane, `${text}\n\n[gateway check] task metadata contradicts this ${what}; do not take it as verified:\n- ${problems.slice(0, 10).join("\n- ")}`, answering);
		});
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
