// The doctor's install-health checks (part A): each reads files only, gets now / dataDir / home injected, never sends and never calls a model.
// The doctor (hub/doctor.ts) runs them once a night and decides what reaches the owner.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { THRESHOLDS as T } from "./doctor-limits.ts";
import { type DoctorCheck, evidenceLines, type Finding, wrapLines } from "./doctor-types.ts";
import { type Baseline, baselineOf, failureReport, grownClasses, isBaseline, type Report } from "./failure-report.ts";
import { msg } from "./i18n.ts";
import { pluginFailuresFile } from "./plugins.ts";
import { type AuditResult, runAudit } from "./token-audit.ts";
import { HARNESS_FAILED_MID, HARNESS_RESTART_TAIL } from "./worklog-kind.ts";

const HOUR = 3600e3, DAY = 24 * HOUR, GB = 1024 ** 3;
const LOGIN_KINDS = /^(?:login|session|auth|expired)$/;
const SHOWN_NAMES = 3;

function readRange(file: string, from: number, to: number): string {
	const len = Math.max(0, to - from);
	if (!len) return "";
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, from);
		return buf.toString("utf8");
	} catch {
		return ""; // a file that vanished between the size and the read is an empty log
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const tailText = (file: string, bytes: number): string => {
	try {
		const size = statSync(file).size;
		return readRange(file, Math.max(0, size - bytes), size);
	} catch {
		return ""; // no file yet is an empty log
	}
};

type Row = { at: number; text: string };
function logRows(dataDir: string): Row[] {
	const rows: Row[] = [];
	for (const line of tailText(join(dataDir, "hub.log"), T.logTailBytes).split("\n")) {
		const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
		if (m) rows.push({ at: Date.parse(m[1]!), text: m[2]! });
	}
	return rows;
}

function jsonAt<V>(file: string): V | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as V;
	} catch {
		return undefined; // missing or half-written: nothing to look at
	}
}

// A stack trace is a line followed by indented `at ...` frames; one trace counts once however many frames it has.
export function countTraces(text: string): number {
	const lines = text.split("\n");
	let n = 0;
	for (let i = 1; i < lines.length; i++) if (/^\s+at\s/.test(lines[i]!) && !/^\s+at\s/.test(lines[i - 1]!)) n++;
	return n;
}

const found = (key: string, area: Finding["area"], now: number, what: string, evidence: string[], level: number, todo?: string): Finding => ({ key, area, what, ...(todo ? { todo } : {}), evidence: evidenceLines(evidence, msg().doctor.more), since: now, level });
const asking = (f: Finding): Finding => ({ ...f, ask: true });
const names = (list: string[]): string => list.slice(0, SHOWN_NAMES).join(", ") + (list.length > SHOWN_NAMES ? ` +${list.length - SHOWN_NAMES}` : "");

const UPDATE_INSTALLS_AT_RESTART = /^(?:self-update #\d+: updated: |harness update(?:: gateway restart| \S+ #\d+: updated: ))/;
const OWNER_RESTART = /^gateway restart requested by owner\b/;
const ORCHESTRATOR_RESTART = /^orchestrator restart: web restart \(/;
const EXPLAINED_BY: [RegExp, RestartReason][] = [[UPDATE_INSTALLS_AT_RESTART, "update"], [OWNER_RESTART, "owner"], [ORCHESTRATOR_RESTART, "orchestrator"]];
const RESTART_CAUSES = [/^deferred gateway restart goes now \((.+)\)$/, /^(omo engine changed on disk \([^)]*\))/];
const RESTART = /^gateway restart \((.+)\)$/;
const RESTARTED_ELSEWHERE = /^(gateway restart now \(|hub listening on )/;
const PLANNED_STOP = /^gateway restart(?: now)? \(/;
const STARTED = /^hub listening on /;
const WAIT_BEGINS = /^gateway restart requested(?: by \S+)?(?:; waiting for: ([^;]+))?(?:; coalescing for \d+s)?$/;
const REQUEST_SLACK_MS = 60e3;

/** What explains a gateway restart: an update it installs, the owner who asked for it, or the owner's restart of the orchestrator it went with. */
export type RestartReason = "update" | "owner" | "orchestrator";
/**
 * Every gateway restart in the log rows, oldest first. `by`: a self-update or a harness update was installed, the owner asked for this restart in settings
 * (`gateway restart requested by owner`), or the owner restarted the orchestrator on the web while this restart waited for it: its request line names
 * `orchestrator` in `waiting for:` and his web restart comes after that line. An install or the owner's request counts from a minute before the request its
 * `waited Ns` gives to the restart; an install wins over the owner, the owner's request over his orchestrator restart. The owner's 지금 재시작 and a gateway
 * start line end those marks, since that restart already took the install. `why` is the log's own text in its parentheses; `cause` the last log line in the
 * same wait that says why it went (a deferred restart going now, an engine change on disk), when there is one.
 */
export function restartsOf(rows: { at: number; text: string }[]): { at: number; why: string; explained: boolean; by?: RestartReason; cause?: string }[] {
	const out: { at: number; why: string; explained: boolean; by?: RestartReason; cause?: string }[] = [];
	const marks: { at: number; by: RestartReason }[] = [], causes: { at: number; text: string }[] = [];
	let wait: { at: number; orchestrator: boolean } | undefined;
	for (const r of rows) {
		const m = RESTART.exec(r.text);
		if (!m) {
			const by = EXPLAINED_BY.find(([re]) => re.test(r.text))?.[1], begins = WAIT_BEGINS.exec(r.text);
			if (begins) wait = { at: r.at, orchestrator: (begins[1] ?? "").split(", ").includes("orchestrator") };
			if (RESTARTED_ELSEWHERE.test(r.text)) {
				marks.length = causes.length = 0;
				wait = undefined;
			} else if (by) marks.push({ at: r.at, by });
			const cause = RESTART_CAUSES.map(re => re.exec(r.text)?.[1]).find(Boolean);
			if (cause) causes.push({ at: r.at, text: cause });
			continue;
		}
		const start = r.at - Number(/waited (\d+)s/.exec(m[1]!)?.[1] ?? 0) * 1000 - REQUEST_SLACK_MS;
		const waitedFor = wait?.orchestrator && wait.at >= start ? wait.at : Infinity;
		const seen = marks.filter(k => (k.by === "orchestrator" ? k.at >= waitedFor : k.at >= start));
		const by = EXPLAINED_BY.map(([, k]) => k).find(k => seen.some(s => s.by === k)), cause = causes.filter(c => c.at >= start).at(-1)?.text;
		out.push({ at: r.at, why: m[1]!, explained: by !== undefined, ...(by ? { by } : {}), ...(cause ? { cause } : {}) });
		marks.length = causes.length = 0;
		wait = undefined;
	}
	return out;
}

/** When the gateway started again after `from` with no planned stop before it (`gateway restart (` or `gateway restart now (`): a crash, a kill or a reboot. */
export function unplannedStarts(rows: { at: number; text: string }[], from: number): number[] {
	const out: number[] = [];
	let planned = false;
	for (const r of rows) {
		if (PLANNED_STOP.test(r.text)) planned = true;
		else if (STARTED.test(r.text)) {
			if (!planned && r.at > from) out.push(r.at);
			planned = false;
		}
	}
	return out;
}

type ErrMark = { last: number; from: number };
const isErrMark = (v: unknown): v is ErrMark => typeof (v as ErrMark | undefined)?.last === "number" && typeof (v as ErrMark).from === "number";

export const gateway: DoctorCheck = ({ now, dataDir, memo, last }) => {
	const t = msg().doctor, out: Finding[] = [], rows = logRows(dataDir);
	const day = restartsOf(rows).filter(r => r.at >= now - T.restartWindowH * HOUR), restarts = day.filter(r => !r.explained);
	if (restarts.length >= T.restarts) {
		const count = { all: day.length, update: day.filter(r => r.by === "update").length, owner: day.filter(r => r.by === "owner").length, orchestrator: day.filter(r => r.by === "orchestrator").length, unexplained: restarts.length };
		out.push(asking(found("gateway:restarts", "gateway", now, t.restarts(count), restarts.map(r => t.restartLine(t.when(r.at), r.cause ?? t.restartUnasked)), restarts.length)));
	}
	const errFile = join(dataDir, "gateway.err.log");
	const size = existsSync(errFile) ? statSync(errFile).size : 0;
	const window = last ?? 0, mark = isErrMark(memo?.errMark) ? memo.errMark : undefined;
	const seen = mark?.last === window ? mark.from : typeof memo?.errBytes === "number" ? memo.errBytes : undefined;
	if (memo) {
		memo.errBytes = size;
		if (seen !== undefined) memo.errMark = { last: window, from: seen };
	}
	if (seen !== undefined) {
		const crashes = countTraces(readRange(errFile, size < seen ? 0 : Math.max(seen, size - T.logTailBytes), size));
		if (crashes >= T.crashes) {
			const starts = unplannedStarts(rows, last ?? now - DAY).map(at => t.when(at));
			const shown = starts.length > SHOWN_NAMES ? [...starts.slice(0, SHOWN_NAMES), t.more(starts.length - SHOWN_NAMES)] : starts;
			out.push(asking(found("gateway:crashes", "gateway", now, t.crashes(crashes, shown), starts.length ? starts.map(t.crashAt) : ["gateway.err.log"], crashes)));
		}
	}
	return out;
};

type LaneFile = { name?: string; title?: string; status?: string; startedAt?: string; lastReportAt?: string; sessionFile?: string; parked?: boolean; ownerStopped?: boolean; died?: { at?: string }; interrupted?: { resumed?: boolean }; claim?: { state?: string } };
const mtime = (file: string | undefined): number => {
	try {
		return file ? statSync(file).mtimeMs : 0;
	} catch {
		return 0; // a session file that is gone shows no progress
	}
};

export const sessions: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor, root = join(dataDir, "lanes"), stuck: string[] = [], broken: string[] = [];
	for (const dir of existsSync(root) ? readdirSync(root) : []) {
		const file = join(root, dir, "lane.json"), lane = jsonAt<LaneFile>(file);
		if (!lane) continue;
		const name = lane.title?.trim() || lane.name || dir;
		if (lane.status === "working" || lane.status === "starting") {
			if (lane.parked) continue;
			const progress = Math.max(mtime(file), mtime(lane.sessionFile), Date.parse(lane.lastReportAt ?? "") || 0, Date.parse(lane.startedAt ?? "") || 0);
			if (now - progress > T.laneIdleH * HOUR) stuck.push(name);
		} else if (lane.died && !lane.ownerStopped && lane.claim?.state !== "verified" && !lane.interrupted?.resumed) {
			const age = now - (Date.parse(lane.died.at ?? "") || now);
			if (age > T.laneErrorH * HOUR && age < T.laneErrorMaxDays * DAY) broken.push(name);
		}
	}
	const out: Finding[] = [];
	if (stuck.length) out.push(found("sessions:stuck", "sessions", now, t.sessionsStuck(names(stuck), stuck.length, T.laneIdleH), [names(stuck)], stuck.length, t.todo.sessions));
	if (broken.length) out.push(found("sessions:error", "sessions", now, t.sessionsError(names(broken), broken.length, T.laneErrorH), [names(broken)], broken.length, t.todo.sessions));
	return out;
};

type WatchFile = { id: string; name: string; label?: string; session?: unknown; paused?: boolean; state?: { fails?: number; failSince?: number; kind?: string; paused?: string } };
const watchesOf = (dataDir: string): WatchFile[] => {
	const j = jsonAt<unknown>(join(dataDir, "watches.json"));
	return Array.isArray(j) ? (j as WatchFile[]) : [];
};
const failingFor = (w: WatchFile, now: number): number => (w.state?.failSince && (w.state.fails ?? 0) > 0 ? now - w.state.failSince : 0);

export const logins: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor, out: Finding[] = [];
	for (const w of watchesOf(dataDir)) {
		if (!w.session || !LOGIN_KINDS.test(w.state?.kind ?? "")) continue;
		const lost = failingFor(w, now);
		if (lost > T.loginLostH * HOUR) out.push(found(`logins:${w.id}`, "logins", now, t.loginLost(w.label ?? w.name, Math.floor(lost / HOUR)), [w.name], Math.floor(lost / HOUR), t.todo.login));
	}
	return out;
};

const lastLine = (text: string): string => text.split("\n").map(l => l.trim()).filter(Boolean).at(-1) ?? "";
const clip = (text: string): string => wrapLines(text, 1)[0] ?? "";
const WATCH_FAILED = /^watch (.+) failed \(([^,()]+), /;
const WATCH_UNWRITTEN = /^watch (.+) could not write last-fail\.log: /;

export const watches: DoctorCheck = ({ now, dataDir, last }) => {
	const t = msg().doctor, out: Finding[] = [], all = watchesOf(dataDir), rows = logRows(dataDir), exitCodes = new Map<string, string>(), unwritten = new Set<string>();
	for (const r of rows) {
		const m = WATCH_FAILED.exec(r.text), stale = WATCH_UNWRITTEN.exec(r.text);
		if (m) {
			exitCodes.set(m[1]!, m[2]!);
			unwritten.delete(m[1]!);
		} else if (stale) unwritten.add(stale[1]!);
	}
	for (const w of all) {
		const fails = w.state?.fails ?? 0, failing = failingFor(w, now);
		if (w.paused || w.state?.paused || LOGIN_KINDS.test(w.state?.kind ?? "")) continue;
		if (fails < T.watchFails && failing <= T.watchFailH * HOUR) continue;
		const failSince = failing ? w.state?.failSince : undefined, since = failSince ? t.when(failSince) : "";
		const failLog = join(dataDir, "watches", w.id, "last-fail.log"), output = lastLine(tailText(failLog, 4096)), code = exitCodes.get(w.name);
		const lastRun = unwritten.has(w.name) ? (code === undefined ? "" : t.exitCode(code)) : output ? t.lastReason(output) : code === undefined ? "" : existsSync(failLog) ? t.noOutput(code) : t.exitCode(code);
		const evidence = [...(since ? [t.firstFailed(since)] : []), t.failedInRow(fails), ...(lastRun ? wrapLines(lastRun, 2) : [])];
		out.push(asking(found(`watches:${w.name}`, "watches", now, t.watchFailing(w.label ?? w.name, fails, since, clip(lastRun)), evidence, fails)));
	}
	const fixed = new Set<string>();
	for (const r of rows) {
		const m = /^watch (.+) self-heal: the check passes again$/.exec(r.text);
		if (m && r.at >= (last ?? now - DAY)) fixed.add(m[1]!);
	}
	for (const name of fixed) out.push({ ...found(`watches:fixed:${name}`, "watches", now, t.watchFixed(all.find(w => w.name === name)?.label ?? name), [name], 1), fixed: true });
	return out;
};

export const disk: DoctorCheck = ({ now, dataDir }) => {
	let free: number, total: number;
	try {
		const s = statfsSync(dataDir);
		free = Number(s.bavail) * Number(s.bsize);
		total = Number(s.blocks) * Number(s.bsize);
	} catch {
		return []; // a volume that cannot be read cannot be judged
	}
	if (!total) return [];
	const pct = (free / total) * 100;
	if (pct >= T.diskFreePct && free >= T.diskFreeGb * GB) return [];
	const t = msg().doctor, critical = free < T.diskDecideGb * GB;
	const f = found("disk:low", "disk", now, t.disk(Math.round((free / GB) * 10) / 10, Math.round(pct)), [t.diskLeft((free / GB).toFixed(1), (total / GB).toFixed(0))], critical ? 2 : 1, t.todo.disk);
	if (critical) f.decide = { subject: t.diskSubject, question: t.diskQuestion, options: [{ name: t.diskCleanName, result: t.diskCleanResult }, { name: t.diskKeepName, result: t.diskKeepResult }] };
	return [f];
};

// The newest update line per updater decides: a failure with no success after it is "still failed".
const UPDATER_NAMES: Record<string, string> = { omo: "OmO", omp: "omp" };
type Failing = { first: number; n: number; error: string };
export const update: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor, state = new Map<string, Failing | undefined>();
	const mark = (id: string, at: number, error: string | undefined) => {
		const was = state.get(id);
		state.set(id, error === undefined ? undefined : { first: was?.first ?? at, n: (was?.n ?? 0) + 1, error });
	};
	for (const { at, text } of logRows(dataDir)) {
		const self = /^self-update #\d+: (\w+): ?(.*)$/.exec(text);
		if (self && ["failed", "updated", "current"].includes(self[1]!)) mark("self", at, self[1] === "failed" ? self[2]! : undefined);
		const m = /^(\S+) update(?: failed)?: (.*)$/.exec(text), failed = text.includes(" update failed: ") || text.includes(HARNESS_FAILED_MID);
		if (m && (failed || text.includes(HARNESS_RESTART_TAIL))) mark(m[1]!, at, failed ? m[2]! : undefined);
	}
	return [...state].flatMap(([id, f]) => {
		if (!f) return [];
		const what = id === "self" ? t.selfUpdate : (UPDATER_NAMES[id] ?? id), since = t.when(f.first), error = f.error.trim();
		const evidence = [t.firstFailed(since), t.failedTimes(f.n), ...(error ? wrapLines(t.lastError(error), 2) : [])];
		return [asking(found(`update:${id}`, "update", now, t.updateFailed(what, f.n, since, clip(error)), evidence, f.n))];
	});
};

/** The findings of the failure classes that grew against `base`: the told text carries each class's counts and tokens before → after and its share last. */
export function failureFindings(now: number, r: Pick<Report, "tokens" | "turns" | "lost">, base: Baseline | undefined): Finding[] {
	const t = msg().doctor;
	return grownClasses(r, base, T.failures).map(g => {
		const short = t.failureShort(g.label, t.failureGrowth(g));
		const evidence = [short, t.failureBase(T.failureDays, g.byTokens ? r.tokens : r.turns, g.byTokens), ...(g.top ? [t.failureTools(g.top)] : [])];
		return { ...asking(found(`failures:${g.name}`, "failures", now, t.failuresGrew([short]), evidence, Math.round(g.weight))), short };
	});
}

export const failures: DoctorCheck = ({ now, dataDir, home, memo }) => {
	const r = failureReport({ home, dataDir, days: T.failureDays, now }), base = isBaseline(memo?.failBase) ? memo.failBase : undefined;
	if (memo) memo.failBase = baselineOf(r);
	return failureFindings(now, r, base);
};

/**
 * One finding per token warning kind that matters, keyed `tokens:<kind>` with that kind's cost as its level, so each kind is told again on its own. Each line
 * leads with yesterday's total and cost, the usual day and the three largest sessions, then names its kind with its cost; the morning joins the told kinds
 * under one lead (`tokens` of the catalog).
 */
export function tokenFindings(now: number, a: Pick<AuditResult, "told" | "tokens" | "cost" | "top" | "usual" | "ownerUse">): Finding[] {
	const t = msg().doctor, byKind = new Map<string, { n: number; cost: number }>();
	for (const f of a.told) {
		const k = byKind.get(f.kind) ?? { n: 0, cost: 0 };
		byKind.set(f.kind, { n: k.n + 1, cost: k.cost + (f.cost ?? 0) });
	}
	const day = { tokens: a.tokens, cost: a.cost, top: a.top, ...(a.usual ? { usual: a.usual } : {}) };
	const chose = a.ownerUse.sessions ? [t.ownerExpensive(a.ownerUse.sessions, t.dollars(a.ownerUse.cost))] : [];
	return [...byKind].map(([kind, k]) => {
		const short = t.tokenShort(kind, k.n, k.cost);
		return asking(found(`tokens:${kind}`, "tokens", now, t.tokenDay(day, [short]), [short, ...chose], Math.round(k.cost * 100) / 100 || k.n));
	});
}

export const tokens: DoctorCheck = ({ now, dry }) => tokenFindings(now, runAudit({ hours: T.tokensH, dry: !!dry, readOnly: !!dry }));

// A custom plugin whose import or default export failed in the last load (hub/plugins.ts writes the file); the error's first line is the evidence.
export const plugins: DoctorCheck = ({ now, dataDir }) => {
	const t = msg().doctor;
	return Object.entries(jsonAt<Record<string, string>>(pluginFailuresFile(dataDir)) ?? {}).map(([file, error]) => {
		const line = String(error).split("\n")[0]!.trim();
		return asking(found(`plugins:${file}`, "plugins", now, t.pluginNotLoaded(file), [line], 1));
	});
};

/** The checks that read only small files (a log tail, a state file, statfs): cheap enough to run again right before the morning message. */
export const FILE_CHECKS: DoctorCheck[] = [gateway, sessions, logins, watches, disk, update, plugins];
export const CHECKS: DoctorCheck[] = [...FILE_CHECKS, failures, tokens];
