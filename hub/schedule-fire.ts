import { log, now, TZ } from "./config.ts";
import type { HubEvent } from "./events.ts";
import { msg } from "./i18n.ts";
import { items, putDecision, upsert } from "./notices-store.ts";
import { RUN_DECISION, runKey } from "./notices-schedule.ts";
import { REPLAY_MAX_AGE_MS, type Reply, type RunLabel, type RunOutcome } from "./prompts-model.ts";
import { listScheduleRuns, markScheduleRun, runNow, type Schedule, type ScheduleNaming, type ScheduleRun, scheduleKind, scheduleTarget } from "./schedule.ts";

/** What a fire needs from the running gateway: the inbox event out, the prompt in, and the default channel ("chat" with Discord, else "web"). */
export type FireDeps = { emit: (box: "inbox", e: HubEvent) => void; deliver: (text: string, reply: Reply) => unknown; inboxText: (e: HubEvent) => string; fallback: () => string };
/** How long a run held by a usage limit may stay without a result after the limit lifted before it is a failure the owner decides on. */
export const FAIL_AFTER_MS = 30 * 60_000;
/** How often the held and lifted runs are looked at. */
export const RUN_SWEEP_MS = 60_000;

const runOf = (run: string): ScheduleRun | undefined => listScheduleRuns().findLast(r => r.run === run);

/** One fire: the inbox event (`run`, `name`, `sk`; a check group keeps `ids` and `runs`) and the prompt, labelled with its runs so the answer knows them. */
export function fireSchedule(s: Schedule, group: Schedule[] | undefined, runs: string[], d: FireDeps): void {
	const channel = scheduleTarget(s, d.fallback());
	const sk = scheduleKind(s);
	const name = s.name ?? runOf(runs[0] ?? "")?.name;
	const run: RunLabel = { ids: runs, sk };
	if (sk === "check") {
		const all = group ?? [s];
		const text = all.length > 1 ? all.map((x, i) => `${i + 1}) [${x.id}] ${x.text}`).join("\n") : s.text;
		const event = { ts: now(), kind: "schedule", source: "gateway", channel, id: all.map(x => x.id).join(","), ids: all.map(x => x.id), runs, name, sk, quiet: true, text };
		d.emit("inbox", event);
		return void d.deliver(d.inboxText(event), { target: channel, quiet: true, run });
	}
	const event = { ts: now(), kind: "schedule", source: "schedule", channel, id: s.id, run: runs[0], name, sk, every: s.every_minutes, text: s.text };
	d.emit("inbox", event);
	d.deliver(d.inboxText(event), { target: channel, run });
}

/** The one-time naming's wake (a quiet gateway turn) and its owner line, posted in the main conversation where he reads it. */
export const namingDeps = (d: { wake: (id: string, text: string, quiet: true) => void; out: (target: string, text: string, replyTo: undefined, extra: Record<string, unknown>) => Promise<unknown>; fallback: () => string }): ScheduleNaming => ({
	wake: text => d.wake("schedule-naming", text, true),
	post: line => void d.out(d.fallback(), line, undefined, { source: "gateway", nk: "gateway-note" }).catch(e => log(`schedule naming notice failed: ${e}`)),
});

const rowOf = (run: string) => items.find(n => n.key === runKey(run));
const stillWaiting = (r: ScheduleRun, text: string) => text === msg().scheduleRun.running || text === msg().scheduleRun.held(r.name);

/** Did the runs of `label` get their own outcome (posted or nothing to tell)? A restart replays a run prompt only while they did not. */
export const runSettled = (label: RunLabel): boolean => label.ids.every(id => ["answered", "silent"].includes(runOf(id)?.state ?? ""));

/** What became of a run's turn (hub/prompts.ts): the run record's state, and a task run's row when no posted answer rewrote it. `seen`: the answer
 *  went out as the owner's own exchange (he wrote into the run's turn), so the row is born read and pushes nothing of its own. */
export function scheduleRan(label: RunLabel, outcome: RunOutcome, seen = false): void {
	const marked = label.ids.flatMap(id => markScheduleRun(id, outcome) ?? []);
	const [r] = marked;
	if (label.sk === "check" || marked.length !== 1 || !r) return;
	if (outcome === "failed") return failRun(r);
	const row = rowOf(r.run);
	if (label.sk !== "task" || (row && !stillWaiting(r, row.text))) return;
	const t = msg().scheduleRun;
	upsert({ kind: "watch", tone: "", title: r.name, text: outcome === "silent" ? t.nothing : t.posted, open: row?.open ?? r.conv ?? "main", key: runKey(r.run), nk: "schedule", at: now(), ...(outcome === "silent" || seen ? { read: true } : { unread: true }) });
}

function heldRun(r: ScheduleRun): void {
	const row = rowOf(r.run);
	if (r.kind === "check" || row?.decision) return;
	upsert({ kind: "watch", tone: "", title: r.name, text: msg().scheduleRun.held(r.name), open: row?.open ?? r.conv ?? "main", key: runKey(r.run), ...(r.kind === "task" ? { nk: "schedule" as const } : {}), at: now() });
}

const RUN_TIME = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function failRun(r: ScheduleRun): void {
	if (r.kind === "check") return;
	const t = msg().scheduleRun;
	const row = rowOf(r.run);
	if (row) delete row.nk;
	const options = [{ n: 1, label: t.rerun, desc: t.rerunResult, action: "rerun" }, { n: 2, label: t.stop, desc: t.stopResult, action: "stop" }];
	putDecision({ key: runKey(r.run), title: t.failed(r.name), detail: r.name, evidence: [t.failedWhen(RUN_TIME.format(Date.parse(r.firedAt)).replace(", ", " "))], to: `${RUN_DECISION}${r.run}`, open: row?.open ?? r.conv ?? "main", options, group: 1 }, now());
}

/** Looks at every run still waiting: one whose session is paused on a usage limit is held; a held one whose limit lifted FAIL_AFTER_MS ago with no result failed.
 *  A fired run older than a restart replays (REPLAY_MAX_AGE_MS) is left alone: its prompt is gone, so no limit holds it. */
export function sweepRuns(limited: (target: string) => boolean, fallback: string): void {
	for (const r of listScheduleRuns()) {
		if (r.state !== "fired" && r.state !== "held") continue;
		if (r.state === "fired" && Date.now() - Date.parse(r.firedAt) >= REPLAY_MAX_AGE_MS) continue;
		if (limited(r.conv ?? fallback)) {
			if (r.state === "fired" || r.liftedAt) heldRun(markScheduleRun(r.run, "held") ?? r);
		} else if (r.state === "held" && !r.liftedAt) markScheduleRun(r.run, "held", new Date(Date.now()).toISOString());
		else if (r.liftedAt && Date.now() - Date.parse(r.liftedAt) >= FAIL_AFTER_MS) failRun(markScheduleRun(r.run, "failed") ?? r);
	}
}

/** Starts the sweep; `limited` says whether the session a target fires into is paused on a usage limit. */
export function startRunWatch(limited: (target: string) => boolean, fallback: () => string): void {
	setInterval(() => sweepRuns(limited, fallback()), RUN_SWEEP_MS);
}

/** The owner's button on a failed run's decision: "rerun" fires its schedule again now as a new run (no model turn for the answer), "stop" leaves it. */
export function answerRunDecision(run: string, action: string | undefined): string | undefined {
	const r = runOf(run);
	if (!r) throw new Error("이 예약 실행 기록을 찾을 수 없어요");
	if (action !== "rerun") return void log(`schedule run ${run} left as failed`);
	return runNow(r.scheduleId);
}
